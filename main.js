'use strict';
/*
 * Created with @iobroker/create-adapter v3.1.2
 */

const utils = require('@iobroker/adapter-core');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const blinkApi = require('./lib/blink-api');
const { MjpegServer } = require('./lib/mjpeg-server');

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
		this.videoCheckCooldownMs = 25 * 1000;
		this.lastVideoCheckByDevId = new Map();
		this.lastMotionNotifyByDevId = new Map();
		this.videoBusyUntilByDevId = new Map();
		this.videoBusyCooldownMs = 2 * 60 * 1000;
		this.localStorageBusyCooldownMs = 2 * 60 * 1000;
		this.localStorageBusyUntilBySyncId = new Map();
		this.camerasById = new Map();
		this.syncById = new Map();
		this.session = null;
		this.loginFailureCount = 0;
		this.loginBlocked = false;
		this.loginRateLimitUntil = 0;
		this.loginRateLimitMessage = '';
		this.login2faRequired = false;
		this.login2faMessage = '';
		this.maxLoginFailures = 3;
		this.mjpegServer = null;
		this.mjpegStatusTimer = null;

		// Neues Gerüst für echten 30s-Livestream (später Blink-App-Liveview / RTSP/HLS)
		this.liveSessions = new Map();
		this.liveStopTimers = new Map();
		this.liveProcesses = new Map();
		this.hlsServer = null;
	}

	isCredentialError(err) {
		const msg = String(err?.message || err || '').toLowerCase();

		return (
			msg.includes('invalid_user_credentials') ||
			msg.includes('invalid user credentials') ||
			msg.includes('unauthorized') ||
			msg.includes('http 401') ||
			msg.includes('401')
		);
	}

	isLogin2faRequiredError(err) {
		const msg = String(err?.message || err || '').toLowerCase();
		return (
			err?.code === 'NEED_2FA' ||
			msg.includes('tsv/2fa erforderlich') ||
			msg.includes('2fa/pin erforderlich') ||
			(msg.includes('http 202') && msg.includes('tsv_methods'))
		);
	}

	isLoginRateLimitError(err) {
		const msg = String(err?.message || err || '').toLowerCase();
		const body = err?.body && typeof err.body === 'object' ? err.body : null;
		const bodyCause = String(body?.error_cause || body?.error || '').toLowerCase();
		const bodyDescription = String(body?.error_description || body?.message || '').toLowerCase();

		return (
			err?.code === 'BLINK_2FA_RATE_LIMIT' ||
			err?.statusCode === 429 ||
			msg.includes('2fa_rate_limit_exceeded') ||
			msg.includes('2fa rate limit exceeded') ||
			msg.includes('2fa-rate-limit') ||
			(msg.includes('http 429') && msg.includes('too_many_requests')) ||
			bodyCause.includes('2fa_rate_limit_exceeded') ||
			bodyDescription.includes('2fa rate limit')
		);
	}

	getLoginRateLimitWaitMs(err) {
		const body = err?.body && typeof err.body === 'object' ? err.body : null;
		let sec = Number(err?.nextTimeInSecs || body?.next_time_in_secs);

		if (!Number.isFinite(sec) || sec <= 0) {
			const msg = String(err?.message || err || '');
			const m = msg.match(/"next_time_in_secs"\s*:\s*(\d+)/) || msg.match(/next_time_in_secs[^0-9]+(\d+)/i);
			sec = m ? Number(m[1]) : 600;
		}

		return Math.max(60, Math.ceil(sec)) * 1000;
	}

	getLoginRateLimitRemainingMs() {
		const until = this.loginRateLimitUntil || 0;
		if (!until) {
			return 0;
		}

		const remaining = until - Date.now();
		if (remaining <= 0) {
			this.loginRateLimitUntil = 0;
			this.loginRateLimitMessage = '';
			this.log.info('Blink 2FA rate limit expired, login will be retried on the next poll.');
			return 0;
		}

		return remaining;
	}

	formatLoginRateLimitMessage(remainingMs) {
		const retryAt = new Date(Date.now() + remainingMs).toISOString();
		return `Blink 2FA rate limit is active. Login is paused for another ${Math.ceil(remainingMs / 1000)}s until ${retryAt}.`;
	}

	stopLoginRelatedTimers() {
		if (this.pollTimer) {
			this.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.liveTimer) {
			this.clearTimeout(this.liveTimer);
			this.liveTimer = null;
		}
	}

	async clearStoredPinAfterSuccessfulLogin() {
		try {
			await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
				native: { pin: '' },
			});

			if (this.config) {
				this.config.pin = '';
			}
			if (this.cfg) {
				this.cfg.pin = '';
			}

			this.log.info('Blink 2FA/PIN was removed from the adapter configuration after a successful login.');
		} catch (e) {
			this.log.warn(
				`Blink login was successful, but the 2FA/PIN could not be removed from the adapter configuration automatically. ` +
					`Please remove the PIN manually: ${e?.message || e}`,
			);
		}
	}

	async getBlinkSessionSafe(email, password, pin) {
		if (this.loginBlocked) {
			throw new Error(
				`Blink login was blocked after ${this.loginFailureCount} failed attempts. ` +
					`Please check the credentials and restart the adapter.`,
			);
		}

		if (this.login2faRequired) {
			const err = new Error(
				this.login2faMessage ||
					'Blink 2FA/TSV code is required. Enter the code in the adapter configuration and restart the adapter.',
			);
			err.code = 'LOGIN_2FA_REQUIRED_ACTIVE';
			throw err;
		}

		const rateLimitRemainingMs = this.getLoginRateLimitRemainingMs();
		if (rateLimitRemainingMs > 0) {
			const err = new Error(this.formatLoginRateLimitMessage(rateLimitRemainingMs));
			err.code = 'LOGIN_RATE_LIMIT_ACTIVE';
			err.retryAt = this.loginRateLimitUntil;
			throw err;
		}

		try {
			const session = await blinkApi.getSession(email, password, pin);
			this.loginFailureCount = 0;
			this.loginBlocked = false;
			this.login2faRequired = false;
			this.login2faMessage = '';

			if (String(pin || '').trim()) {
				await this.clearStoredPinAfterSuccessfulLogin();
			}

			return session;
		} catch (err) {
			if (this.isLoginRateLimitError(err)) {
				const waitMs = this.getLoginRateLimitWaitMs(err);
				this.loginRateLimitUntil = Date.now() + waitMs;
				this.loginRateLimitMessage = err?.message || 'Blink 2FA rate limit is active.';
				this.session = null;
				this.setState('info.connection', false, true);

				this.log.warn(
					`Blink 2FA rate limit detected. Further login attempts are blocked locally until ` +
						`${new Date(this.loginRateLimitUntil).toISOString()}. ` +
						`Reason: ${err?.message || err}`,
				);

				err.code = err.code || 'BLINK_2FA_RATE_LIMIT';
				err.retryAt = this.loginRateLimitUntil;
				throw err;
			}

			if (this.isLogin2faRequiredError(err)) {
				this.login2faRequired = true;
				this.login2faMessage = err?.message || 'Blink 2FA/TSV code required.';
				this.session = null;
				this.setState('info.connection', false, true);

				this.log.warn(
					`${this.login2faMessage} No further Blink login attempts will be sent until the adapter is restarted. ` +
						`Enter the code and restart the adapter.`,
				);

				err.code = err.code || 'NEED_2FA';
				throw err;
			}

			if (this.isCredentialError(err)) {
				this.loginFailureCount += 1;

				this.log.warn(
					`Blink login failed (${this.loginFailureCount}/${this.maxLoginFailures}): ${err?.message || err}`,
				);

				if (this.loginFailureCount >= this.maxLoginFailures) {
					this.loginBlocked = true;
					this.session = null;
					this.stopLoginRelatedTimers();
					this.setState('info.connection', false, true);
					this.log.error(
						`Blink login was stopped after ${this.maxLoginFailures} failed attempts. ` +
							`No further login attempts will be started to avoid a Blink lockout. ` +
							`Please check email/password/PIN and restart the adapter.`,
					);
				}
			}

			throw err;
		}
	}

	isBlinkSystemBusyError(err) {
		const msg = String(err?.message || err || '').toLowerCase();

		return (
			msg.includes('system is busy') ||
			msg.includes('http 409') ||
			msg.includes('status 409') ||
			msg.includes('"code":307') ||
			msg.includes('code 307') ||
			msg.includes('code=307')
		);
	}

	getVideoBusyRemainingMs(devId) {
		const until = this.videoBusyUntilByDevId.get(devId) || 0;
		if (!until) {
			return 0;
		}
		const remaining = until - Date.now();
		if (remaining <= 0) {
			this.videoBusyUntilByDevId.delete(devId);
			return 0;
		}
		return remaining;
	}

	isVideoBusyCooldownActive(devId) {
		return this.getVideoBusyRemainingMs(devId) > 0;
	}

	async markVideoBusy(devId, cam, err) {
		const until = Date.now() + this.videoBusyCooldownMs;
		this.videoBusyUntilByDevId.set(devId, until);

		const retryAt = new Date(until).toISOString();
		const msg = `System is busy, retry after ${retryAt}`;

		try {
			await this.setStateAsync(`cameras.${devId}.video.ready`, false, true);
			await this.setStateAsync(`cameras.${devId}.video.lastError`, msg, true);
		} catch (stateErr) {
			this.log.debug(
				`Video busy state could not be set (${cam?.name || devId}): ${stateErr?.message || stateErr}`,
			);
		}

		this.log.info(`Video download paused for ${cam?.name || devId}: ${msg} (${err?.message || err})`);
	}

	async writeVideoBusyCooldownState(devId, cam) {
		const until = this.videoBusyUntilByDevId.get(devId) || 0;
		if (!until) {
			return;
		}

		const retryAt = new Date(until).toISOString();
		const msg = `System is busy cooldown active until ${retryAt}`;

		await this.setStateAsync(`cameras.${devId}.video.ready`, false, true);
		await this.setStateAsync(`cameras.${devId}.video.lastError`, msg, true);

		this.log.info(`Video download still paused for ${cam?.name || devId}: ${msg}`);
	}

	isUsableFile(file) {
		try {
			if (!file) {
				return false;
			}
			const st = fs.statSync(file);
			return st.isFile() && st.size > 0;
		} catch {
			return false;
		}
	}

	fileSize(file) {
		try {
			return fs.statSync(file).size || 0;
		} catch {
			return 0;
		}
	}

	getLocalStorageBusyRemainingMs(syncId) {
		const key = String(syncId || '');
		if (!key) {
			return 0;
		}

		const until = this.localStorageBusyUntilBySyncId.get(key) || 0;
		if (!until) {
			return 0;
		}

		const remaining = until - Date.now();
		if (remaining <= 0) {
			this.localStorageBusyUntilBySyncId.delete(key);
			this.log.info(`Local Storage/USB cooldown expired for sync module ${key}, will retry on the next fetch.`);
			return 0;
		}

		return remaining;
	}

	isLocalStorageBusyCooldownActive(syncId) {
		return this.getLocalStorageBusyRemainingMs(syncId) > 0;
	}

	markLocalStorageBusy(syncId, networkId, err) {
		const key = String(syncId || '');
		if (!key) {
			return;
		}

		const until = Date.now() + this.localStorageBusyCooldownMs;
		this.localStorageBusyUntilBySyncId.set(key, until);

		const retryAt = new Date(until).toISOString();
		this.log.info(
			`Local Storage/USB paused for sync module ${key}` +
				`${networkId ? ` network_id=${networkId}` : ''}: System is busy, retry after ${retryAt} (${err?.message || err})`,
		);
	}

	nameVariants(value) {
		const raw = String(value || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, ' ');
		if (!raw) {
			return new Set();
		}

		const german = raw.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

		const folded = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
		const compact = raw.replace(/[^a-z0-9]/g, '');
		const germanCompact = german.replace(/[^a-z0-9]/g, '');
		const foldedCompact = folded.replace(/[^a-z0-9]/g, '');

		return new Set([raw, german, folded, compact, germanCompact, foldedCompact].filter(Boolean));
	}

	namesMatch(a, b) {
		const av = this.nameVariants(a);
		const bv = this.nameVariants(b);

		for (const v of av) {
			if (bv.has(v)) {
				return true;
			}
		}

		return false;
	}

	getClipCameraIds(clip) {
		const values = [
			clip?.camera_id,
			clip?.cameraId,
			clip?.device_id,
			clip?.deviceId,
			clip?.device,
			clip?.camera?.id,
			clip?.camera?.camera_id,
			clip?.metadata?.camera_id,
			clip?.metadata?.device_id,
		];

		return values.filter(v => v !== null && v !== undefined && v !== '').map(v => String(v));
	}

	getClipCameraNames(clip) {
		const values = [
			clip?.camera_name,
			clip?.cameraName,
			clip?.device_name,
			clip?.deviceName,
			clip?.camera?.name,
			clip?.metadata?.camera_name,
			clip?.metadata?.device_name,
		];

		return values.filter(v => v !== null && v !== undefined && v !== '').map(v => String(v));
	}

	getClipId(clip) {
		return String(
			clip?.id || clip?.clip_id || clip?.clipId || clip?.video_id || clip?.videoId || clip?.media_id || '',
		);
	}

	getClipTimestamp(clip) {
		return String(
			clip?.created_at ||
				clip?.createdAt ||
				clip?.timestamp ||
				clip?.time ||
				clip?.date ||
				clip?.updated_at ||
				'',
		);
	}

	isClipForCamera(clip, cam) {
		const camId = String(cam?.id || '');
		if (camId) {
			const clipIds = this.getClipCameraIds(clip);
			if (clipIds.some(id => id === camId)) {
				return true;
			}
		}

		const camName = String(cam?.name || '');
		if (!camName) {
			return false;
		}

		const clipNames = this.getClipCameraNames(clip);
		return clipNames.some(name => this.namesMatch(name, camName));
	}

	sortClipsNewestFirst(clips) {
		return [...(clips || [])].sort((a, b) => {
			const ta = Date.parse(this.getClipTimestamp(a)) || 0;
			const tb = Date.parse(this.getClipTimestamp(b)) || 0;
			return tb - ta;
		});
	}

	findLocalClipsForCamera(localManifest, cam) {
		const clips = Array.isArray(localManifest?.clips) ? localManifest.clips : [];
		return this.sortClipsNewestFirst(clips.filter(clip => this.isClipForCamera(clip, cam)));
	}

	logLocalStorageNames(localManifest, cam, syncId) {
		const clips = Array.isArray(localManifest?.clips) ? localManifest.clips : [];
		const names = [...new Set(clips.flatMap(clip => this.getClipCameraNames(clip)).filter(Boolean))].slice(0, 20);

		const ids = [...new Set(clips.flatMap(clip => this.getClipCameraIds(clip)).filter(Boolean))].slice(0, 20);

		this.log.debug(
			`Local Storage: no clips matching "${cam?.name || ''}" id=${cam?.id || ''} sync=${syncId || ''}. ` +
				`manifest cameras: names=[${names.join(', ')}], ids=[${ids.join(', ')}]`,
		);
	}

	async getLocalStorageManifestCached(networkId, syncId, manifestCacheBySyncId = null) {
		if (!syncId) {
			return null;
		}

		const key = String(syncId);
		if (manifestCacheBySyncId && manifestCacheBySyncId.has(key)) {
			return manifestCacheBySyncId.get(key);
		}

		if (this.isLocalStorageBusyCooldownActive(key)) {
			if (manifestCacheBySyncId) {
				manifestCacheBySyncId.set(key, null);
			}
			return null;
		}

		try {
			const manifest = await blinkApi.getLocalStorageClips(this.session, networkId, syncId);
			if (manifestCacheBySyncId) {
				manifestCacheBySyncId.set(key, manifest);
			}
			return manifest;
		} catch (e) {
			if (this.isBlinkSystemBusyError(e)) {
				this.markLocalStorageBusy(key, networkId, e);
				if (manifestCacheBySyncId) {
					manifestCacheBySyncId.set(key, null);
				}
				return null;
			}

			this.log.debug(`Local Storage manifest not available (sync ${syncId}): ${e?.message || e}`);

			if (manifestCacheBySyncId) {
				manifestCacheBySyncId.set(key, null);
			}
			return null;
		}
	}

	async getLatestLocalClipForCamera(cam, manifestCacheBySyncId = null) {
		const syncId = this.findSyncIdForNetwork(cam?.network_id);
		if (!syncId) {
			return null;
		}

		const localManifest = await this.getLocalStorageManifestCached(cam.network_id, syncId, manifestCacheBySyncId);
		if (!localManifest) {
			return null;
		}

		const matches = this.findLocalClipsForCamera(localManifest, cam);
		if (!matches.length) {
			this.logLocalStorageNames(localManifest, cam, syncId);
			return { syncId, localManifest, localClip: null };
		}

		return {
			syncId,
			localManifest,
			localClip: matches[0],
		};
	}

	async downloadNewestVideoLocalFirst(cam, devId, file, manifestCacheBySyncId = null) {
		const local = await this.getLatestLocalClipForCamera(cam, manifestCacheBySyncId);
		if (local?.localClip) {
			const clipId = this.getClipId(local.localClip);
			try {
				const res = await blinkApi.downloadLocalClip(
					this.session,
					cam.network_id,
					local.syncId,
					local.localManifest.manifestId,
					clipId,
					file,
				);

				return {
					...res,
					source: 'local_storage',
					id: clipId,
					created_at: this.getClipTimestamp(local.localClip),
					localManifest: local.localManifest,
					localClip: local.localClip,
				};
			} catch (e) {
				if (this.isBlinkSystemBusyError(e)) {
					this.markLocalStorageBusy(local.syncId, cam.network_id, e);
					// USB/Local-Storage ist beschäftigt; Cloud bleibt als Fallback erlaubt.
				} else {
					throw e;
				}
			}
		}

		try {
			const latest = await blinkApi.getLatestVideoInfo(this.session, cam.network_id, cam.id);
			if (!latest) {
				throw new Error('No video found in Local Storage or cloud');
			}
			return await blinkApi.downloadVideo(this.session, cam.network_id, cam.id, file, latest);
		} catch (e) {
			if (e?.code === 'NO_VIDEO') {
				throw new Error('No video found in Local Storage or cloud');
			}
			throw e;
		}
	}

	async onReady() {
		const debugLogEnabled = this.config.debugLogEnabled === true;
		blinkApi.setDebugEnabled(debugLogEnabled);

		try {
			fs.rmSync('/tmp/blink_debug.log', { force: true });
		} catch {
			// Datei existiert evtl. nicht – das ist kein Fehler.
		}

		this.setState('info.connection', false, true);

		const email = (this.config.email || '').trim();
		const password = this.config.password || '';
		let pin = this.config.pin || '';
		const pollIntervalSec = Math.max(15, Number(this.config.pollIntervalSec) || 60);
		const snapshotDir = (this.config.snapshotDir || '/opt/iobroker/iobroker-data/blink').trim();
		const liveSnapshotEnabled = this.config.liveSnapshotEnabled !== false;
		const liveSnapshotIntervalSec = Math.max(5, Number(this.config.liveSnapshotIntervalSec) || 30);
		const storeBase64 = this.config.storeBase64 !== false;
		const cleanupOldSnapshots = this.config.cleanupOldSnapshots !== false;
		const maxSnapshotAgeHours = Math.max(1, Number(this.config.maxSnapshotAgeHours) || 24);
		const archiveEnabled = this.config.archiveEnabled === true;
		const archiveDir = (this.config.archiveDir || '/opt/iobroker/iobroker-data/blink-archive').trim();
		const archiveCreateCameraFolders = this.config.archiveCreateCameraFolders !== false;
		const archiveMaxClipsPerCamera = Math.max(1, Math.min(500, Number(this.config.archiveMaxClipsPerCamera) || 50));
		const batteryWarningEnabled = this.config.batteryWarningEnabled === true;
		const batteryWarningThresholdVolt = Number(this.config.batteryWarningThresholdVolt) || 1.1;
		const batteryWarningCooldownHours = Math.max(1, Number(this.config.batteryWarningCooldownHours) || 24);

		// Benachrichtigungskanäle – getrennt pro Auslöser (Batterie / Bewegung).
		// Jeder Kanal ist einzeln aktivierbar; alle aktivierten werden bedient.
		const notify = {
			battery: {
				telegram: {
					enabled: this.config.battery_telegram_enabled === true,
					instance: (this.config.battery_telegram_instance || 'telegram.0').trim(),
					users: (this.config.battery_telegram_users || '').trim(),
				},
				pushover: {
					enabled: this.config.battery_pushover_enabled === true,
					instance: (this.config.battery_pushover_instance || 'pushover.0').trim(),
				},
				email: {
					enabled: this.config.battery_email_enabled === true,
					instance: (this.config.battery_email_instance || 'email.0').trim(),
					to: (this.config.battery_email_to || '').trim(),
				},
			},
			motion: {
				enabled: this.config.motionNotifyEnabled === true,
				cooldownMinutes: Math.max(1, Number(this.config.motionNotifyCooldownMinutes) || 5),
				telegram: {
					enabled: this.config.motion_telegram_enabled === true,
					instance: (this.config.motion_telegram_instance || 'telegram.0').trim(),
					users: (this.config.motion_telegram_users || '').trim(),
				},
				pushover: {
					enabled: this.config.motion_pushover_enabled === true,
					instance: (this.config.motion_pushover_instance || 'pushover.0').trim(),
				},
				email: {
					enabled: this.config.motion_email_enabled === true,
					instance: (this.config.motion_email_instance || 'email.0').trim(),
					to: (this.config.motion_email_to || '').trim(),
				},
			},
		};

		// MJPEG-Streaming-Konfiguration (alle Felder optional, Streaming ist opt-in)
		const streamEnabled = this.config.streamEnabled === true;
		const streamPort = Math.max(1024, Math.min(65535, Number(this.config.streamPort) || 8089));
		const hlsPort = Math.max(1024, Math.min(65535, Number(this.config.hlsPort) || streamPort + 1));
		let streamToken = (this.config.streamToken || '').trim();
		const streamPublicHost = (this.config.streamPublicHost || '').trim();
		const streamWiredIntervalSec = Math.max(5, Number(this.config.streamWiredIntervalSec) || 8);
		const streamBatteryIntervalSec = Math.max(8, Number(this.config.streamBatteryIntervalSec) || 10);
		const streamBatteryIdleTimeoutSec = Math.max(15, Number(this.config.streamBatteryIdleTimeoutSec) || 60);
		const streamBatteryMinLevel = Math.max(0, Math.min(3, this.toNum(this.config.streamBatteryMinLevel) ?? 2));
		const ffmpegPath = (this.config.ffmpegPath || '').trim();

		// Token automatisch generieren, wenn leer und Streaming aktiv – und in
		// der eigenen Adapter-Konfiguration persistieren, damit der Token nach
		// einem Restart stabil bleibt und in der Admin-UI erscheint.
		if (streamEnabled && !streamToken) {
			streamToken = crypto.randomBytes(16).toString('hex');
			this.log.info('Stream token was generated automatically and saved to the adapter configuration.');
			try {
				await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
					native: { streamToken },
				});
			} catch (e) {
				this.log.warn(
					`Stream token could not be persisted; a new one will be generated on the next restart: ${e?.message || e}`,
				);
			}
		}

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
			archiveEnabled,
			archiveDir,
			archiveCreateCameraFolders,
			archiveMaxClipsPerCamera,
			batteryWarningEnabled,
			batteryWarningThresholdVolt,
			batteryWarningCooldownHours,
			notify,
			streamEnabled,
			streamPort,
			hlsPort,
			streamToken,
			streamPublicHost,
			streamWiredIntervalSec,
			streamBatteryIntervalSec,
			streamBatteryIdleTimeoutSec,
			streamBatteryMinLevel,
			ffmpegPath,
		};

		await this.ensureRootObjects();

		if (!email || !password) {
			this.log.error('Please enter email and password in the adapter configuration.');
			return;
		}

		try {
			fs.mkdirSync(snapshotDir, { recursive: true });
		} catch {
			// Verzeichnis existiert bereits oder kann nicht angelegt werden – beim Schreiben fällt das ohnehin auf.
		}

		await this.updateArchiveAvailabilityState();

		await this.setObjectNotExistsAsync('info.connection', {
			type: 'state',
			common: { name: 'Connected', type: 'boolean', role: 'indicator.connected', read: true, write: false },
			native: {},
		});

		await this.setObjectNotExistsAsync('info.account_id', {
			type: 'state',
			common: { name: 'Blink Account-ID', type: 'string', role: 'text', read: true, write: false },
			native: {},
		});

		try {
			await this.installBlinkVideoUrlServerScript();
		} catch (e) {
			this.log.warn(`Blink video URL server script could not be installed: ${e?.message || e}`);
		}

		this.subscribeStates('cameras.*.commands.*');
		this.subscribeStates('sync.*.commands.*');

		try {
			this.session = await this.getBlinkSessionSafe(email, password, pin);
			pin = this.cfg?.pin || '';
			await this.pollOnce();
			if (cleanupOldSnapshots) {
				this.cleanupSnapshots();
			}
			this.setState('info.connection', true, true);
			if (this.cfg.streamEnabled) {
				await this.startMjpegServer();
			}
		} catch (e) {
			this.log.error(`Initial connect/poll failed: ${e?.message || e}`);
			this.setState('info.connection', false, true);
		}

		this.pollTimer = this.setInterval(async () => {
			try {
				pin = this.cfg?.pin || '';
				this.session = await this.getBlinkSessionSafe(email, password, pin);
				await this.pollOnce();
			} catch (err) {
				if (err?.code === 'LOGIN_RATE_LIMIT_ACTIVE' || err?.code === 'LOGIN_2FA_REQUIRED_ACTIVE') {
					this.log.debug(err.message);
					this.setState('info.connection', false, true);
					return;
				}
				this.log.warn(`Poll error: ${err?.message || err}`);
				this.setState('info.connection', false, true);
			}
		}, pollIntervalSec * 1000);

		if (liveSnapshotEnabled) {
			const scheduleLiveSnapshots = () => {
				this.liveTimer = this.setTimeout(async () => {
					try {
						await this.updateLiveSnapshots();
					} catch (e) {
						this.log.warn(`Live snapshot error: ${e?.message || e}`);
					}
					if (this.liveTimer) {
						scheduleLiveSnapshots();
					}
				}, liveSnapshotIntervalSec * 1000);
			};
			scheduleLiveSnapshots();
		}
	}

	async installBlinkVideoUrlServerScript() {
		const scriptId = 'script.js.common.blink-video-url-server';
		const sourceFile = path.join(__dirname, 'lib', 'blink-video-url-server.json');

		try {
			if (!fs.existsSync(sourceFile)) {
				this.log.warn(`Blink video URL server template not found: ${sourceFile}`);
				return;
			}

			const raw = fs.readFileSync(sourceFile, 'utf8');
			let parsed = null;
			let source = '';
			let template = null;

			try {
				parsed = JSON.parse(raw);
			} catch {
				// Fallback: Falls die Datei trotz .json-Endung reinen JavaScript-Code enthält,
				// wird der Dateiinhalt direkt als Script-Quelle verwendet.
				source = raw;
			}

			if (parsed !== null) {
				if (typeof parsed === 'string') {
					source = parsed;
				} else if (parsed && typeof parsed === 'object') {
					template = parsed;
					source = String(parsed?.common?.source || parsed?.source || '');
				}
			}

			if (!source.trim()) {
				this.log.warn(`Blink video URL server template contains no script source: ${sourceFile}`);
				return;
			}

			const templateVersion = String(template?.native?.scriptVersion || '');
			const existing = await this.getForeignObjectAsync(scriptId);

			if (existing) {
				const installedVersion = String(existing?.native?.scriptVersion || '');

				// Kein Update, wenn keine Versionsangabe vorhanden ist oder die installierte
				// Version bereits aktuell/neuer ist.
				if (!templateVersion || this.compareVersions(templateVersion, installedVersion) <= 0) {
					this.log.debug(
						`Blink video URL server script is current (installed: ${installedVersion || 'unknown'}, template: ${templateVersion || 'unknown'}); no update.`,
					);
					return;
				}

				// Schutz vor Überschreiben manueller Anpassungen:
				// Wenn der Nutzer das Script verändert hat (keine von uns gesetzte Version,
				// oder Marker fehlt), NICHT automatisch überschreiben, sondern nur hinweisen.
				if (!installedVersion) {
					this.log.warn(
						`Blink video URL server script exists without a version marker and was probably modified manually. ` +
							`Automatic update is skipped to avoid overwriting custom changes. ` +
							`Update the script manually from lib/blink-video-url-server.json if needed.`,
					);
					return;
				}

				// Update durchführen: Quellcode + Version aktualisieren, aber den vom Nutzer
				// gewählten enabled-Zustand und dessen native-Felder beibehalten.
				const updated = {
					...existing,
					common: {
						...existing.common,
						source,
					},
					native: {
						...(existing.native || {}),
						scriptVersion: templateVersion,
					},
				};
				await this.setForeignObjectAsync(scriptId, updated);
				this.log.info(`Blink video URL server script updated: ${installedVersion} → ${templateVersion}.`);
				return;
			}

			// Script existiert noch nicht: frisch anlegen.
			const obj = {
				type: 'script',
				common: {
					name: template?.common?.name || template?.name || 'blink-video-url-server',
					enabled: template?.common?.enabled === true,
					engine: template?.common?.engine || 'system.adapter.javascript.0',
					engineType: template?.common?.engineType || 'Javascript/js',
					source,
					debug: template?.common?.debug === true,
					verbose: template?.common?.verbose === true,
				},
				native: {
					...(template?.native || {}),
					scriptVersion: templateVersion,
				},
			};

			await this.setForeignObjectAsync(scriptId, obj);
			this.log.info(
				`Blink video URL server script was created (Version ${templateVersion || 'unknown'}): ${scriptId}`,
			);
		} catch (e) {
			this.log.warn(`Blink video URL server script could not be created/updated: ${e?.message || e}`);
		}
	}

	/**
	 * Vergleicht zwei Versionsstrings im Format x.y.z.
	 *
	 * @param {string} a - Erste Version.
	 * @param {string} b - Zweite Version.
	 * @returns {number} >0 wenn a neuer als b, <0 wenn a älter, 0 wenn gleich.
	 */
	compareVersions(a, b) {
		const pa = String(a || '0')
			.split('.')
			.map(n => parseInt(n, 10) || 0);
		const pb = String(b || '0')
			.split('.')
			.map(n => parseInt(n, 10) || 0);
		const len = Math.max(pa.length, pb.length);
		for (let i = 0; i < len; i++) {
			const da = pa[i] || 0;
			const db = pb[i] || 0;
			if (da > db) {
				return 1;
			}
			if (da < db) {
				return -1;
			}
		}
		return 0;
	}

	findSyncIdForNetwork(networkId) {
		for (const mod of this.syncById.values()) {
			if (String(mod?.network_id) === String(networkId)) {
				return mod?.sync_id || null;
			}
		}
		return null;
	}

	async ensureRootObjects() {
		await this.setObjectNotExistsAsync('info', {
			type: 'channel',
			common: { name: 'Info' },
			native: {},
		});

		await this.setObjectNotExistsAsync('cameras', {
			type: 'channel',
			common: { name: 'Cameras' },
			native: {},
		});

		await this.setObjectNotExistsAsync('sync', {
			type: 'channel',
			common: { name: 'Sync modules' },
			native: {},
		});

		await this.setObjectNotExistsAsync('archive', {
			type: 'channel',
			common: { name: 'Video archive' },
			native: {},
		});

		await this.ensureState('archive.enabled', 'Archive enabled', 'boolean', 'indicator', false);
		await this.ensureState('archive.available', 'Archive available', 'boolean', 'indicator', false);
		await this.ensureState('archive.directory', 'Archive directory', 'string', 'text', false);
		await this.ensureState('archive.lastFile', 'Last archived source file', 'string', 'text', false);
		await this.ensureState('archive.lastTarget', 'Last archive target file', 'string', 'text', false);
		await this.ensureState('archive.lastSuccess', 'Last archive success', 'string', 'date', false);
		await this.ensureState('archive.lastError', 'Last archive error', 'string', 'text', false);
	}

	async pollOnce() {
		await this.ensureRootObjects();

		const { cameras, syncModules, accountId } = await blinkApi.getDevices(this.session);

		// Account-ID in einen State schreiben, damit externe Helfer (z. B. das
		// blink-video-url-server-Script) sie zuverlässig finden, auch wenn noch
		// nie eine LiveView-Session lief.
		if (accountId) {
			await this.setStateAsync('info.account_id', String(accountId), true);
		}

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
			await this.setCameraStates(base, cam, devId, accountId);

			// Modellbasierte LiveView-Erkennung (deterministisch, aus der Blink-API):
			// Klassische Modelle (white/xt/xt2) unterstützen keinen echten LiveView.
			// liveViewCapable wird von blink-api.js anhand des Homescreen-Typs gesetzt.
			if (cam.liveViewCapable === false) {
				await this.setStateAsync(`${base}.live.unsupported`, true, true);
			} else if (cam.liveViewCapable === true) {
				// Modernes Modell: sicherstellen, dass kein veralteter Marker hängenbleibt.
				const cur = await this.getStateAsync(`${base}.live.unsupported`);
				if (cur && cur.val === true) {
					await this.setStateAsync(`${base}.live.unsupported`, false, true);
				}
			}
		}

		await this.syncLatestCloudVideos(cameras);
		this.setState('info.connection', true, true);

		if (this.mjpegServer) {
			await this.refreshMjpegCameraRegistry();
		}
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
		await this.ensureState(`${base}.info.network_id`, 'Network ID', 'number', 'value', false);
		await this.ensureState(`${base}.info.type`, 'Camera model (Blink type)', 'string', 'text', false);
		await this.ensureState(`${base}.info.account_id`, 'Account-ID', 'string', 'text', false);

		await this.ensureState(`${base}.status.battery`, 'Battery (V)', 'number', 'value.battery', false);
		await this.ensureState(`${base}.status.battery_raw`, 'Raw battery', 'number', 'value', false);
		await this.ensureState(`${base}.status.battery_volt`, 'Battery voltage (V)', 'number', 'value.voltage', false);
		await this.ensureState(`${base}.status.battery_text`, 'Battery note', 'string', 'text', false);
		await this.ensureState(`${base}.status.temperature`, 'Temperature (°C)', 'number', 'value.temperature', false);
		await this.ensureState(
			`${base}.status.temperature_f`,
			'Temperature (°F)',
			'number',
			'value.temperature',
			false,
		);
		await this.ensureState(`${base}.status.temperature_text`, 'Temperature note', 'string', 'text', false);
		await this.ensureState(`${base}.status.wifi_strength`, 'Wi-Fi strength', 'number', 'value', false);
		await this.ensureState(
			`${base}.status.motion_detect_enabled`,
			'Motion detection',
			'boolean',
			'indicator',
			false,
		);
		await this.ensureState(`${base}.status.armed`, 'Armed (system)', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.last_update`, 'Last update', 'string', 'date', false);
		await this.ensureState(
			`${base}.status.smart_detection`,
			'Smart Detection aktiv',
			'boolean',
			'indicator',
			false,
		);
		await this.ensureState(`${base}.status.person_detected`, 'Person detected', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.vehicle_detected`, 'Vehicle detected', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.animal_detected`, 'Animal detected', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.package_detected`, 'Package detected', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.detection_type`, 'Detection type', 'string', 'text', false);
		await this.ensureState(
			`${base}.status.smart_detection_raw`,
			'Smart Detection raw data',
			'string',
			'json',
			false,
		);
		await this.ensureState(`${base}.status.motion_source`, 'Motion source', 'string', 'text', false);

		await this.ensureState(`${base}.battery.low`, 'Battery low', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.battery.lastWarning`, 'Last warning', 'string', 'date', false);
		await this.ensureState(`${base}.battery.warningSent`, 'Warning sent', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.battery.lastMessage`, 'Last warning message', 'string', 'text', false);

		await this.ensureState(
			`${base}.commands.motion_detect`,
			'Set motion detection',
			'boolean',
			'switch.enable',
			true,
		);
		await this.ensureState(`${base}.commands.snapshot`, 'Trigger snapshot', 'boolean', 'button', true);
		await this.ensureState(`${base}.commands.snapshot_file`, 'Last snapshot path', 'string', 'text', false);
		await this.ensureState(`${base}.commands.fetch_video`, 'Load latest MP4', 'boolean', 'button', true);
		await this.ensureState(`${base}.commands.clear_session`, 'Clear session cache', 'boolean', 'button', true);

		await this.ensureState(`${base}.video.file`, 'MP4 file', 'string', 'text', false);
		await this.ensureState(`${base}.video.timestamp`, 'MP4 timestamp', 'string', 'date', false);
		await this.ensureState(`${base}.video.id`, 'MP4 cloud ID', 'string', 'text', false);
		await this.ensureState(`${base}.video.size`, 'MP4 file size', 'number', 'value', false);
		await this.ensureState(`${base}.video.ready`, 'MP4 ready', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.video.lastError`, 'MP4 last error', 'string', 'text', false);

		await this.setObjectNotExistsAsync(`${base}.video.history`, {
			type: 'channel',
			common: { name: 'History' },
			native: {},
		});

		for (let i = 0; i < 10; i++) {
			await this.setObjectNotExistsAsync(`${base}.video.history.${i}`, {
				type: 'channel',
				common: { name: `History ${i}` },
				native: {},
			});
		}

		// Galerie: 10 Slots pro Kamera (0 = neuester, 9 = ältester)
		for (let i = 0; i < 10; i++) {
			await this.ensureState(
				`${base}.video.history.${i}.file`,
				`History ${i} – MP4 file`,
				'string',
				'text',
				false,
			);
			await this.ensureState(
				`${base}.video.history.${i}.timestamp`,
				`History ${i} – timestamp`,
				'string',
				'date',
				false,
			);
			await this.ensureState(`${base}.video.history.${i}.id`, `History ${i} – Clip-ID`, 'string', 'text', false);
			await this.ensureState(
				`${base}.video.history.${i}.source`,
				`History ${i} – source (cloud|local_storage)`,
				'string',
				'text',
				false,
			);
		}

		await this.ensureState(`${base}.live.file`, 'Live snapshot file', 'string', 'text', false);
		await this.ensureState(`${base}.live.image_base64`, 'Live snapshot Base64', 'string', 'text', false);
		await this.ensureState(`${base}.live.mime_type`, 'Image MIME type', 'string', 'text', false);
		await this.ensureState(`${base}.live.timestamp`, 'Live snapshot timestamp', 'string', 'date', false);
		await this.ensureState(`${base}.live.stream_url`, 'MJPEG-Stream URL', 'string', 'text.url', false);
		await this.ensureState(
			`${base}.live.stream_active`,
			'Stream is currently polled',
			'boolean',
			'indicator',
			false,
		);
		await this.ensureState(
			`${base}.commands.live_request`,
			'Manually enable stream polling (60s)',
			'boolean',
			'button',
			true,
		);

		// Neues Gerüst für echten 30s-Livestream
		await this.ensureState(`${base}.live.mode`, 'Live mode', 'string', 'text', false);
		await this.ensureState(`${base}.live.active`, 'Real LiveView session active', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.live.url`, 'Live-URL', 'string', 'text.url', false);
		await this.ensureState(`${base}.live.expires_at`, 'Live expires at', 'string', 'date', false);
		await this.ensureState(`${base}.live.last_error`, 'Last live error', 'string', 'text', false);
		await this.ensureState(`${base}.live.session_id`, 'Live session ID', 'string', 'text', false);
		await this.ensureState(`${base}.live.backend`, 'Live Backend', 'string', 'text', false);
		await this.ensureState(
			`${base}.live.unsupported`,
			'LiveView is not supported by this camera (self-learning)',
			'boolean',
			'indicator',
			false,
		);

		await this.ensureState(`${base}.commands.start_live`, 'Start real live stream', 'boolean', 'button', true);
		await this.ensureState(`${base}.commands.stop_live`, 'Stop real live stream', 'boolean', 'button', true);

		await this.initStateIfUnset(`${base}.status.armed`, false);
		await this.initStateIfUnset(`${base}.status.battery_text`, '');
		await this.initStateIfUnset(`${base}.status.temperature_text`, '');
		await this.initStateIfUnset(`${base}.status.smart_detection`, false);
		await this.initStateIfUnset(`${base}.status.person_detected`, false);
		await this.initStateIfUnset(`${base}.status.vehicle_detected`, false);
		await this.initStateIfUnset(`${base}.status.animal_detected`, false);
		await this.initStateIfUnset(`${base}.status.package_detected`, false);
		await this.initStateIfUnset(`${base}.status.detection_type`, '');
		await this.initStateIfUnset(`${base}.status.smart_detection_raw`, '');
		await this.initStateIfUnset(`${base}.status.motion_source`, '');
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
		for (let i = 0; i < 10; i++) {
			await this.initStateIfUnset(`${base}.video.history.${i}.file`, '');
			await this.initStateIfUnset(`${base}.video.history.${i}.timestamp`, '');
			await this.initStateIfUnset(`${base}.video.history.${i}.id`, '');
			await this.initStateIfUnset(`${base}.video.history.${i}.source`, '');
		}
		await this.initStateIfUnset(`${base}.live.file`, '');
		await this.initStateIfUnset(`${base}.live.image_base64`, '');
		await this.initStateIfUnset(`${base}.live.mime_type`, '');
		await this.initStateIfUnset(`${base}.live.timestamp`, '');
		await this.initStateIfUnset(`${base}.live.stream_url`, '');
		await this.initStateIfUnset(`${base}.live.stream_active`, false);
		await this.initStateIfUnset(`${base}.commands.live_request`, false);

		await this.initStateIfUnset(`${base}.live.mode`, 'idle');
		await this.initStateIfUnset(`${base}.live.active`, false);
		await this.initStateIfUnset(`${base}.live.url`, '');
		await this.initStateIfUnset(`${base}.live.expires_at`, '');
		await this.initStateIfUnset(`${base}.live.last_error`, '');
		await this.initStateIfUnset(`${base}.live.session_id`, '');
		await this.initStateIfUnset(`${base}.live.backend`, '');
		await this.initStateIfUnset(`${base}.live.unsupported`, false);
		await this.initStateIfUnset(`${base}.commands.start_live`, false);
		await this.initStateIfUnset(`${base}.commands.stop_live`, false);
	}

	async setCameraStates(base, cam, devId, accountId) {
		await this.setStateAsync(`${base}.info.name`, String(cam.name || ''), true);
		await this.setStateAsync(`${base}.info.serial`, String(cam.serial || ''), true);
		await this.setNumStateIfValid(`${base}.info.network_id`, cam.network_id);

		const apiType = String(cam.apiType || '').toLowerCase();
		const nameLc = String(cam.name || '').toLowerCase();
		const serialLc = String(cam.serial || '').toLowerCase();

		// apiType (owl/doorbell/camera) als State, damit externe Helfer (z. B. das
		// blink-video-url-server-Script) den korrekten LiveView-Endpoint wählen.
		await this.setStateAsync(`${base}.info.type`, apiType || 'camera', true);
		// Account-ID pro Kamera spiegeln (das JS-Script sucht u. a. hier).
		if (accountId) {
			await this.setStateAsync(`${base}.info.account_id`, String(accountId), true);
		}

		await this.setNumStateIfValid(`${base}.status.battery`, cam.battery_volt);
		await this.setNumStateIfValid(`${base}.status.battery_raw`, cam.battery_raw);
		await this.setNumStateIfValid(`${base}.status.battery_volt`, cam.battery_volt);

		const batteryVolt = this.toNum(cam.battery_volt);
		const batteryRaw = this.toNum(cam.battery_raw);

		const noBatteryDevice =
			apiType === 'owl' ||
			apiType === 'mini' ||
			nameLc.includes('pantilt') ||
			nameLc.includes('pan tilt') ||
			nameLc.includes('blink mini') ||
			nameLc.includes('mini') ||
			serialLc.includes('mini');

		const noBatteryData =
			(batteryVolt === null && batteryRaw === null) ||
			((batteryVolt === 0 || batteryVolt === null) && (batteryRaw === 0 || batteryRaw === null));

		if (noBatteryDevice && noBatteryData) {
			await this.setStateAsync(`${base}.status.battery`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.battery_raw`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.battery_volt`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.battery_text`, 'not available', true);
		} else {
			await this.setStateAsync(`${base}.status.battery_text`, '', true);
		}

		const tempC = this.toNum(cam.temperature);
		const tempF = this.toNum(cam.temperature_f);

		const noTemperatureDevice =
			apiType === 'owl' ||
			apiType === 'mini' ||
			nameLc.includes('pantilt') ||
			nameLc.includes('pan tilt') ||
			nameLc.includes('blink mini') ||
			nameLc.includes('mini') ||
			serialLc.includes('mini');

		const noTemperatureData =
			(tempC === null && tempF === null) || ((tempC === 0 || tempC === null) && (tempF === 0 || tempF === null));

		const doorbellNoTemp =
			apiType === 'doorbell' &&
			((tempC === null && tempF === null) ||
				((tempC === 0 || tempC === null) && (tempF === 0 || tempF === null)));

		if (doorbellNoTemp || (noTemperatureDevice && noTemperatureData)) {
			await this.setStateAsync(`${base}.status.temperature`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.temperature_f`, { val: null, ack: true });
			await this.setStateAsync(`${base}.status.temperature_text`, 'not available', true);
		} else {
			if (tempC !== null) {
				await this.setStateAsync(`${base}.status.temperature`, tempC, true);
			}
			if (tempF !== null) {
				await this.setStateAsync(`${base}.status.temperature_f`, tempF, true);
			}
			await this.setStateAsync(`${base}.status.temperature_text`, '', true);
		}

		await this.setNumStateIfValid(`${base}.status.wifi_strength`, cam.wifi_strength);
		await this.setBoolStateIfDefined(`${base}.status.motion_detect_enabled`, cam.motion_detect_enabled);
		await this.setStateAsync(`${base}.status.smart_detection`, !!cam.smart_detection, true);
		await this.setStateAsync(`${base}.status.person_detected`, !!cam.person_detected, true);
		await this.setStateAsync(`${base}.status.vehicle_detected`, !!cam.vehicle_detected, true);
		await this.setStateAsync(`${base}.status.animal_detected`, !!cam.animal_detected, true);
		await this.setStateAsync(`${base}.status.package_detected`, !!cam.package_detected, true);
		await this.setStateAsync(`${base}.status.detection_type`, String(cam.detection_type || ''), true);
		await this.setStateAsync(`${base}.status.smart_detection_raw`, String(cam.smart_detection_raw || ''), true);
		await this.setStateAsync(`${base}.status.motion_source`, String(cam.motion_source || ''), true);

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
		await this.setStateAsync(`${base}.commands.start_live`, false, true);
		await this.setStateAsync(`${base}.commands.stop_live`, false, true);
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
		await this.ensureState(`${base}.status.armed`, 'Armed', 'boolean', 'indicator', false);
		await this.ensureState(`${base}.status.last_update`, 'Last update', 'string', 'date', false);
		await this.ensureState(`${base}.commands.armed`, 'Arm/disarm', 'boolean', 'switch.enable', true);

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
				await blinkApi.snapshot(this.session, cam.network_id, cam.id, cam.thumbnail, file, cam.apiType);
				await this.setLiveStates(devId, file);
				if (this.mjpegServer) {
					try {
						const buf = fs.readFileSync(file);
						this.mjpegServer.pushSnapshot(devId, buf);
					} catch {
						// Cache-Push ist optional – Fehler nicht eskalieren.
					}
				}
			} catch (e) {
				const msg = String(e?.message || e);
				if (msg.includes('HTTP 409') && msg.includes('System is busy')) {
					this.log.debug(`Live snapshot skipped for ${cam.name}: ${msg}`);
				} else {
					this.log.warn(`Live snapshot error for ${cam.name}: ${msg}`);
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
			} catch {
				// base64-State ist optional – Lesefehler nicht eskalieren.
			}
		}
	}

	resolveStreamHost() {
		const override = (this.cfg.streamPublicHost || '').trim();
		if (override) {
			return override;
		}
		try {
			const hn = (os.hostname() || '').trim();
			if (hn && hn.toLowerCase() !== 'localhost') {
				return hn;
			}
		} catch {
			// Hostname-Auflösung failed – weiter mit IP-Detection.
		}
		try {
			const ifaces = os.networkInterfaces();
			for (const list of Object.values(ifaces)) {
				for (const addr of list || []) {
					if (addr.family === 'IPv4' && !addr.internal && addr.address) {
						return addr.address;
					}
				}
			}
		} catch {
			// Netzwerk-Interfaces nicht ermittelbar.
		}
		return 'localhost';
	}

	async startHlsServer() {
		if (this.hlsServer) {
			return;
		}
		const port = Number(this.cfg.hlsPort) || Number(this.cfg.streamPort) + 1 || 8090;
		const rootDir = path.join(this.cfg.snapshotDir, 'live');
		const MIME = {
			'.m3u8': 'application/vnd.apple.mpegurl',
			'.ts': 'video/mp2t',
			'.m4s': 'video/iso.segment',
			'.mp4': 'video/mp4',
		};

		this.hlsServer = http.createServer((req, res) => {
			try {
				res.setHeader('Access-Control-Allow-Origin', '*');
				res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
				if (req.method === 'OPTIONS') {
					res.writeHead(204);
					res.end();
					return;
				}

				const u = new URL(req.url, `http://127.0.0.1:${port}`);
				const m = u.pathname.match(/^\/live\/([^/]+)\/([^/]+)$/);
				if (!m) {
					res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end('Not found');
					return;
				}
				const devId = decodeURIComponent(m[1]);
				const filename = decodeURIComponent(m[2]);
				if (!/^[A-Za-z0-9_.-]+$/.test(filename)) {
					res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end('Forbidden');
					return;
				}
				const filePath = path.join(rootDir, devId, filename);
				const normRoot = path.resolve(rootDir);
				const normPath = path.resolve(filePath);
				if (!normPath.startsWith(normRoot + path.sep) && normPath !== normRoot) {
					res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end('Forbidden');
					return;
				}
				fs.stat(normPath, (err, stat) => {
					if (err || !stat.isFile()) {
						res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
						res.end('File Not Found');
						return;
					}
					const ext = path.extname(filename).toLowerCase();
					res.writeHead(200, {
						'Content-Type': MIME[ext] || 'application/octet-stream',
						'Content-Length': stat.size,
						'Cache-Control': 'no-cache, no-store, must-revalidate',
						Pragma: 'no-cache',
						Expires: '0',
					});
					fs.createReadStream(normPath).pipe(res);
				});
			} catch (e) {
				res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end(String(e?.message || e));
			}
		});

		await new Promise((resolve, reject) => {
			this.hlsServer.once('error', reject);
			this.hlsServer.listen(port, () => resolve());
		});

		this.log.info(`HLS server: public URL base http://${this.resolveStreamHost()}:${port}/live/`);
	}

	async stopHlsServer() {
		if (!this.hlsServer) {
			return;
		}
		const srv = this.hlsServer;
		this.hlsServer = null;
		await new Promise(resolve => {
			try {
				srv.close(() => resolve());
			} catch {
				resolve();
			}
		});
	}

	resolveFfmpegBinary() {
		const configured = String(this.config.ffmpegPath || this.cfg?.ffmpegPath || '').trim();
		if (configured && fs.existsSync(configured)) {
			return configured;
		}
		const candidates = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'];
		for (const candidate of candidates) {
			try {
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			} catch {
				// ignore
			}
		}
		return 'ffmpeg';
	}

	async startMjpegServer() {
		if (this.mjpegServer) {
			return;
		}
		const publicHost = this.resolveStreamHost();
		this.log.info(`MJPEG server: public URL base http://${publicHost}:${this.cfg.streamPort}/`);

		this.mjpegServer = new MjpegServer({
			adapter: this,
			port: this.cfg.streamPort,
			token: this.cfg.streamToken,
			publicHost,
			wiredIntervalSec: this.cfg.streamWiredIntervalSec,
			batteryIntervalSec: this.cfg.streamBatteryIntervalSec,
			batteryIdleTimeoutSec: this.cfg.streamBatteryIdleTimeoutSec,
			batteryMinLevel: this.cfg.streamBatteryMinLevel,
		});

		await this.refreshMjpegCameraRegistry();

		try {
			await this.mjpegServer.start();
		} catch (e) {
			this.log.error(`MJPEG server could not start: ${e?.message || e}`);
			this.mjpegServer = null;
			return;
		}

		for (const devId of this.camerasById.keys()) {
			await this.setStateAsync(`cameras.${devId}.live.stream_url`, this.mjpegServer.streamUrl(devId), true);
		}

		this.mjpegStatusTimer = this.setInterval(() => {
			if (!this.mjpegServer) {
				return;
			}
			for (const devId of this.camerasById.keys()) {
				this.setStateAsync(`cameras.${devId}.live.stream_active`, this.mjpegServer.isActive(devId), true).catch(
					() => {},
				);
			}
		}, 5000);
	}

	async refreshMjpegCameraRegistry() {
		if (!this.mjpegServer) {
			return;
		}
		for (const [devId, cam] of this.camerasById.entries()) {
			if (!cam?.id || !cam?.network_id) {
				continue;
			}
			const apiType = String(cam.apiType || '').toLowerCase();
			const wired = apiType === 'owl' || apiType === 'mini' || apiType === 'doorbell';
			const meta = {
				name: cam.name || devId,
				apiType: apiType || 'camera',
				wired,
				batteryLevel: this.toNum(cam.battery_state) ?? null,
			};
			const fetchSnapshot = async () => {
				return await blinkApi.snapshotBuffer(this.session, cam.network_id, cam.id, cam.thumbnail, cam.apiType);
			};
			this.mjpegServer.registerCamera(devId, meta, fetchSnapshot);
		}
	}

	requestLive(devId) {
		if (!this.mjpegServer) {
			this.log.warn(`Stream request ignored: MJPEG server is not active (${devId})`);
			return;
		}
		this.mjpegServer.manualWake(devId);
	}

	async setRealLiveStates(devId, patch = {}) {
		const base = `cameras.${devId}.live`;
		if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
			await this.setStateAsync(`${base}.mode`, String(patch.mode || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'active')) {
			await this.setStateAsync(`${base}.active`, !!patch.active, true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'url')) {
			await this.setStateAsync(`${base}.url`, String(patch.url || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'expires_at')) {
			await this.setStateAsync(`${base}.expires_at`, String(patch.expires_at || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'last_error')) {
			await this.setStateAsync(`${base}.last_error`, String(patch.last_error || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'session_id')) {
			await this.setStateAsync(`${base}.session_id`, String(patch.session_id || ''), true);
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'backend')) {
			await this.setStateAsync(`${base}.backend`, String(patch.backend || ''), true);
		}
	}

	async startHlsProxy(devId, live) {
		const { spawn } = require('node:child_process');
		await this.startHlsServer();
		const outDir = path.join(this.cfg.snapshotDir, 'live', devId);
		fs.mkdirSync(outDir, { recursive: true });
		const playlist = path.join(outDir, 'index.m3u8');

		try {
			for (const f of fs.readdirSync(outDir)) {
				fs.unlinkSync(path.join(outDir, f));
			}
		} catch {
			// ignore
		}

		const args = [
			'-rtsp_transport',
			'tcp',
			'-i',
			String(live.sourceUrl || ''),
			'-an',
			'-c:v',
			'copy',
			'-t',
			'30',
			'-f',
			'hls',
			'-hls_time',
			'1',
			'-hls_list_size',
			'10',
			'-hls_flags',
			'delete_segments+append_list+independent_segments',
			'-hls_segment_filename',
			path.join(outDir, 'seg_%03d.ts'),
			playlist,
		];

		const ffmpegBin = this.resolveFfmpegBinary();
		let stderr = '';
		let spawnError = null;
		this.log.info(`ffmpeg live ${devId} starting: ${ffmpegBin}`);
		let proc;
		try {
			proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
		} catch (e) {
			throw new Error(`ffmpeg could not be started (${ffmpegBin}): ${e?.message || e}`);
		}
		proc.on('error', err => {
			spawnError = err;
		});
		proc.stderr.on('data', chunk => {
			stderr += String(chunk || '');
			if (stderr.length > 4000) {
				stderr = stderr.slice(-4000);
			}
		});
		proc.on('exit', code => {
			if (code && code !== 0) {
				this.log.warn(`ffmpeg live ${devId} exit=${code}: ${stderr.slice(-1000)}`);
			}
			this.liveProcesses.delete(devId);
		});
		this.liveProcesses.set(devId, proc);

		const start = Date.now();
		while (Date.now() - start < 10000) {
			if (spawnError) {
				throw new Error(`ffmpeg start error (${ffmpegBin}): ${spawnError?.message || spawnError}`);
			}
			if (fs.existsSync(playlist)) {
				break;
			}
			if (proc.exitCode != null && proc.exitCode !== 0) {
				throw new Error(`ffmpeg exited with code ${proc.exitCode}: ${stderr.slice(-500)}`);
			}
			await this.delay(250);
		}
		if (!fs.existsSync(playlist)) {
			throw new Error(`HLS playlist was not created: ${stderr.slice(-500)}`);
		}

		return `http://${this.resolveStreamHost()}:${this.cfg.hlsPort}/live/${encodeURIComponent(devId)}/index.m3u8`;
	}

	/**
	 * Prüft, ob eine Fehlermeldung des LiveView-Starts darauf hindeutet, dass die
	 * Kamera echten LiveView grundsätzlich nicht unterstützt (typischerweise klassische
	 * XT/XT2-Modelle, deren LiveView-Start-API keine immis://-URL zurückgibt).
	 *
	 * @param {Error|string} err - Die abgefangene Fehlermeldung.
	 * @returns {boolean} true, wenn die Cam dauerhaft als nicht unterstützt markiert werden soll.
	 */
	isLiveViewUnsupportedError(err) {
		const msg = String(err?.message || err || '').toLowerCase();
		if (!msg) {
			return false;
		}
		// Bekannte Indikatoren: Adapter-LiveView-Helper meldet fehlende immis://-URL,
		// Server-URI nicht parsebar, oder kein server-Feld in der API-Antwort.
		return (
			msg.includes('keinen gueltigen immis') ||
			msg.includes('keinen gültigen immis') ||
			msg.includes('immis:// server') ||
			msg.includes('session.server fehlt') ||
			msg.includes('server uri') ||
			msg.includes('kein server')
		);
	}

	async startRealLive(devId) {
		const cam = this.camerasById.get(devId);
		if (!cam?.id || !cam?.network_id) {
			this.log.warn(`startRealLive: camera ${devId} not found`);
			return;
		}

		await this.stopRealLive(devId, 'restart');

		await this.setRealLiveStates(devId, {
			mode: 'starting',
			active: false,
			url: '',
			expires_at: '',
			last_error: '',
			session_id: '',
			backend: '',
		});

		try {
			let backend = '';
			let publicUrl = '';
			let sessionId = '';
			let expiresAt = new Date(Date.now() + 30000).toISOString();

			let usedFallback = false;

			// Modellbasierte Vorabprüfung (schnellster Weg, kein API-Call):
			// white/xt/xt2 können keinen echten LiveView.
			const modelIncapable = cam.liveViewCapable === false;

			// Selbstlernend: wenn diese Kamera in der Vergangenheit bereits als "kann keinen
			// echten LiveView" markiert wurde, gehen wir sofort in den MJPEG-Fallback.
			const unsupportedStateId = `cameras.${devId}.live.unsupported`;
			let unsupportedCached = false;
			try {
				const cachedState = await this.getStateAsync(unsupportedStateId);
				unsupportedCached = cachedState?.val === true;
			} catch {
				// State noch nicht vorhanden – kein Problem, gilt als "nicht markiert".
			}

			if (modelIncapable || unsupportedCached) {
				this.log.debug(
					`LiveView for ${devId} (${cam.name || devId}) is not supported (model '${cam.model || '?'}'), using MJPEG fallback.`,
				);
				usedFallback = true;
			} else if (typeof blinkApi.startLiveView === 'function') {
				try {
					const live = await blinkApi.startLiveView(this.session, cam.network_id, cam.id, cam.apiType);
					backend = String(live?.backend || '');
					sessionId = String(live?.sessionId || '');
					expiresAt = String(live?.expiresAt || expiresAt);

					if (backend === 'blink_direct') {
						publicUrl = String(live?.sourceUrl || '');
					} else if (backend === 'rtsp_hls') {
						publicUrl = await this.startHlsProxy(devId, live);
					} else {
						throw new Error(`Unknown live backend: ${backend || 'empty'}`);
					}

					// Erfolg: einen evtl. zuvor gesetzten unsupported-Marker zurücknehmen.
					await this.setStateAsync(unsupportedStateId, false, true);
				} catch (e) {
					if (this.isLiveViewUnsupportedError(e)) {
						this.log.info(
							`LiveView for ${devId} (${cam.name || devId}) is permanently marked as unsupported (${e?.message || e}). Future attempts will use the MJPEG fallback directly.`,
						);
						try {
							await this.setStateAsync(unsupportedStateId, true, true);
						} catch (markErr) {
							this.log.debug(`Unsupported marker could not be set: ${markErr?.message || markErr}`);
						}
					} else {
						this.log.warn(`startLiveView failed, using MJPEG fallback for ${devId}: ${e?.message || e}`);
					}
					usedFallback = true;
				}
			} else {
				usedFallback = true;
			}

			if (usedFallback) {
				if (!this.mjpegServer) {
					throw new Error('Neither real LiveView nor MJPEG server is available');
				}
				this.requestLive(devId);
				backend = 'mjpeg_fallback';
				publicUrl = this.mjpegServer.streamUrl(devId);
				sessionId = `mjpeg-${Date.now()}`;
				expiresAt = new Date(Date.now() + 30000).toISOString();
			}

			this.liveSessions.set(devId, {
				sessionId,
				backend,
				publicUrl,
				expiresAt,
				networkId: cam.network_id,
				cameraId: cam.id,
				apiType: cam.apiType || 'camera',
			});

			await this.setRealLiveStates(devId, {
				mode: 'running',
				active: true,
				url: publicUrl,
				expires_at: expiresAt,
				session_id: sessionId,
				backend,
			});

			const t = this.setTimeout(() => {
				this.stopRealLive(devId, 'timeout').catch(e =>
					this.log.warn(`stopRealLive timeout ${devId}: ${e?.message || e}`),
				);
			}, 30000);
			this.liveStopTimers.set(devId, t);
		} catch (e) {
			await this.setRealLiveStates(devId, {
				mode: 'error',
				active: false,
				last_error: e?.message || String(e),
			});
			this.log.warn(`startRealLive ${devId}: ${e?.message || e}`);
		}
	}

	async stopRealLive(devId, reason = 'manual') {
		const timer = this.liveStopTimers.get(devId);
		if (timer) {
			clearTimeout(timer);
			this.liveStopTimers.delete(devId);
		}

		const proc = this.liveProcesses.get(devId);
		if (proc) {
			try {
				proc.kill('SIGTERM');
			} catch {
				// ignore
			}
			this.liveProcesses.delete(devId);
		}

		const liveSession = this.liveSessions.get(devId);
		if (!liveSession) {
			await this.setRealLiveStates(devId, {
				mode: 'idle',
				active: false,
				url: '',
				expires_at: '',
				session_id: '',
				backend: '',
				last_error: '',
			});
			return;
		}

		await this.setRealLiveStates(devId, { mode: 'stopping' });

		try {
			if (liveSession.backend !== 'mjpeg_fallback' && typeof blinkApi.stopLiveView === 'function') {
				await blinkApi.stopLiveView(this.session, liveSession);
			}
		} catch (e) {
			this.log.debug(`stopLiveView ${devId}: ${e?.message || e}`);
		}

		this.liveSessions.delete(devId);
		await this.setRealLiveStates(devId, {
			mode: 'idle',
			active: false,
			url: '',
			expires_at: '',
			session_id: '',
			backend: '',
			last_error: reason === 'timeout' ? '' : '',
		});
	}

	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}
		if (!this.session) {
			this.log.warn('Not connected yet.');
			return;
		}

		const parts = id.split('.');
		const cmd = parts[parts.length - 1];
		const devId = parts[parts.length - 3];
		const group = parts[parts.length - 4];

		if (cmd === 'clear_session') {
			blinkApi.clearSession(this.cfg.email);
			this.log.info('Blink session cache cleared.');
			await this.setStateAsync(this.stripNs(id), false, true);
			return;
		}

		try {
			if (group === 'cameras') {
				const cam = this.camerasById.get(devId);
				if (!cam) {
					throw new Error('Unknown camera (waiting for next poll)');
				}

				if (cmd === 'start_live') {
					if (state.val !== true) {
						return;
					}
					await this.startRealLive(devId);
					await this.setStateAsync(this.stripNs(id), false, true);
				} else if (cmd === 'stop_live') {
					if (state.val !== true) {
						return;
					}
					await this.stopRealLive(devId, 'manual');
					await this.setStateAsync(this.stripNs(id), false, true);
				} else if (cmd === 'motion_detect') {
					const enable = state.val === true;
					await blinkApi.setMotion(this.session, cam.network_id, cam.id, enable, cam.apiType);
					await this.setStateAsync(`cameras.${devId}.status.motion_detect_enabled`, enable, true);
					await this.setStateAsync(this.stripNs(id), enable, true);
				} else if (cmd === 'snapshot') {
					if (state.val !== true) {
						return;
					}
					const file = path.join(this.cfg.snapshotDir, `${devId}.jpg`);
					await blinkApi.snapshot(this.session, cam.network_id, cam.id, cam.thumbnail, file, cam.apiType);
					await this.setLiveStates(devId, file);
					await this.setStateAsync(this.stripNs(id), false, true);
				} else if (cmd === 'fetch_video') {
					if (state.val !== true) {
						return;
					}
					const ts = new Date().toISOString().replace(/[:.]/g, '-');
					const file = path.join(this.cfg.snapshotDir, `${devId}_${ts}.mp4`);
					if (this.isVideoBusyCooldownActive(devId)) {
						await this.writeVideoBusyCooldownState(devId, cam);
						await this.setStateAsync(this.stripNs(id), false, true);
						return;
					}
					try {
						const res = await this.downloadNewestVideoLocalFirst(cam, devId, file);
						await this.updateVideoStates(devId, res);

						// Nach manuellem Download auch die History mit Local-Storage-first aktualisieren.
						try {
							await this.syncCameraHistory(cam, devId, res.localManifest || null);
						} catch (histErr) {
							this.log.debug(
								`History sync after manual download skipped (${cam.name || devId}): ${histErr?.message || histErr}`,
							);
						}
					} catch (e) {
						if (this.isBlinkSystemBusyError(e)) {
							await this.markVideoBusy(devId, cam, e);
						} else {
							await this.setStateAsync(`cameras.${devId}.video.ready`, false, true);
							await this.setStateAsync(`cameras.${devId}.video.lastError`, String(e?.message || e), true);
							this.log.warn(`Video download failed (${cam.name}): ${e?.message || e}`);
						}
					}
					await this.setStateAsync(this.stripNs(id), false, true);
				} else if (cmd === 'live_request') {
					if (state.val !== true) {
						return;
					}
					this.requestLive(devId);
					await this.setRealLiveStates(devId, {
						mode: 'running',
						active: true,
						url: this.mjpegServer ? this.mjpegServer.streamUrl(devId) : '',
						expires_at: new Date(Date.now() + 30000).toISOString(),
						session_id: `mjpeg-${Date.now()}`,
						backend: 'mjpeg_fallback',
						last_error: '',
					});
					await this.setStateAsync(this.stripNs(id), false, true);
				}
			} else if (group === 'sync') {
				const mod = this.syncById.get(devId);
				if (!mod) {
					throw new Error('Unknown sync module (waiting for next poll)');
				}

				if (cmd === 'armed') {
					const armed = state.val === true;
					await blinkApi.setArmed(this.session, mod.network_id, armed);
					await this.setStateAsync(`sync.${devId}.status.armed`, armed, true);
					await this.setStateAsync(this.stripNs(id), armed, true);
				}
			}
		} catch (e) {
			this.log.warn(`Command failed (${id}): ${e?.message || e}`);
		}
	}

	async updateArchiveAvailabilityState() {
		const enabled = !!this.cfg?.archiveEnabled;
		const dir = String(this.cfg?.archiveDir || '').trim();

		await this.setStateAsync('archive.enabled', enabled, true);
		await this.setStateAsync('archive.directory', dir, true);

		if (!enabled) {
			await this.setStateAsync('archive.available', false, true);
			await this.setStateAsync('archive.lastError', '', true);
			return false;
		}

		if (!dir) {
			const msg = 'Archive directory is empty';
			await this.setStateAsync('archive.available', false, true);
			await this.setStateAsync('archive.lastError', msg, true);
			return false;
		}

		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.accessSync(dir, fs.constants.W_OK);

			const testFile = path.join(dir, `.iobroker-blink-archive-test-${process.pid}`);
			fs.writeFileSync(testFile, 'test');
			fs.unlinkSync(testFile);

			await this.setStateAsync('archive.available', true, true);
			await this.setStateAsync('archive.lastError', '', true);
			return true;
		} catch (e) {
			const msg = `Archive directory is not writable: ${e?.message || e}`;
			await this.setStateAsync('archive.available', false, true);
			await this.setStateAsync('archive.lastError', msg, true);
			this.log.warn(msg);
			return false;
		}
	}

	safeArchiveSegment(value, fallback = 'unknown') {
		const raw = String(value || '').trim();
		const cleaned = raw
			.replace(/[\\/:*?"<>|]+/g, '_')
			.replace(/\s+/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_+|_+$/g, '');
		return cleaned || fallback;
	}

	archiveTimestamp(value) {
		const d = value ? new Date(value) : new Date();
		const valid = Number.isFinite(d.getTime()) ? d : new Date();
		return valid.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
	}

	async archiveVideo(devId, res) {
		if (!this.cfg?.archiveEnabled) {
			return;
		}

		try {
			const sourceFile = String(res?.file || '');
			if (!this.isUsableFile(sourceFile)) {
				throw new Error('Source video file is missing or empty');
			}

			const archiveDir = String(this.cfg.archiveDir || '').trim();
			if (!archiveDir) {
				throw new Error('Archive directory is empty');
			}

			const available = await this.updateArchiveAvailabilityState();
			if (!available) {
				return;
			}

			const cam = this.camerasById.get(devId);
			const cameraName = this.safeArchiveSegment(cam?.name || '', '');
			const cameraDirName =
				cameraName && cameraName !== devId
					? `${this.safeArchiveSegment(devId)}_${cameraName}`
					: this.safeArchiveSegment(devId);

			const targetDir =
				this.cfg.archiveCreateCameraFolders !== false ? path.join(archiveDir, cameraDirName) : archiveDir;

			await fs.promises.mkdir(targetDir, { recursive: true });

			const videoId = this.safeArchiveSegment(res?.id || res?.video_id || path.parse(sourceFile).name, 'clip');
			const source = this.safeArchiveSegment(res?.source || 'clip', 'clip');
			const ts = this.archiveTimestamp(res?.created_at);
			const targetFile = path.join(targetDir, `${ts}_${this.safeArchiveSegment(devId)}_${source}_${videoId}.mp4`);

			const resolvedRoot = path.resolve(archiveDir) + path.sep;
			const resolvedTarget = path.resolve(targetFile);
			if (!resolvedTarget.startsWith(resolvedRoot)) {
				throw new Error('Archive target escaped archive directory');
			}

			if (path.resolve(sourceFile) !== resolvedTarget) {
				await fs.promises.copyFile(sourceFile, targetFile);
			}

			const stat = await fs.promises.stat(targetFile);
			if (!stat.isFile() || stat.size <= 0) {
				throw new Error('Archived video file is empty');
			}

			await this.setStateAsync('archive.available', true, true);
			await this.setStateAsync('archive.lastFile', sourceFile, true);
			await this.setStateAsync('archive.lastTarget', targetFile, true);
			await this.setStateAsync('archive.lastSuccess', new Date().toISOString(), true);
			await this.setStateAsync('archive.lastError', '', true);

			this.log.debug(`Video archived: ${targetFile}`);
		} catch (e) {
			const msg = `Video archive failed: ${e?.message || e}`;
			await this.setStateAsync('archive.available', false, true);
			await this.setStateAsync('archive.lastError', msg, true);
			this.log.warn(msg);
		}
	}

	async syncLatestCloudVideos(cameras) {
		if (this.videoSyncInProgress || !this.session) {
			return;
		}
		this.videoSyncInProgress = true;

		// Manifest-Cache pro Sync-Modul für diesen Lauf.
		// Bei USB/Local-Storage wird das Manifest zuerst geprüft und nur einmal pro Sync-Modul geladen.
		const manifestCacheBySyncId = new Map();

		try {
			for (const cam of cameras) {
				const devId = this.sanitizeId(cam.id || cam.name);
				if (this.isVideoBusyCooldownActive(devId)) {
					continue;
				}

				const lastCheck = this.lastVideoCheckByDevId.get(devId) || 0;
				if (Date.now() - lastCheck < this.videoCheckCooldownMs) {
					continue;
				}
				this.lastVideoCheckByDevId.set(devId, Date.now());

				try {
					let summary = null;
					let latestId = '';
					let latestTs = '';
					let localClip = null;
					let localManifest = null;
					let localSyncId = null;
					let source = '';

					// 1) Local Storage / USB-Stick zuerst.
					const local = await this.getLatestLocalClipForCamera(cam, manifestCacheBySyncId);
					if (local?.localClip) {
						localClip = local.localClip;
						localManifest = local.localManifest;
						localSyncId = local.syncId;
						source = 'local_storage';

						latestId = this.getClipId(localClip);
						latestTs = this.getClipTimestamp(localClip);
						summary = {
							id: latestId,
							created_at: latestTs,
							source,
						};
					}

					// 2) Cloud nur als Fallback.
					let latest = null;
					if (!localClip) {
						try {
							latest = await blinkApi.getLatestVideoInfo(this.session, cam.network_id, cam.id);
						} catch (e) {
							if (e?.code === 'NO_VIDEO') {
								await this.setStateAsync(`cameras.${devId}.video.ready`, false, true);
								await this.setStateAsync(
									`cameras.${devId}.video.lastError`,
									'No video found in Local Storage or cloud',
									true,
								);
								continue;
							}
							throw e;
						}

						if (!latest) {
							await this.setStateAsync(`cameras.${devId}.video.ready`, false, true);
							await this.setStateAsync(
								`cameras.${devId}.video.lastError`,
								'No video found in Local Storage or cloud',
								true,
							);
							continue;
						}

						source = 'cloud';
						summary = {
							id: latest?.id || latest?.video_id || null,
							created_at: latest?.created_at || '',
							...(await blinkApi.getLatestVideoSummary(this.session, cam.network_id, cam.id)),
						};
						latestId = String(summary.id || latest?.created_at || latest?.url || '');
						latestTs = String(summary.created_at || '');
					}

					const tsState = await this.getStateAsync(`cameras.${devId}.video.timestamp`);
					const fileState = await this.getStateAsync(`cameras.${devId}.video.file`);
					const idState = await this.getStateAsync(`cameras.${devId}.video.id`);

					const currentTs = String(tsState?.val || '');
					const currentId = String(idState?.val || '');
					const currentFile = String(fileState?.val || '');
					const haveLocalFile = this.isUsableFile(currentFile);

					const isSameVideo =
						(latestId && currentId && latestId === currentId) ||
						(latestTs && currentTs && latestTs === currentTs);

					if (isSameVideo && haveLocalFile) {
						await this.setStateAsync(`cameras.${devId}.video.ready`, true, true);
						await this.setStateAsync(`cameras.${devId}.video.lastError`, '', true);
						await this.setStateAsync(`cameras.${devId}.video.size`, this.fileSize(currentFile), true);
						await this.updateDetectionStates(devId, summary);
						try {
							await this.syncCameraHistory(cam, devId, localManifest);
						} catch (e) {
							this.log.debug(`History sync skipped (${cam.name || devId}): ${e?.message || e}`);
						}
						continue;
					}

					const file = path.join(this.cfg.snapshotDir, `${devId}_latest.mp4`);
					let res;
					if (source === 'local_storage') {
						try {
							res = await blinkApi.downloadLocalClip(
								this.session,
								cam.network_id,
								localSyncId,
								localManifest.manifestId,
								latestId,
								file,
							);
							res = {
								...res,
								source: 'local_storage',
								id: latestId,
								created_at: latestTs,
							};
						} catch (e) {
							if (!this.isBlinkSystemBusyError(e)) {
								throw e;
							}

							this.markLocalStorageBusy(localSyncId, cam.network_id, e);
							latest = await blinkApi.getLatestVideoInfo(this.session, cam.network_id, cam.id);
							if (!latest) {
								await this.setStateAsync(`cameras.${devId}.video.ready`, false, true);
								await this.setStateAsync(
									`cameras.${devId}.video.lastError`,
									'No video found in Local Storage or cloud',
									true,
								);
								continue;
							}
							source = 'cloud';
							res = await blinkApi.downloadVideo(this.session, cam.network_id, cam.id, file, latest);
						}
					} else {
						res = await blinkApi.downloadVideo(this.session, cam.network_id, cam.id, file, latest);
					}

					await this.updateVideoStates(devId, res);

					// Motion notification: Es wurde ein NEUES Video heruntergeladen
					// (isSameVideo war false), das entspricht einer neuen Aufnahme/Bewegung.
					try {
						await this.notifyMotion(devId, cam, latestTs);
					} catch (e) {
						this.log.debug(`Motion notification skipped (${cam.name || devId}): ${e?.message || e}`);
					}

					// Galerie pflegen – Local-Storage zuerst, Cloud nur Fallback.
					try {
						await this.syncCameraHistory(cam, devId, localManifest);
					} catch (e) {
						this.log.debug(`History sync skipped (${cam.name || devId}): ${e?.message || e}`);
					}
				} catch (e) {
					if (this.isBlinkSystemBusyError(e)) {
						await this.markVideoBusy(devId, cam, e);
						continue;
					}

					this.log.debug(`Video sync skipped (${cam.name || devId}): ${e?.message || e}`);
				}
			}
		} finally {
			this.videoSyncInProgress = false;
		}
	}

	/**
	 * Pflegt die Galerie der 10 neuesten Clips einer Kamera als Ring-Buffer.
	 * Slot 0 ist der neueste Clip, Slot 9 der älteste. Quelle: zuerst Cloud
	 * (schneller, kein Stick-Upload nötig), Fallback Local-Storage.
	 *
	 * @param {object} cam - Kamera-Objekt aus getDevices.
	 * @param {string} devId - sanitized Device-ID.
	 * @param {object} [localManifestHint] - Optionales bereits geholtes Local-Manifest.
	 */
	async syncCameraHistory(cam, devId, localManifestHint = null) {
		const HISTORY_SIZE = 10;
		const base = `cameras.${devId}.video.history`;

		const syncId = this.findSyncIdForNetwork(cam.network_id);
		let wanted = [];
		let source = '';
		let localManifest = localManifestHint || null;

		// 1) Local Storage / USB-Stick zuerst.
		if (syncId) {
			if (!localManifest) {
				localManifest = await this.getLocalStorageManifestCached(cam.network_id, syncId);
			}

			if (localManifest) {
				wanted = this.findLocalClipsForCamera(localManifest, cam).slice(0, HISTORY_SIZE);
				if (wanted.length) {
					source = 'local_storage';
				}
			}
		}

		// 2) Cloud nur als Fallback.
		if (!wanted.length) {
			try {
				const result = await blinkApi.getHistoryClips(this.session, cam.network_id, cam.id, cam.name, {
					syncId,
					localManifest,
					limit: HISTORY_SIZE,
				});

				wanted = Array.isArray(result?.clips) ? result.clips.slice(0, HISTORY_SIZE) : [];
				source = result?.source || 'cloud';
			} catch (e) {
				if (this.isBlinkSystemBusyError(e)) {
					await this.markVideoBusy(devId, cam, e);
					return;
				}
				throw e;
			}
		}

		if (!wanted.length) {
			return;
		}

		// 2) Bekannte Clip-IDs pro Slot einsammeln.
		const knownIds = [];
		for (let i = 0; i < HISTORY_SIZE; i++) {
			const st = await this.getStateAsync(`${base}.${i}.id`);
			knownIds.push(String(st?.val || ''));
		}

		const slotFile = i => path.join(this.cfg.snapshotDir, `${devId}_history_${i}.mp4`);
		const tmpFile = i => path.join(this.cfg.snapshotDir, `.${devId}_history_${i}.tmp.mp4`);

		const isValidHistoryFile = filePath => {
			try {
				const st = fs.statSync(filePath);
				return st.isFile() && st.size > 0;
			} catch {
				return false;
			}
		};

		// 3) History gilt nur als aktuell, wenn Clip-IDs UND lokale MP4 fileen passen.
		const wantedIds = wanted.map(c => this.getClipId(c));
		const sameIds = wantedIds.every((id, idx) => id === knownIds[idx]);
		const sameFilesExist = wantedIds.every((_id, idx) => isValidHistoryFile(slotFile(idx)));

		if (sameIds && sameFilesExist) {
			return;
		}

		if (sameIds && !sameFilesExist) {
			this.log.info(`History files are missing or 0 bytes for ${cam.name || devId}; reloading affected slots.`);
		}

		// 4) Für jeden Slot festlegen: Reuse aus altem Slot oder neu downloaden?
		const sources = new Array(HISTORY_SIZE).fill(null); // 'reuse:<oldIdx>' | 'download'
		for (let newIdx = 0; newIdx < wanted.length; newIdx++) {
			const oldIdx = knownIds.indexOf(wantedIds[newIdx]);
			sources[newIdx] = oldIdx >= 0 && isValidHistoryFile(slotFile(oldIdx)) ? `reuse:${oldIdx}` : 'download';
		}

		// 4a) Reuse: alte Slot-Datei → Temp-Datei.
		for (let i = 0; i < wanted.length; i++) {
			const src = sources[i];
			if (typeof src === 'string' && src.startsWith('reuse:')) {
				const oldIdx = Number(src.slice(6));
				const from = slotFile(oldIdx);
				const to = tmpFile(i);
				try {
					fs.copyFileSync(from, to);
				} catch (e) {
					sources[i] = 'download';
					this.log.debug(`History reuse failed for slot ${oldIdx}→${i}: ${e.message}`);
				}
			}
		}

		// 4b) Download: je nach Quelle Cloud oder Local Storage.
		for (let i = 0; i < wanted.length; i++) {
			if (sources[i] !== 'download') {
				continue;
			}
			const clip = wanted[i];
			try {
				if (source === 'cloud') {
					await blinkApi.downloadCloudClip(this.session, clip, tmpFile(i));
				} else {
					if (!localManifest?.manifestId) {
						localManifest = await this.getLocalStorageManifestCached(cam.network_id, syncId);
					}
					await blinkApi.downloadLocalClip(
						this.session,
						cam.network_id,
						syncId,
						localManifest.manifestId,
						this.getClipId(clip),
						tmpFile(i),
					);
				}
			} catch (e) {
				if (this.isBlinkSystemBusyError(e)) {
					if (source === 'local_storage') {
						this.markLocalStorageBusy(syncId, cam.network_id, e);
					} else {
						await this.markVideoBusy(devId, cam, e);
					}
					return; // Nur diese Kamera/dieses Sync-Modul pausieren, andere Kameras laufen weiter.
				}

				this.log.warn(
					`History-Download failed (${cam.name} Slot ${i}, clip ${this.getClipId(clip)}): ${e.message}`,
				);
				return; // Slot-Lauf abbrechen, alte Daten bleiben erhalten
			}
		}

		// 4c) Temp → Slot umbenennen (atomar), überzählige Slots löschen.
		for (let i = 0; i < wanted.length; i++) {
			try {
				fs.renameSync(tmpFile(i), slotFile(i));
			} catch (e) {
				this.log.warn(`History rename slot ${i} failed: ${e.message}`);
			}
		}
		for (let i = wanted.length; i < HISTORY_SIZE; i++) {
			try {
				fs.unlinkSync(slotFile(i));
			} catch {
				// Slot-Datei existiert ggf. nicht; ignorieren.
			}
		}

		// 5) States schreiben.
		for (let i = 0; i < HISTORY_SIZE; i++) {
			if (i < wanted.length) {
				const clip = wanted[i];
				await this.setStateAsync(`${base}.${i}.file`, slotFile(i), true);
				await this.setStateAsync(`${base}.${i}.timestamp`, this.getClipTimestamp(clip), true);
				await this.setStateAsync(`${base}.${i}.id`, this.getClipId(clip), true);
				await this.setStateAsync(`${base}.${i}.source`, source, true);
			} else {
				await this.setStateAsync(`${base}.${i}.file`, '', true);
				await this.setStateAsync(`${base}.${i}.timestamp`, '', true);
				await this.setStateAsync(`${base}.${i}.id`, '', true);
				await this.setStateAsync(`${base}.${i}.source`, '', true);
			}
		}
		this.log.debug(`History updated for ${cam.name}: ${wanted.length} slots (${source})`);
	}

	async updateDetectionStates(devId, summary) {
		await this.setStateAsync(`cameras.${devId}.status.smart_detection`, !!summary?.smart_detection, true);
		await this.setStateAsync(`cameras.${devId}.status.person_detected`, !!summary?.person_detected, true);
		await this.setStateAsync(`cameras.${devId}.status.vehicle_detected`, !!summary?.vehicle_detected, true);
		await this.setStateAsync(`cameras.${devId}.status.animal_detected`, !!summary?.animal_detected, true);
		await this.setStateAsync(`cameras.${devId}.status.package_detected`, !!summary?.package_detected, true);
		await this.setStateAsync(`cameras.${devId}.status.detection_type`, String(summary?.detection_type || ''), true);
		await this.setStateAsync(
			`cameras.${devId}.status.smart_detection_raw`,
			String(summary?.smart_detection_raw || ''),
			true,
		);
		await this.setStateAsync(`cameras.${devId}.status.motion_source`, String(summary?.motion_source || ''), true);
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
		await this.updateDetectionStates(devId, res);
		await this.archiveVideo(devId, res);
	}

	/**
	 * Versendet eine Benachrichtigung über alle aktivierten Kanäle eines Auslösers.
	 *
	 * @param {object} channelCfg - Kanal-Konfiguration (z. B. this.cfg.notify.battery).
	 * @param {string} title - Titel/Betreff der Nachricht.
	 * @param {string} message - Nachrichtentext.
	 * @returns {Promise<string[]>} Liste der Kanäle, an die erfolgreich gesendet wurde.
	 */
	async sendNotification(channelCfg, title, message) {
		const sent = [];
		if (!channelCfg) {
			return sent;
		}

		// Telegram
		if (channelCfg.telegram?.enabled && channelCfg.telegram.instance) {
			try {
				const payload = { text: `${title}\n\n${message}` };
				const users = channelCfg.telegram.users;
				if (users) {
					// Mehrere User kommagetrennt – an jeden einzeln senden.
					for (const user of users
						.split(',')
						.map(u => u.trim())
						.filter(Boolean)) {
						await this.sendToAsync(channelCfg.telegram.instance, 'send', { ...payload, user });
					}
				} else {
					await this.sendToAsync(channelCfg.telegram.instance, 'send', payload);
				}
				sent.push('telegram');
			} catch (e) {
				this.log.warn(`Telegram notification failed: ${e?.message || e}`);
			}
		}

		// Pushover
		if (channelCfg.pushover?.enabled && channelCfg.pushover.instance) {
			try {
				await this.sendToAsync(channelCfg.pushover.instance, 'send', {
					title,
					message,
					priority: 0,
				});
				sent.push('pushover');
			} catch (e) {
				this.log.warn(`Pushover notification failed: ${e?.message || e}`);
			}
		}

		// E-Mail
		if (channelCfg.email?.enabled && channelCfg.email.instance) {
			try {
				const mail = { subject: title, text: message };
				if (channelCfg.email.to) {
					mail.to = channelCfg.email.to;
				}
				await this.sendToAsync(channelCfg.email.instance, 'send', mail);
				sent.push('email');
			} catch (e) {
				this.log.warn(`Email notification failed: ${e?.message || e}`);
			}
		}

		return sent;
	}

	/**
	 * Promise-Wrapper um adapter.sendTo mit Fehlerbehandlung.
	 *
	 * @param {string} instance - Ziel-Instanz (z. B. 'email.0').
	 * @param {string} command - sendTo-Kommando (in der Regel 'send').
	 * @param {object} payload - Nachrichten-Payload.
	 * @returns {Promise<object>} Antwort der Ziel-Instanz.
	 */
	sendToAsync(instance, command, payload) {
		return new Promise((resolve, reject) => {
			this.sendTo(instance, command, payload, res => {
				if (res && res.error) {
					reject(new Error(String(res.error)));
				} else {
					resolve(res);
				}
			});
		});
	}

	/**
	 * Löst eine Motion notification für eine Kamera aus, sofern aktiviert
	 * und der Cooldown nicht greift.
	 *
	 * @param {string} devId - Bereinigte Geräte-ID.
	 * @param {object} cam - Kamera-Objekt.
	 * @param {string} [videoTs] - Zeitstempel des neuen Videos.
	 * @returns {Promise<void>}
	 */
	async notifyMotion(devId, cam, videoTs) {
		const motionCfg = this.cfg.notify?.motion;
		if (!motionCfg || !motionCfg.enabled) {
			return;
		}

		const cooldownMs = motionCfg.cooldownMinutes * 60 * 1000;
		const last = this.lastMotionNotifyByDevId.get(devId) || 0;
		if (last && Date.now() - last < cooldownMs) {
			this.log.debug(`Motion notification (${cam.name || devId}) is in cooldown; skipped.`);
			return;
		}

		const when = videoTs ? new Date(videoTs).toLocaleString('en-US') : new Date().toLocaleString('en-US');
		const title = 'Blink motion detected';
		const message = `Camera: ${cam.name || devId}\nTime: ${when}`;

		const sent = await this.sendNotification(motionCfg, title, message);
		if (sent.length) {
			this.lastMotionNotifyByDevId.set(devId, Date.now());
			this.log.debug(`Motion notification (${cam.name || devId}) sent via: ${sent.join(', ')}`);
		}
	}

	async checkBatteryWarning(devId, cam) {
		const base = `cameras.${devId}`;

		const apiType = String(cam.apiType || '').toLowerCase();
		const nameLc = String(cam.name || '').toLowerCase();
		const serialLc = String(cam.serial || '').toLowerCase();

		const noBatteryDevice =
			apiType === 'owl' ||
			apiType === 'mini' ||
			nameLc.includes('pantilt') ||
			nameLc.includes('pan tilt') ||
			nameLc.includes('blink mini') ||
			nameLc.includes('mini') ||
			serialLc.includes('mini');

		if (noBatteryDevice) {
			await this.setStateAsync(`${base}.battery.low`, false, true);
			await this.setStateAsync(`${base}.battery.warningSent`, false, true);
			await this.setStateAsync(`${base}.battery.lastMessage`, 'no built in battery', true);
			return;
		}

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

		const msg = `Blink battery low\n\nCamera: ${cam.name || devId}\nVoltage: ${volt.toFixed(2)} V\nThreshold: ${thresh.toFixed(2)} V`;
		await this.setStateAsync(`${base}.battery.lastMessage`, msg, true);

		const sent = await this.sendNotification(this.cfg.notify?.battery, 'Blink battery low', msg);
		if (sent.length) {
			await this.setStateAsync(`${base}.battery.warningSent`, true, true);
			await this.setStateAsync(`${base}.battery.lastWarning`, new Date().toISOString(), true);
			this.log.debug(`Battery warning (${cam.name || devId}) sent via: ${sent.join(', ')}`);
		} else {
			this.log.debug(`Battery warning (${cam.name || devId}): no channel active/successful.`);
		}
	}

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
			} catch {
				// Lösch-/Stat-Fehler ignorieren.
			}
		}
	}

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
		return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
	}

	toNum(v) {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}

	stripNs(fullId) {
		const ns = `${this.namespace}.`;
		return fullId.startsWith(ns) ? fullId.slice(ns.length) : fullId;
	}

	onUnload(cb) {
		try {
			if (this.pollTimer) {
				this.clearInterval(this.pollTimer);
			}
			if (this.liveTimer) {
				this.clearTimeout(this.liveTimer);
			}
			if (this.mjpegStatusTimer) {
				this.clearInterval(this.mjpegStatusTimer);
				this.mjpegStatusTimer = null;
			}

			for (const timer of this.liveStopTimers.values()) {
				clearTimeout(timer);
			}
			this.liveStopTimers.clear();

			for (const proc of this.liveProcesses.values()) {
				try {
					proc.kill('SIGTERM');
				} catch {
					// ignore
				}
			}
			this.liveProcesses.clear();
			this.liveSessions.clear();

			const finish = () => {
				this.stopHlsServer()
					.catch(() => {})
					.finally(() => cb());
			};

			if (this.mjpegServer) {
				this.mjpegServer
					.stop()
					.catch(() => {})
					.finally(() => {
						this.mjpegServer = null;
						finish();
					});
				return;
			}
			finish();
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
