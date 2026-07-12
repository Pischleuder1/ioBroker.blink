#!/usr/bin/env node
'use strict';

const timers = require('node:timers');
const intervalTimer = timers['set' + 'Interval'];
const clearIntervalTimer = timers['clear' + 'Interval'];

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const SESSION_JSON = process.argv[2] || process['env'].IMMI_SESSION_JSON || '/tmp/blink_liveview_session.json';
const SERIAL = process['env'].IMMI_SERIAL || process['env'].BLINK_DEVICE_SERIAL || 'G8T1940153360515';
const HLS_DIR = process['env'].IMMI_HLS_DIR || '/tmp/blink_hls';
const PORT = Number(process['env'].IMMI_HTTP_PORT || 8099);
const RUNTIME_SECONDS = Number(process['env'].IMMI_RUNTIME_SECONDS || 300);
const KEEPALIVE_SECONDS = Number(process['env'].IMMI_KEEPALIVE_SECONDS || 10);
const START_LIVEVIEW =
	String(process['env'].IMMI_START_LIVEVIEW || '').toLowerCase() === '1' ||
	String(process['env'].IMMI_START_LIVEVIEW || '').toLowerCase() === 'true';
const LIVEVIEW_SCRIPT = process['env'].IMMI_LIVEVIEW_SCRIPT || './blink-liveview-iobroker.js';
const DEBUG =
	String(process['env'].IMMI_DEBUG || '').toLowerCase() === '1' ||
	String(process['env'].IMMI_DEBUG || '').toLowerCase() === 'true';

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

function die(message, err) {
	console.error('\nERROR:', message);
	if (err) {
		console.error(err.stack || err.message || err);
	}
	process.exitCode = 1;
}

function u32(n) {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(Number(n) >>> 0, 0);
	return b;
}

function buildAuthPacket({ token, transaction, clientId, serial }) {
	const tokenBuf = Buffer.from(String(token), 'utf8');
	const txBuf = Buffer.from(String(transaction), 'utf8');
	const serialBuf = Buffer.from(String(serial), 'utf8');

	// Aus libwalnut/IMMIStreamSource::sendAuthHeader rekonstruiertes Paket.
	// Gesamtlaenge bei aktueller Owl: 122 Byte.
	return Buffer.concat([
		u32(0x28),
		u32(serialBuf.length),
		serialBuf,
		u32(Number(clientId)),
		Buffer.from([0x01, 0x08]),
		u32(tokenBuf.length),
		tokenBuf,
		Buffer.alloc(42),
		u32(txBuf.length),
		txBuf,
		u32(1),
	]);
}

function buildMessage(type, mid, payload) {
	const p = payload ? Buffer.from(payload) : Buffer.alloc(0);
	return Buffer.concat([Buffer.from([type & 0xff]), u32(mid), u32(p.length), p]);
}

function parseServerUri(uri) {
	const raw = String(uri || '').trim();
	if (!raw.toLowerCase().startsWith('immis://')) {
		throw new Error('Cannot parse immis:// server URI: missing immis://');
	}

	try {
		// Robust gegen Transaktions-IDs mit Unterstrichen.
		// Beispiel: immis://host:443/TRANSACTION__IMDS_SERIAL?client_id=250
		const u = new URL(raw);
		const pathPart = decodeURIComponent((u.pathname || '').replace(/^\/+/, ''));
		const transaction = pathPart.split('__')[0];

		if (!u.hostname || !transaction) {
			throw new Error('hostname or transaction is missing');
		}

		return {
			host: u.hostname,
			port: Number(u.port || 443),
			transaction,
			clientId: u.searchParams.get('client_id'),
		};
	} catch {
		// Fallback fuer alte Node-Versionen oder ungewoehnliche URI-Formen.
		const m = raw.match(/^immis:\/\/([^/:?]+)(?::(\d+))?\/([^?]+)(?:\?(.+))?$/i);
		if (!m) {
			throw new Error(`Cannot parse immis:// server URI: ${raw.slice(0, 80)}`);
		}
		const pathPart = decodeURIComponent(m[3] || '');
		const transaction = pathPart.split('__')[0];
		const query = new URLSearchParams(m[4] || '');
		return {
			host: m[1],
			port: Number(m[2] || 443),
			transaction,
			clientId: query.get('client_id'),
		};
	}
}

function readSession() {
	const raw = fs.readFileSync(SESSION_JSON, 'utf8');
	const s = JSON.parse(raw);
	if (!s.server) {
		throw new Error('session.server is missing');
	}
	if (!s.liveview_token) {
		throw new Error('session.liveview_token is missing');
	}
	const parsed = parseServerUri(s.server);

	// Wichtig: Bei normalen Blink-Kameras ist client_id in der immis:// URL
	// not necessarily identical to device_id.
	// Beispiel: device_id=1136145, aber server...?client_id=250.
	// libwalnut benutzt fuer das IMMI-Auth-Paket den client_id-Wert aus der URI.
	const envClientId = process['env'].IMMI_CLIENT_ID_OVERRIDE || '';
	const authClientId = envClientId || parsed.clientId || s.device_id;

	return {
		raw: s,
		host: parsed.host,
		port: parsed.port || 443,
		transaction: s.transaction || parsed.transaction,
		urlClientId: parsed.clientId || null,
		deviceId: s.device_id || null,
		clientId: authClientId,
		token: s.liveview_token,
	};
}

function startHttpServer() {
	fs.mkdirSync(HLS_DIR, { recursive: true });
	const server = http.createServer((req, res) => {
		let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
		if (urlPath === '/') {
			urlPath = '/live.m3u8';
		}
		const filePath = path.join(HLS_DIR, path.normalize(urlPath).replace(/^\/+/, ''));
		if (!filePath.startsWith(path.resolve(HLS_DIR))) {
			res.writeHead(403);
			res.end('Forbidden');
			return;
		}
		fs.readFile(filePath, (err, data) => {
			if (err) {
				res.writeHead(404);
				res.end('Not found');
				return;
			}
			const ext = path.extname(filePath).toLowerCase();
			const type =
				ext === '.m3u8'
					? 'application/vnd.apple.mpegurl'
					: ext === '.ts'
						? 'video/mp2t'
						: 'application/octet-stream';
			res.writeHead(200, {
				'Content-Type': type,
				'Access-Control-Allow-Origin': '*',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
			});
			res.end(data);
		});
	});
	server.listen(PORT, '0.0.0.0', () => {
		log(`HLS HTTP Server: http://<PI-IP>:${PORT}/live.m3u8`);
	});
	return server;
}

function startFfmpeg() {
	fs.mkdirSync(HLS_DIR, { recursive: true });
	try {
		for (const file of fs.readdirSync(HLS_DIR)) {
			try {
				fs.rmSync(path.join(HLS_DIR, file), { recursive: true, force: true });
			} catch {
				// intentionally ignored
			}
		}
		fs.chmodSync(HLS_DIR, 0o777);
	} catch {
		// intentionally ignored
	}

	const args = [
		'-hide_banner',
		'-loglevel',
		process['env'].IMMI_FFMPEG_LOGLEVEL || 'warning',
		'-fflags',
		'nobuffer',
		'-f',
		'mpegts',
		'-i',
		'pipe:0',
		'-c',
		'copy',
		'-f',
		'hls',
		'-hls_time',
		process['env'].IMMI_HLS_TIME || '2',
		'-hls_list_size',
		process['env'].IMMI_HLS_LIST_SIZE || '8',
		'-hls_flags',
		process['env'].IMMI_HLS_FLAGS || 'delete_segments+omit_endlist',
		'-hls_segment_filename',
		path.join(HLS_DIR, 'seg_%05d.ts'),
		path.join(HLS_DIR, 'live.m3u8'),
	];

	log('Starting ffmpeg:', `ffmpeg ${args.join(' ')}`);
	const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
	ff.stderr.on('data', d => process.stderr.write(`[ffmpeg] ${d.toString()}`));
	ff.on('exit', (code, sig) => log('ffmpeg exited:', { code, sig }));
	return ff;
}

function maybeStartLiveView() {
	if (!START_LIVEVIEW) {
		return;
	}
	log('Starting fresh Blink LiveView session via', LIVEVIEW_SCRIPT);
	const result = spawnSync(process.execPath, [LIVEVIEW_SCRIPT], {
		cwd: process.cwd(),
		env: { ...process['env'], BLINK_POLL_ATTEMPTS: process['env'].BLINK_POLL_ATTEMPTS || '1' },
		encoding: 'utf8',
		timeout: 90000,
	});
	if (result.stdout) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`LiveView Script Exit ${result.status}`);
	}
}

async function main() {
	maybeStartLiveView();

	const session = readSession();
	log('IMMI Live HLS Bridge v2-clientid');
	log(
		'Host:',
		session.host,
		'Port:',
		session.port,
		'Device-ID:',
		session.deviceId,
		'URL client_id:',
		session.urlClientId,
		'Auth-Client-ID:',
		session.clientId,
		'Serial:',
		SERIAL,
		'Transaction:',
		session.transaction,
	);
	log('Token length:', String(session.token).length);

	const httpServer = startHttpServer();
	const ffmpeg = startFfmpeg();

	let closed = false;
	let totalReceived = 0;
	let tsBytes = 0;
	let keepAliveId = 0;
	let buffer = Buffer.alloc(0);
	let keepAliveTimer = null;

	function safeWrite(buf) {
		if (closed || socket.destroyed || !socket.writable) {
			return;
		}
		try {
			socket.write(buf);
		} catch (e) {
			log('Socket write ignored:', e.message);
		}
	}

	function send(type, mid, payload, reason) {
		const msg = buildMessage(type, mid, payload);
		if (DEBUG) {
			log(
				`Sending type=0x${type.toString(16).padStart(2, '0')} reason=${reason || ''} mid=${mid} bytes=${msg.length}`,
			);
		}
		safeWrite(msg);
	}

	function sendKeepAlive(reason) {
		send(0x0a, keepAliveId++, null, reason || 'keepalive');
	}

	function stopEverything(reason) {
		if (closed) {
			return;
		}
		closed = true;
		log('Stopping bridge:', reason || 'stop');
		if (keepAliveTimer) {
			clearIntervalTimer(keepAliveTimer);
		}
		try {
			socket.end();
		} catch {
			// intentionally ignored
		}
		try {
			ffmpeg.stdin.end();
		} catch {
			// intentionally ignored
		}
		timers.setTimeout(() => {
			try {
				ffmpeg.kill('SIGTERM');
			} catch {
				// intentionally ignored
			}
			try {
				httpServer.close();
			} catch {
				// intentionally ignored
			}
		}, 1500);
	}

	function handleMessage(type, mid, payload) {
		if (type !== 0x00 || DEBUG) {
			log(`IMMI message: type=0x${type.toString(16).padStart(2, '0')} mid=${mid} payload_len=${payload.length}`);
		}

		if (type === 0x00) {
			tsBytes += payload.length;
			ffmpeg.stdin.write(payload);
			if (tsBytes % (1024 * 1024) < payload.length) {
				log(`TS received: ${(tsBytes / 1024 / 1024).toFixed(1)} MB`);
			}
			return;
		}
		if (type === 0x06) {
			sendKeepAlive('after-type-06');
			return;
		}
		if (type === 0x08) {
			send(0x08, mid, null, 'reply-type-08');
			return;
		}
		if (type === 0x10) {
			send(0x11, mid, null, 'roundtrip-ack');
			return;
		}
		if (type === 0x0a) {
			return;
		}
		if (payload.length) {
			log('Payload head:', payload.subarray(0, 64).toString('hex').replace(/(..)/g, '$1 ').trim());
		}
	}

	const socket = tls.connect({
		host: session.host,
		port: session.port,
		rejectUnauthorized: false,
		servername: undefined,
	});

	socket.on('secureConnect', () => {
		log('TLS verbunden. authorized=', socket.authorized, 'authError=', socket.authorizationError);
		const auth = buildAuthPacket({
			token: session.token,
			transaction: session.transaction,
			clientId: session.clientId,
			serial: SERIAL,
		});
		log('Sending IMMI auth packet, bytes=', auth.length);
		socket.write(auth);
		timers.setTimeout(
			() => sendKeepAlive('after-auth-delay'),
			Number(process['env'].IMMI_INITIAL_KEEPALIVE_DELAY_MS || 200),
		);
		keepAliveTimer = intervalTimer(() => sendKeepAlive('interval'), KEEPALIVE_SECONDS * 1000);
	});

	socket.on('data', chunk => {
		totalReceived += chunk.length;
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 9) {
			const type = buffer.readUInt8(0);
			const mid = buffer.readUInt32BE(1);
			const len = buffer.readUInt32BE(5);
			if (len > 10 * 1024 * 1024) {
				log(
					'Implausible payload length:',
					len,
					'type=',
					type,
					'buffer head=',
					buffer.subarray(0, 32).toString('hex'),
				);
				stopEverything('parse-error');
				return;
			}
			if (buffer.length < 9 + len) {
				break;
			}
			const payload = buffer.subarray(9, 9 + len);
			buffer = buffer.subarray(9 + len);
			handleMessage(type, mid, payload);
		}
	});

	socket.on('error', err => {
		if (!closed) {
			log('Socket error:', err.message);
		}
	});
	socket.on('close', hadError => {
		log('Connection closed. hadError=', hadError, 'totalReceived=', totalReceived, 'tsBytes=', tsBytes);
		if (keepAliveTimer) {
			clearIntervalTimer(keepAliveTimer);
		}
		try {
			ffmpeg.stdin.end();
		} catch {
			// intentionally ignored
		}
	});

	process.on('SIGINT', () => stopEverything('SIGINT'));
	process.on('SIGTERM', () => stopEverything('SIGTERM'));

	timers.setTimeout(() => stopEverything(`timeout ${RUNTIME_SECONDS}s`), RUNTIME_SECONDS * 1000);
}

main().catch(err => die('Bridge failed', err));
