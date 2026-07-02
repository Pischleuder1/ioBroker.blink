'use strict';
/**
 * MJPEG-Streaming-Modul for den ioBroker Blink-Adapter.
 *
 * Stellt einen lokalen HTTP-Server bereit, der pro camera einen MJPEG-Stream
 * sowie ein Single-Shot-JPG anbietet. Die Bilder werden aus einem Cache
 * geliefert, der durch sequentielles polling der Blink-Cloud befüllt is.
 *
 * Architektur:
 *  - In-Memory-Cache pro camera ({ buffer, mime, ts }).
 *  - Sequentielles polling im Round-Robin-Verfahren (eine camera nach der
 *    anderen), damit die Cloud nicht vialastet is ("System is busy").
 *  - Wired-Cams werden permanent gepollt.
 *  - Battery-Cams werden nur gepollt, wenn aktuell ein MJPEG-client connected
 *    ist; nach einer konfigurierbaren Idle-Zeit is das polling wieder
 *    stopped to conserve battery power.
 *  - Stream-Endpoints sind per URL-Token geschützt.
 */

const http = require('node:http');
const { URL } = require('node:url');

const MJPEG_BOUNDARY = 'blinkmjpegboundary';
const PLACEHOLDER_RETRY_HEADER = 'X-Blink-Placeholder';

/**
 * Erzeugt ein 1×1-Pixel-Platzhalter-JPG for den Fall, dass noch kein echtes
 * Bild im Cache liegt. Browser bekommen so einen gültigen Frame statt einer
 * leeren Antwort.
 *
 * @returns {Buffer} Buffer mit dem 1×1-Grau-Pixel als gültiges JPEG.
 */
function placeholderJpeg() {
	// 1x1 grey pixel JPEG (smallest valid JPEG payload).
	return Buffer.from(
		'/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z',
		'base64',
	);
}

/**
 * Verwaltet einen lokalen HTTP-Server for MJPEG-Streams sowie das zugehörige
 * Snapshot-polling.
 */
class MjpegServer {
	/**
	 * @param {object} opts - Konfigurations-Optionen for den MJPEG-Server.
	 * @param {object} opts.adapter - ioBroker-Adapter-Instanz (for Logging).
	 * @param {number} opts.port - HTTP-Port.
	 * @param {string} opts.token - URL-Token for Endpoint-Schutz.
	 * @param {string} [opts.publicHost] - Hostname/IP for die Stream-URL (Default: 'localhost').
	 * @param {number} opts.wiredIntervalSec - Mindestpause pro Wired-Cam-Poll.
	 * @param {number} opts.batteryIntervalSec - Mindestpause pro Battery-Cam-Poll.
	 * @param {number} opts.batteryIdleTimeoutSec - Battery-polling stoppt nach Idle.
	 * @param {number} opts.batteryMinLevel - 0..3, unter diesem Wert kein polling.
	 * @param {() => Promise<Buffer>} opts.snapshotFn - Liefert ein frisches JPG for eine camera (siehe registerCamera).
	 */
	constructor(opts) {
		this.adapter = opts.adapter;
		this.port = opts.port;
		this.token = opts.token;
		this.publicHost = opts.publicHost || 'localhost';
		this.wiredIntervalMs = Math.max(5, opts.wiredIntervalSec || 8) * 1000;
		this.batteryIntervalMs = Math.max(8, opts.batteryIntervalSec || 10) * 1000;
		this.batteryIdleTimeoutMs = Math.max(15, opts.batteryIdleTimeoutSec || 60) * 1000;
		this.batteryMinLevel = Number.isFinite(opts.batteryMinLevel) ? opts.batteryMinLevel : 2;

		// Map<string, {meta, cache: {buffer, mime, ts}, clients: Set, lastClientTs, lastPollTs, busyUntil, manualWakeUntil}>
		this.cameras = new Map();

		this.server = null;
		this.pollLoopTimer = null;
		this.stopRequested = false;
	}

	/**
	 * Registriert eine camera am Server.
	 *
	 * @param {string} devId - Sanitisierte ioBroker-camera-ID.
	 * @param {object} meta - Geräte-Metadaten.
	 * @param {string} meta.name - Anzeigename der camera.
	 * @param {string} meta.apiType - 'camera' | 'doorbell' | 'owl' | 'mini'
	 * @param {boolean} meta.wired - true = wired/powered, false = battery-powered.
	 * @param {number|null} meta.batteryLevel - 0..3 oder null falls unbekannt.
	 * @param {() => Promise<Buffer>} fetchSnapshot - Liefert ein frisches JPG (Buffer).
	 */
	registerCamera(devId, meta, fetchSnapshot) {
		const existing = this.cameras.get(devId);
		const entry = existing || {
			meta,
			cache: null,
			clients: new Set(),
			lastClientTs: 0,
			lastPollTs: 0,
			busyUntil: 0,
			manualWakeUntil: 0,
			fetchSnapshot,
		};
		entry.meta = { ...meta };
		entry.fetchSnapshot = fetchSnapshot;
		this.cameras.set(devId, entry);
	}

	/**
	 * Aktualisiert den Cache einer camera (z.B. wenn ein anderes Code-Pfad
	 * – etwa der bestehende Live-Snapshot – ohnehin schon ein neues Bild
	 * geholt hat). So vermeiden wir doppelte Cloud-Anfragen.
	 *
	 * @param {string} devId - Sanitisierte camera-ID.
	 * @param {Buffer} buffer - JPG-Bilddaten.
	 * @param {string} [mime] - MIME-Type des Bildes (Default 'image/jpeg').
	 */
	pushSnapshot(devId, buffer, mime = 'image/jpeg') {
		const entry = this.cameras.get(devId);
		if (!entry || !Buffer.isBuffer(buffer) || buffer.length === 0) {
			return;
		}
		entry.cache = { buffer, mime, ts: Date.now() };
		this._broadcastFrame(entry);
	}

	/**
	 * Marks a battery-powered camera as manually activated. Polling continues
	 * for `batteryIdleTimeoutMs` milliseconds, even without a connected
	 * Client. Wird typischerweise per Button-State im Adapter ausgelöst.
	 *
	 * @param {string} devId - Sanitisierte camera-ID, deren polling kurzzeitig aktiviert werden soll.
	 */
	manualWake(devId) {
		const entry = this.cameras.get(devId);
		if (!entry) {
			return;
		}
		entry.manualWakeUntil = Date.now() + this.batteryIdleTimeoutMs;
		this.adapter.log.info(
			`MJPEG: manual activation for ${entry.meta.name} (${Math.round(this.batteryIdleTimeoutMs / 1000)}s)`,
		);
	}

	/**
	 * Liefert die fertige Stream-URL inkl. Token for eine camera.
	 *
	 * @param {string} devId - Sanitisierte camera-ID.
	 * @returns {string} Vollständige MJPEG-Stream-URL inkl. Token.
	 */
	streamUrl(devId) {
		const host = this.publicHost || 'localhost';
		return `http://${host}:${this.port}/stream/${encodeURIComponent(devId)}.mjpeg?token=${encodeURIComponent(this.token)}`;
	}

	/**
	 * Liefert true, wenn aktuell mindestens ein Client for die camera
	 * is connected or a manual wake is active.
	 *
	 * @param {string} devId - Sanitisierte camera-ID.
	 * @returns {boolean} true, wenn die camera aktuell aktiv gepollt werden sollte.
	 */
	isActive(devId) {
		const entry = this.cameras.get(devId);
		if (!entry) {
			return false;
		}
		const now = Date.now();
		if (entry.clients.size > 0) {
			return true;
		}
		if (entry.manualWakeUntil > now) {
			return true;
		}
		// Tolerante run-onzeit: nach dem letzten Disconnect noch kurz aktiv halten.
		if (entry.lastClientTs > 0 && now - entry.lastClientTs < this.batteryIdleTimeoutMs) {
			return true;
		}
		return false;
	}

	/**
	 * Startet den HTTP-Server und die polling-Schleife.
	 */
	async start() {
		if (this.server) {
			return;
		}
		this.stopRequested = false;
		this.server = http.createServer((req, res) => this._handleRequest(req, res));
		await new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(this.port, () => {
				this.server.removeListener('error', reject);
				resolve();
			});
		});
		this.adapter.log.info(`MJPEG server listening on port ${this.port}`);
		this._schedulePollLoop(0);
	}

	/**
	 * Stoppt Server und alle Verbindungen.
	 */
	async stop() {
		this.stopRequested = true;
		if (this.pollLoopTimer) {
			clearTimeout(this.pollLoopTimer);
			this.pollLoopTimer = null;
		}
		// Alle Stream-Clients schließen.
		for (const entry of this.cameras.values()) {
			for (const client of entry.clients) {
				try {
					client.end();
				} catch {
					// Verbindung war ggf. schon weg.
				}
			}
			entry.clients.clear();
		}
		if (this.server) {
			await new Promise(resolve => this.server.close(() => resolve()));
			this.server = null;
		}
	}

	// -------------------------------------------------------------------------
	// HTTP-Server
	// -------------------------------------------------------------------------

	/**
	 * Zentraler HTTP-Request-Handler: prüft Token, parst Pfad und delegiert
	 * an die jeweilige Stream-Methode.
	 *
	 * @param {import('http').IncomingMessage} req - Eingehender Request.
	 * @param {import('http').ServerResponse} res - Response-Stream.
	 */
	_handleRequest(req, res) {
		try {
			const url = new URL(req.url, `http://localhost:${this.port}`);
			const path = url.pathname;
			const token = url.searchParams.get('token');

			if (token !== this.token) {
				res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Unauthorized');
				return;
			}

			const m = path.match(/^\/stream\/([^/]+)\.(mjpeg|jpg|jpeg)$/);
			if (!m) {
				res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Not found');
				return;
			}
			const devId = decodeURIComponent(m[1]);
			const ext = m[2];
			const entry = this.cameras.get(devId);
			if (!entry) {
				res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Unknown camera');
				return;
			}

			if (ext === 'mjpeg') {
				this._serveMjpeg(req, res, entry);
			} else {
				this._serveSingleJpeg(req, res, entry);
			}
		} catch (e) {
			try {
				res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end(String(e?.message || e));
			} catch {
				// ignore
			}
		}
	}

	/**
	 * Liefert das jüngste Cache-Bild einer camera als einzelnes JPG, oder
	 * einen 1×1-Pixel-Platzhalter, falls noch kein Frame vorliegt.
	 *
	 * @param {import('http').IncomingMessage} _req - Eingehender Request (unbenutzt).
	 * @param {import('http').ServerResponse} res - Response-Stream.
	 * @param {object} entry - Interner camera-Eintrag aus this.cameras.
	 */
	_serveSingleJpeg(_req, res, entry) {
		const cache = entry.cache;
		if (cache && cache.buffer && cache.buffer.length > 0) {
			res.writeHead(200, {
				'Content-Type': cache.mime || 'image/jpeg',
				'Content-Length': cache.buffer.length,
				'Cache-Control': 'no-store',
				'X-Snapshot-Timestamp': new Date(cache.ts).toISOString(),
			});
			res.end(cache.buffer);
		} else {
			const buf = placeholderJpeg();
			res.writeHead(200, {
				'Content-Type': 'image/jpeg',
				'Content-Length': buf.length,
				'Cache-Control': 'no-store',
				[PLACEHOLDER_RETRY_HEADER]: 'true',
			});
			res.end(buf);
		}
	}

	/**
	 * Öffnet einen langlebigen MJPEG-Stream (multipart/x-mixed-replace) und
	 * registriert die Response in der Client-Liste der camera.
	 *
	 * @param {import('http').IncomingMessage} req - Eingehender Request.
	 * @param {import('http').ServerResponse} res - Response-Stream.
	 * @param {object} entry - Interner camera-Eintrag aus this.cameras.
	 */
	_serveMjpeg(req, res, entry) {
		// MJPEG: multipart/x-mixed-replace, jeder Part ist ein JPEG.
		res.writeHead(200, {
			'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
			'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
			Pragma: 'no-cache',
			Connection: 'close',
		});

		entry.clients.add(res);
		entry.lastClientTs = Date.now();
		this.adapter.log.debug(`MJPEG: client connected for ${entry.meta.name} (${entry.clients.size} active)`);

		// Sofort den aktuellen Cache-Frame raushauen, damit der Client nicht
		// mit einem grauen Bild dasitzt.
		this._sendFrame(res, entry.cache?.buffer || placeholderJpeg());

		const cleanup = () => {
			if (!entry.clients.has(res)) {
				return;
			}
			entry.clients.delete(res);
			entry.lastClientTs = Date.now();
			this.adapter.log.debug(`MJPEG: client disconnected for ${entry.meta.name} (${entry.clients.size} active)`);
		};
		req.on('close', cleanup);
		req.on('error', cleanup);
		res.on('close', cleanup);
		res.on('error', cleanup);
	}

	/**
	 * Schreibt einen einzelnen JPEG-Frame inkl. multipart-Boundary in eine
	 * Stream-Response.
	 *
	 * @param {import('http').ServerResponse} res - Response-Stream.
	 * @param {Buffer} buffer - JPEG-Bilddaten.
	 */
	_sendFrame(res, buffer) {
		try {
			res.write(`--${MJPEG_BOUNDARY}\r\n`);
			res.write(`Content-Type: image/jpeg\r\n`);
			res.write(`Content-Length: ${buffer.length}\r\n\r\n`);
			res.write(buffer);
			res.write('\r\n');
		} catch {
			// Schreibfehler bedeutet, dass der Client weg ist – cleanup via die
			// 'close'-Listener.
		}
	}

	/**
	 * Sends the current cached camera frame to all connected
	 * MJPEG-Clients.
	 *
	 * @param {object} entry - Interner camera-Eintrag aus this.cameras.
	 */
	_broadcastFrame(entry) {
		if (!entry.cache) {
			return;
		}
		for (const client of entry.clients) {
			this._sendFrame(client, entry.cache.buffer);
		}
	}

	// -------------------------------------------------------------------------
	// polling-Loop (sequentiell, round-robin)
	// -------------------------------------------------------------------------

	/**
	 * Plant den nächsten Lauf der polling-Schleife.
	 *
	 * @param {number} delayMs - Wartezeit bis zum nächsten Tick in Millisekunden.
	 */
	_schedulePollLoop(delayMs) {
		if (this.stopRequested) {
			return;
		}
		this.pollLoopTimer = this.adapter.setTimeout(() => this._pollLoopTick().catch(() => {}), delayMs);
	}

	/**
	 * Wählt die nächste fällige camera aus und versucht, einen frischen
	 * Snapshot abzuholen. Plant sich danach selbst neu ein.
	 */
	async _pollLoopTick() {
		if (this.stopRequested) {
			return;
		}
		const now = Date.now();

		// Kandidaten ermitteln: alle cameras, die "fällig" und "berechtigt" sind.
		const candidates = [];
		for (const [devId, entry] of this.cameras.entries()) {
			if (entry.busyUntil > now) {
				continue;
			}
			const intervalMs = entry.meta.wired ? this.wiredIntervalMs : this.batteryIntervalMs;
			if (now - entry.lastPollTs < intervalMs) {
				continue;
			}
			if (!entry.meta.wired) {
				// Battery-powered cameras: only when active AND battery level is sufficient.
				if (!this.isActive(devId)) {
					continue;
				}
				const lvl = entry.meta.batteryLevel;
				if (Number.isFinite(lvl) && lvl < this.batteryMinLevel) {
					continue;
				}
			}
			candidates.push([devId, entry]);
		}

		if (candidates.length === 0) {
			// Nichts zu tun – kurz schlafen und neu prüfen.
			this._schedulePollLoop(2000);
			return;
		}

		// camera mit dem ältesten lastPollTs zuerst (faire Reihenfolge).
		candidates.sort((a, b) => a[1].lastPollTs - b[1].lastPollTs);
		const [, entry] = candidates[0];

		entry.lastPollTs = now;
		try {
			const buffer = await entry.fetchSnapshot();
			if (Buffer.isBuffer(buffer) && buffer.length > 0) {
				entry.cache = { buffer, mime: 'image/jpeg', ts: Date.now() };
				this._broadcastFrame(entry);
			}
		} catch (e) {
			const msg = String(e?.message || e);
			if (msg.includes('HTTP 409') || msg.toLowerCase().includes('busy')) {
				// Cloud sagt "busy" – diese camera for 30s aussetzen.
				entry.busyUntil = Date.now() + 30000;
				this.adapter.log.debug(`MJPEG poll: ${entry.meta.name} busy, pausing for 30s`);
			} else {
				this.adapter.log.warn(`MJPEG poll: ${entry.meta.name}: ${msg}`);
			}
		}

		// Kurze Pause zwischen sequenziellen Polls, um die Cloud zu entlasten.
		this._schedulePollLoop(500);
	}
}

module.exports = { MjpegServer };
