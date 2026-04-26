'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const fs = require('fs');
const path = require('path');
const blinkApi = require('./lib/blink-api');

// Load your modules here, e.g.:

class BlinkAdapter extends utils.Adapter {
	constructor(options = {}) {
		super({ ...options, name: 'blink' });
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.pollTimer = null;
		this.liveTimer = null;
		this.liveInProgress = false;
		this.liveSnapshotCursor = 0;
		this.videoSyncInProgress = false;
		this.videoCheckCooldownMs = 5 * 60 * 1000;
		this.lastVideoCheckByDevId = new Map();
		this.camerasById = new Map(); // devId → cam-Objekt (inkl. network_id, thumbnail …)
		this.syncById = new Map(); // devId → sync-Objekt
		this.session = null;
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	async onReady() {
                try {
                 fs.rmSync ('/tmp/blink_debug.log', { force: true });
                 } catch (e) {}
		this.setState('info.connection', false, true);

		const email = (this.config.email || '').trim();
		const password = this.config.password || '';
		const pin = this.config.pin || '';
		const pollIntervalSec = Math.max(15, Number(this.config.pollIntervalSec) || 60);
		const snapshotDir = (this.config.snapshotDir || '/opt/iobroker/iobroker-data/blink').trim();
		const liveSnapshotEnabled = this.config.liveSnapshotEnabled !== false;
		const liveSnapshotIntervalSec = Math.max(5, Number(this.config.liveSnapshotIntervalSec) || 30);
		const storeBase64 = this.config.storeBase64 !== false;
		const cleanupOldSnapshots = this.config.cleanupOldSnapshots !== false;
		const maxSnapshotAgeHours = Math.max(1, Number(this.config.maxSnapshotAgeHours) || 24);
		const batteryWarningEnabled = this.config.batteryWarningEnabled === true;
		const batteryWarningThresholdVolt = Number(this.config.batteryWarningThresholdVolt) || 1.1;
		const batteryWarningPushoverInst = (this.config.batteryWarningPushoverInstance || 'pushover.0').trim();
		const batteryWarningCooldownHours = Math.max(1, Number(this.config.batteryWarningCooldownHours) || 24);

		this.cfg = {
			email,
			password,
			pin,
			pollIntervalSec,
			snapshotDir,
			liveSnapshotEnabled,
			liveSnapshotIntervalSec,
			storeBase64,
			cleanupOldSnapshots,
			maxSnapshotAgeHours,
			batteryWarningEnabled,
			batteryWarningThresholdVolt,
			batteryWarningPushoverInst,
			batteryWarningCooldownHours,
		};

		if (!email || !password) {
			this.log.error('Bitte E-Mail und Passwort in der Konfiguration eintragen.');
			return;
		}

		try {
			fs.mkdirSync(snapshotDir, { recursive: true });
		} catch {}

		await this.setObjectNotExistsAsync('info.connection', {
			type: 'state',
			common: { name: 'Connected', type: 'boolean', role: 'indicator.connected', read: true, write: false },
			native: {},
		});

		this.subscribeStates('cameras.*.commands.*');
		this.subscribeStates('sync.*.commands.*');

		try {
			this.session = await blinkApi.getSession(email, password, pin);
			await this.pollOnce();
			if (cleanupOldSnapshots) {
				this.cleanupSnapshots();
			}
			this.setState('info.connection', true, true);
		} catch (e) {
			this.log.error(`Initialer Connect/Poll fehlgeschlagen: ${e?.message || e}`);
			this.setState('info.connection', false, true);
		}

		this.pollTimer = setInterval(async () => {
			try {
				this.session = await blinkApi.getSession(email, password, pin);
				await this.pollOnce();
			} catch (err) {
				this.log.warn(`Poll-Fehler: ${err?.message || err}`);
				this.setState('info.connection', false, true);
			}
		}, pollIntervalSec * 1000);

		if (liveSnapshotEnabled) {
			this.liveTimer = setInterval(
				() => this.updateLiveSnapshots().catch(e => this.log.warn(`Live-Snapshot-Fehler: ${e?.message || e}`)),
				liveSnapshotIntervalSec * 1000,
			);
		}
	}

	// ─── Poll ────────────────────────────────────────────────────────────────

	async pollOnce() {
		const { cameras, syncModules } = await blinkApi.getDevices(this.session);

		for (const mod of syncModules) {
			const devId = this.sanitizeId(mod.id || mod.name);
			const base = `sync.${devId}`;
			this.syncById.set(devId, mod);

			await this.ensureSyncObjects(base, mod);
			await this.setSyncStates(base, mod);
		}

		for (const cam of cameras) {
			const devId = this.sanitizeId(cam.id || cam.name);
			const base = `cameras.${devId}`;
			this.camerasById.set(devId, cam);

			await this.ensureDeviceObjects(base, cam);
			await this.setCameraStates(base, cam, devId);
		}

		await this.syncLatestCloudVideos(cameras);
		this.setState('info.connection', true, true);
	}

	async ensureDeviceObjects(base, cam) {
		await this.setObjectNotExistsAsync(base, {
			type: 'device',
			common: { name: cam.name || base },
			native: { blinkId: cam.id },
		});
		for (const ch of ['info', 'status', 'battery', 'commands', 'video', 'live']) {
			await this.setObjectNotExistsAsync(`${base}.${ch}`, { type: 'channel', common: { name: ch }, native: {} });
		}
		await this.ensureState(`${base}.info.name`, 'Name', 'string', 'text', false);
		await this.ensureState(`${base}.info.serial`, 'Serial', 'string', 'text', false);
		await this.ensureState(`${base}.info.network_id`, 'Netzwerk-ID', 'number', 'value', false);
		await this.ensureState(`${base}.status.battery`, 'Batterie (V)', 'number', 'value.battery', false);
		await this.ensureState(`${base}.status.battery_raw`, 'Batterie roh', 'number', 'value', false);
		await this.ensureState(`${base}.status.battery_volt`, 'Batteriespannung (V)', 'number', 'value.voltage', false);
		await this.ensureState(`${base}.status.temperature`, 'Temperatur (°C)', 'number', 'value.temperature', false);
		await this.ensureState(`${base}.status.temperature_f`, 'Temperatur (°F)', 'number', 'value.temperature', false);
		await this.ensureState(`${base}.status.wifi_strength`, 'WLAN-Stärke', 'number', 'value.signal', false);
		await this.ensureState(
			`${base}.status.motion_detect_enabled`,
			'Bewegungserkennung',
			'boolean',
			'switch.enable',
			false,
		);
		await this.ensureState(`${base}.status.armed`, 'Scharf (System)', 'boolean', 'indicator.armed', false);
		await this.ensureState(`${base}.status.last_update`, 'Letztes Update', 'string', 'date', false);
		await this.ensureState(`${base}.battery.low`, 'Batterie niedrig', 'boolean', 'indicator.warning', false);
		await this.ensureState(`${base}.battery.lastWarning`, 'Letzter Hinweis', 'string', 'date', false);
		await this.ensureState(`${base}.battery.warningSent`, 'Warnung gesendet', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.battery.lastMessage`, 'Letzter Warnhinweis-Text', 'string', 'text', false);
		await this.ensureState(
			`${base}.commands.motion_detect`,
			'Bewegungserkennung setzen',
			'boolean',
			'switch.enable',
			true,
		);
		await this.ensureState(`${base}.commands.snapshot`, 'Snapshot auslösen', 'boolean', 'button', true);
		await this.ensureState(`${base}.commands.snapshot_file`, 'Letzter Snapshot-Pfad', 'string', 'text', false);
		await this.ensureState(`${base}.commands.fetch_video`, 'Neuestes MP4 laden', 'boolean', 'button', true);
		await this.ensureState(`${base}.commands.clear_session`, 'Session-Cache löschen', 'boolean', 'button', true);
		await this.ensureState(`${base}.video.file`, 'MP4-Datei', 'string', 'text', false);
		await this.ensureState(`${base}.video.timestamp`, 'MP4-Zeitstempel', 'string', 'date', false);
		await this.ensureState(`${base}.video.id`, 'MP4 Cloud-ID', 'string', 'text', false);
		await this.ensureState(`${base}.video.size`, 'MP4-Dateigröße', 'number', 'value', false);
		await this.ensureState(`${base}.video.ready`, 'MP4 bereit', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.video.lastError`, 'MP4 letzter Fehler', 'string', 'text', false);
		await this.ensureState(`${base}.live.file`, 'Live-Snapshot Datei', 'string', 'text', false);
		await this.ensureState(`${base}.live.image_base64`, 'Live-Snapshot Base64', 'string', 'text', false);
		await this.ensureState(`${base}.live.mime_type`, 'Bild MIME-Typ', 'string', 'text', false);
		await this.ensureState(`${base}.live.timestamp`, 'Live-Snapshot Zeitstempel', 'string', 'date', false);

		await this.initStateIfUnset(`${base}.status.armed`, false);
		await this.initStateIfUnset(`${base}.battery.low`, false);
		await this.initStateIfUnset(`${base}.battery.lastWarning`, '');
		await this.initStateIfUnset(`${base}.battery.warningSent`, false);
		await this.initStateIfUnset(`${base}.battery.lastMessage`, '');
		await this.initStateIfUnset(`${base}.commands.motion_detect`, false);
		await this.initStateIfUnset(`${base}.commands.snapshot`, false);
		await this.initStateIfUnset(`${base}.commands.snapshot_file`, '');
		await this.initStateIfUnset(`${base}.commands.fetch_video`, false);
		await this.initStateIfUnset(`${base}.commands.clear_session`, false);
		await this.initStateIfUnset(`${base}.video.file`, '');
		await this.initStateIfUnset(`${base}.video.timestamp`, '');
		await this.initStateIfUnset(`${base}.video.id`, '');
		await this.initStateIfUnset(`${base}.video.size`, 0);
		await this.initStateIfUnset(`${base}.video.ready`, false);
		await this.initStateIfUnset(`${base}.video.lastError`, '');
		await this.initStateIfUnset(`${base}.live.file`, '');
		await this.initStateIfUnset(`${base}.live.image_base64`, '');
		await this.initStateIfUnset(`${base}.live.mime_type`, '');
		await this.initStateIfUnset(`${base}.live.timestamp`, '');
	}

	async setCameraStates(base, cam, devId) {
		await this.setStateAsync(`${base}.info.name`, String(cam.name || ''), true);
		await this.setStateAsync(`${base}.info.serial`, String(cam.serial || ''), true);
		await this.setNumStateIfValid(`${base}.info.network_id`, cam.network_id);
		await this.setNumStateIfValid(`${base}.status.battery`, cam.battery_volt);
		await this.setNumStateIfValid(`${base}.status.battery_raw`, cam.battery_raw);
		await this.setNumStateIfValid(`${base}.status.battery_volt`, cam.battery_volt);
		await this.setNumStateIfValid(`${base}.status.temperature`, cam.temperature);
		await this.setNumStateIfValid(`${base}.status.temperature_f`, cam.temperature_f);
		await this.setNumStateIfValid(`${base}.status.wifi_strength`, cam.wifi_strength);
		await this.setBoolStateIfDefined(`${base}.status.motion_detect_enabled`, cam.motion_detect_enabled);

		const sync = [...this.syncById.values()].find(mod => String(mod?.network_id) === String(cam?.network_id));
		const effectiveArmed = cam.armed != null ? cam.armed : sync?.armed != null ? sync.armed : null;
		if (effectiveArmed != null) {
			await this.setStateAsync(`${base}.status.armed`, !!effectiveArmed, true);
		}
		if (cam.updated != null) {
			await this.setStateAsync(`${base}.status.last_update`, String(cam.updated || ''), true);
		}
		await this.checkBatteryWarning(devId, cam);
		if (cam.motion_detect_enabled != null) {
			await this.setStateAsync(`${base}.commands.motion_detect`, !!cam.motion_detect_enabled, true);
		}
		await this.setStateAsync(`${base}.commands.fetch_video`, false, true);
	}

	async ensureSyncObjects(base, mod) {
		await this.setObjectNotExistsAsync(base, {
			type: 'device',
			common: { name: mod.name || base },
			native: { blinkId: mod.id },
		});
		for (const ch of ['info', 'status', 'commands']) {
			await this.setObjectNotExistsAsync(`${base}.${ch}`, { type: 'channel', common: { name: ch }, native: {} });
		}
		await this.ensureState(`${base}.info.name`, 'Name', 'string', 'text', false);
		await this.ensureState(`${base}.info.serial`, 'Serial', 'string', 'text', false);
		await this.ensureState(`${base}.status.armed`, 'Scharf', 'boolean', 'indicator.armed', false);
		await this.ensureState(`${base}.status.last_update`, 'Letztes Update', 'string', 'date', false);
		await this.ensureState(`${base}.commands.armed`, 'Scharf/Unscharf', 'boolean', 'switch.enable', true);

		await this.initStateIfUnset(`${base}.commands.armed`, false);
	}

	async setSyncStates(base, mod) {
		await this.setStateAsync(`${base}.info.name`, String(mod.name || ''), true);
		await this.setStateAsync(`${base}.info.serial`, String(mod.serial || ''), true);
		await this.setBoolStateIfDefined(`${base}.status.armed`, mod.armed);
		if (mod.updated != null) {
			await this.setStateAsync(`${base}.status.last_update`, String(mod.updated || ''), true);
		}
		if (mod.armed != null) {
			await this.setStateAsync(`${base}.commands.armed`, !!mod.armed, true);
		}
	}

	// ─── Live-Snapshots ──────────────────────────────────────────────────────

	async updateLiveSnapshots() {
		if (this.liveInProgress || !this.session) {
			return;
		}
		this.liveInProgress = true;
		try {
			const cams = [...this.camerasById.entries()].filter(([, cam]) => !!cam?.id);
			if (cams.length === 0) {
				return;
			}

			const index = this.liveSnapshotCursor % cams.length;
			this.liveSnapshotCursor = (index + 1) % cams.length;

			const [devId, cam] = cams[index];
			const file = path.join(this.cfg.snapshotDir, `${devId}_live.jpg`);
			try {
				await blinkApi.snapshot(this.session, cam.network_id, cam.id, cam.thumbnail, file);
				await this.setLiveStates(devId, file);
			} catch (e) {
				const msg = String(e?.message || e);
				if (msg.includes('HTTP 409') && msg.includes('System is busy')) {
					this.log.debug(`Live-Snapshot übersprungen für ${cam.name}: ${msg}`);
				} else {
					this.log.warn(`Live-Snapshot Fehler für ${cam.name}: ${msg}`);
				}
			}

			if (this.cfg.cleanupOldSnapshots) {
				this.cleanupSnapshots();
			}
		} finally {
			this.liveInProgress = false;
		}
	}

	async setLiveStates(devId, file) {
		const base = `cameras.${devId}`;
		await this.setStateAsync(`${base}.commands.snapshot_file`, file, true);
		await this.setStateAsync(`${base}.live.file`, file, true);
		await this.setStateAsync(`${base}.live.mime_type`, 'image/jpeg', true);
		await this.setStateAsync(`${base}.live.timestamp`, new Date().toISOString(), true);
		if (this.cfg.storeBase64) {
			try {
				const b64 = fs.readFileSync(file).toString('base64');
				await this.setStateAsync(`${base}.live.image_base64`, `data:image/jpeg;base64,${b64}`, true);
			} catch {}
		}
	}

	// ─── State-Change / Befehle ──────────────────────────────────────────────

	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}
		if (!this.session) {
			this.log.warn('Noch nicht verbunden.');
			return;
		}

		const parts = id.split('.');
		const cmd = parts[parts.length - 1];
		const devId = parts[parts.length - 3];
		const group = parts[parts.length - 4];

		// Session-Cache löschen (gilt für alle Geräte)
		if (cmd === 'clear_session') {
			blinkApi.clearSession(this.cfg.email);
			this.log.info('Blink Session-Cache gelöscht.');
			await this.setStateAsync(this.stripNs(id), false, true);
			return;
		}

		try {
			if (group === 'cameras') {
				const cam = this.camerasById.get(devId);
				if (!cam) {
					throw new Error('Kamera unbekannt (warte auf nächsten Poll)');
				}

				if (cmd === 'motion_detect') {
					const enable = state.val === true;
					await blinkApi.setMotion(this.session, cam.network_id, cam.id, enable);
					await this.setStateAsync(`cameras.${devId}.status.motion_detect_enabled`, enable, true);
					await this.setStateAsync(this.stripNs(id), enable, true);
				} else if (cmd === 'snapshot') {
					if (state.val !== true) {
						return;
					}
					const file = path.join(this.cfg.snapshotDir, `${devId}.jpg`);
					await blinkApi.snapshot(this.session, cam.network_id, cam.id, cam.thumbnail, file);
					await this.setLiveStates(devId, file);
					await this.setStateAsync(this.stripNs(id), false, true);
				} else if (cmd === 'fetch_video') {
					if (state.val !== true) {
						return;
					}
					const ts = new Date().toISOString().replace(/[:.]/g, '-');
					const file = path.join(this.cfg.snapshotDir, `${devId}_${ts}.mp4`);
					try {
						const res = await blinkApi.downloadVideo(this.session, cam.network_id, cam.id, file);
						await this.updateVideoStates(devId, res);
					} catch (e) {
						await this.setStateAsync(`cameras.${devId}.video.ready`, false, true);
						await this.setStateAsync(`cameras.${devId}.video.lastError`, String(e?.message || e), true);
						this.log.warn(`Video-Download fehlgeschlagen (${cam.name}): ${e?.message || e}`);
					}
					await this.setStateAsync(this.stripNs(id), false, true);
				}
			} else if (group === 'sync') {
				const mod = this.syncById.get(devId);
				if (!mod) {
					throw new Error('Sync-Modul unbekannt (warte auf nächsten Poll)');
				}

				if (cmd === 'armed') {
					const armed = state.val === true;
					await blinkApi.setArmed(this.session, mod.network_id, armed);
					await this.setStateAsync(`sync.${devId}.status.armed`, armed, true);
					await this.setStateAsync(this.stripNs(id), armed, true);
				}
			}
		} catch (e) {
			this.log.warn(`Befehl fehlgeschlagen (${id}): ${e?.message || e}`);
		}
	}

	async syncLatestCloudVideos(cameras) {
		if (this.videoSyncInProgress || !this.session) {
			return;
		}
		this.videoSyncInProgress = true;
		try {
			for (const cam of cameras) {
				const devId = this.sanitizeId(cam.id || cam.name);
				const lastCheck = this.lastVideoCheckByDevId.get(devId) || 0;
				if (Date.now() - lastCheck < this.videoCheckCooldownMs) {
					continue;
				}
				this.lastVideoCheckByDevId.set(devId, Date.now());

				try {
					const latest = await blinkApi.getLatestVideoInfo(this.session, cam.network_id, cam.id);
					if (!latest) {
						continue;
					}

					const tsState = await this.getStateAsync(`cameras.${devId}.video.timestamp`);
					const fileState = await this.getStateAsync(`cameras.${devId}.video.file`);
					const idState = await this.getStateAsync(`cameras.${devId}.video.id`);

					const currentTs = String(tsState?.val || '');
					const currentId = String(idState?.val || '');
					const currentFile = String(fileState?.val || '');
					const haveLocalFile = currentFile && fs.existsSync(currentFile);

					const latestId = String(latest.id || latest.video_id || latest.created_at || latest.url || '');
					const latestTs = String(latest.created_at || '');
					const isSameVideo =
						(latestId && currentId && latestId === currentId) ||
						(latestTs && currentTs && latestTs === currentTs);

					if (isSameVideo && haveLocalFile) {
						continue;
					}

					const file = path.join(this.cfg.snapshotDir, `${devId}_latest.mp4`);
					const res = await blinkApi.downloadVideo(this.session, cam.network_id, cam.id, file, latest);
					await this.updateVideoStates(devId, res);
				} catch (e) {
					this.log.debug(`Cloud-Video Sync übersprungen (${cam.name || devId}): ${e?.message || e}`);
				}
			}
		} finally {
			this.videoSyncInProgress = false;
		}
	}

	async updateVideoStates(devId, res) {
		const ts = String(res?.created_at || new Date().toISOString());
		const videoId = String(res?.id || res?.video_id || '');
		await this.setStateAsync(`cameras.${devId}.video.file`, String(res?.file || ''), true);
		await this.setStateAsync(`cameras.${devId}.video.timestamp`, ts, true);
		await this.setStateAsync(`cameras.${devId}.video.id`, videoId, true);
		await this.setStateAsync(`cameras.${devId}.video.size`, Number(res?.size || 0), true);
		await this.setStateAsync(`cameras.${devId}.video.ready`, true, true);
		await this.setStateAsync(`cameras.${devId}.video.lastError`, '', true);
	}

	// ─── Batterie-Warnung ────────────────────────────────────────────────────

	async checkBatteryWarning(devId, cam) {
		const base = `cameras.${devId}`;
		const volt = this.toNum(cam.battery_volt ?? cam.battery);
		const thresh = this.toNum(this.cfg.batteryWarningThresholdVolt) ?? 1.1;

		if (volt === null) {
			await this.setStateAsync(`${base}.battery.low`, false, true);
			return;
		}

		const isLow = volt <= thresh;
		await this.setStateAsync(`${base}.battery.low`, isLow, true);

		if (!this.cfg.batteryWarningEnabled || !isLow) {
			if (!isLow) {
				await this.setStateAsync(`${base}.battery.warningSent`, false, true);
			}
			return;
		}

		const cooldownMs = this.cfg.batteryWarningCooldownHours * 3600 * 1000;
		const last = await this.getStateAsync(`${base}.battery.lastWarning`);
		const lastTs = last?.val ? Date.parse(String(last.val)) : 0;

		if (lastTs && Date.now() - lastTs < cooldownMs) {
			return;
		}

		const msg = `Blink Batterie niedrig\n\nKamera: ${cam.name || devId}\nSpannung: ${volt.toFixed(2)} V\nGrenzwert: ${thresh.toFixed(2)} V`;
		await this.setStateAsync(`${base}.battery.lastMessage`, msg, true);

		try {
			await new Promise((res, rej) => {
				this.sendTo(
					this.cfg.batteryWarningPushoverInst,
					'send',
					{ title: 'Blink Batterie niedrig', message: msg, priority: 0 },
					r => (r?.error ? rej(new Error(String(r.error))) : res(r)),
				);
			});
			await this.setStateAsync(`${base}.battery.warningSent`, true, true);
			await this.setStateAsync(`${base}.battery.lastWarning`, new Date().toISOString(), true);
		} catch (e) {
			this.log.warn(`Pushover-Warnung fehlgeschlagen (${cam.name}): ${e?.message || e}`);
		}
	}

	// ─── Snapshot-Cleanup ────────────────────────────────────────────────────

	cleanupSnapshots() {
		const dir = this.cfg.snapshotDir;
		const maxAgeMs = this.cfg.maxSnapshotAgeHours * 3600 * 1000;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const now = Date.now();
		for (const e of entries) {
			if (!e.isFile()) {
				continue;
			}
			if (!/\.(jpg|jpeg|mp4)$/i.test(e.name)) {
				continue;
			}
			const full = path.join(dir, e.name);
			try {
				if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
					fs.unlinkSync(full);
				}
			} catch {}
		}
	}

	// ─── Hilfsmethoden ───────────────────────────────────────────────────────

	async ensureState(id, name, type, role, writable) {
		await this.setObjectNotExistsAsync(id, {
			type: 'state',
			common: { name, type, role, read: true, write: !!writable },
			native: {},
		});
	}

	async initStateIfUnset(id, defaultValue) {
		const cur = await this.getStateAsync(id);
		if (!cur || cur.val === null || cur.val === undefined) {
			await this.setStateAsync(id, defaultValue, true);
		}
	}

	async setNumStateIfValid(id, value) {
		const n = this.toNum(value);
		if (n !== null) {
			await this.setStateAsync(id, n, true);
		}
	}

	async setBoolStateIfDefined(id, value) {
		if (value !== null && value !== undefined) {
			await this.setStateAsync(id, !!value, true);
		}
	}

	sanitizeId(id) {
		return String(id).replace(/[^a-zA-Z0-9_\-]/g, '_');
	}
	toNum(v) {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	stripNs(fullId) {
		const ns = `${this.namespace}.`;
		return fullId.startsWith(ns) ? fullId.slice(ns.length) : fullId;
	}

	// ─── Unload ──────────────────────────────────────────────────────────────

	onUnload(cb) {
		try {
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
			}
			if (this.liveTimer) {
				clearInterval(this.liveTimer);
			}
			cb();
		} catch {
			cb();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new BlinkAdapter(options);
} else {
	new BlinkAdapter();
}
