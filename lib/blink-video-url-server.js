/* global log, exec, getObject, getState, setState, existsState, existsObject, $, onStop */
/* eslint-disable no-empty, no-useless-escape, @typescript-eslint/no-unused-vars */
// ============================================================
// Blink Multi-Camera Server + Grid + History + LiveView/HLS
//   http://<host>:8085/grid                 → Alle Kameras im Grid inkl. History + Live
//   http://<host>:8085/cameras              → JSON mit Kameras
//   http://<host>:8085/live/start?camera=ID → Start LiveView
//   http://<host>:8085/live/stop            → Stop LiveView
//   http://<host>:8085/live/last-session    → Debug/Status
//   http://<host>:8085/live/debug-cameras   → LiveView-Discovery Debug
//   http://<host>:8085/live-hls/<file>      → HLS Playlist/Segmente
//   http://<host>:8085/blink/<file>         → gespeicherte Video-Dateien
// ============================================================

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

// ============= KONFIGURATION =============
const PORT = 8085;
const ROOT_DIR = '/opt/iobroker/iobroker-data/blink';
const VIDEO_BASE = '/blink/';
const CAMERA_PREFIX = 'blink.0.cameras.';
const VIDEO_STATE = '.video.file';
const NAME_STATE = '.info.name';
const TS_STATE = '.video.timestamp';
const READY_STATE = '.video.ready';
const ERROR_STATE = '.video.lastError';
const UNSUPPORTED_STATE = '.live.unsupported';
const HISTORY_SIZE = 10;
const IOBROKER_PORT = 8082;

// Blink/API/IMMI-Dateien auf dem Pi
const LIVEVIEW_DIR = '/opt/iobroker/node_modules/iobroker.blink/lib';
const LIVEVIEW_REST_SCRIPT = path.join(LIVEVIEW_DIR, 'blink-liveview-iobroker.js');
const LIVEVIEW_HLS_SCRIPT = path.join(LIVEVIEW_DIR, 'immi-live-hls.js');
const HLS_DIR = '/tmp/blink_hls';
const LIVEVIEW_RUNTIME_SEC = 300;

// Pfad zur ffmpeg-Binary. Leer lassen, wenn ffmpeg im PATH liegt.
// In Docker-Setups, in denen ffmpeg manuell bereitgestellt wird, hier den
// vollen Pfad eintragen, z. B. '/usr/local/bin/ffmpeg' oder '/opt/ffmpeg/ffmpeg'.
const FFMPEG_PATH = '';

// Blink-Zugangsdaten werden automatisch aus der Adapter-Admin-Konfiguration gelesen.
// Erwartete Config-Keys in admin/jsonConfig.json: email, password, pin
const BLINK_INSTANCE = 'blink.0';

// Account-ID wird automatisch aus ioBroker-Objekten, Adapter-Config oder vorhandenen Session-Dateien gesucht.
// Nur als optionaler Notfall-Fallback setzen; im Normalfall leer lassen.
const DEFAULT_ACCOUNT_ID = '133934';

// Network-ID wird automatisch aus blink.0.sync.<networkId> gelesen.
// Nur als optionaler Notfall-Fallback nutzen; bei mehreren Sync-Modulen NICHT blind setzen.
const DEFAULT_NETWORK_ID = '';

// Sonderfälle überschreiben/ergänzen.
// Normale Blink-Kameras brauchen keinen Eintrag mehr: fehlender Typ wird automatisch als "camera" behandelt.
// Einträge sind nur nötig für owl/doorbell, falsche Seriennummern oder mehrere Sync-Module ohne Kamera-Zuordnung.
const LIVEVIEW_CAMERA_OVERRIDES = {
	773578: { type: 'owl', serial: 'G8T1940153360515', name: 'Mini - 0515' },
};
// =========================================

if (typeof globalThis.__blinkServer !== 'undefined') {
	try {
		globalThis.__blinkServer.close();
		log('Previous Blink server stopped');
	} catch (e) {
		/* ignore */
	}
}

let liveStatus = {
	enabled: true,
	running: false,
	pid: null,
	playlist: false,
	hls_url: null,
	camera_id: null,
	camera_name: null,
	device_type: null,
	session_file: null,
	last_error: '',
	last_log: '',
};

function shellQuote(s) {
	return `'${String(s == null ? '' : s).replace(/'/g, "'\\''")}'`;
}

function readBlinkCredentials() {
	return new Promise((resolve, reject) => {
		function pickNative(obj) {
			const n = obj && obj.native ? obj.native : {};
			const email = String(n.email || '').trim();
			const password = String(n.password || '');
			const pin = String(n.pin || '').trim();
			return { email, password, pin };
		}

		function finish(source, creds) {
			log(
				`Blink config read from ${source}: email=${creds.email ? 'yes' : 'no'}, password=${
					creds.password ? 'yes' : 'no'
				}, pin=${creds.pin ? 'yes' : 'no'}`,
			);

			if (!creds.email || !creds.password) {
				reject(
					new Error(
						`Blink email or password is missing in system.adapter.${BLINK_INSTANCE}.native.email/password`,
					),
				);
				return;
			}

			resolve(creds);
		}

		function tryCliFallback(reason) {
			const cmd = `iobroker object get ${shellQuote(`system.adapter.${BLINK_INSTANCE}`)}`;
			exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
				if (err) {
					reject(
						new Error(
							`Blink adapter configuration could not be read. getObject: ${reason} / CLI: ${
								stderr || err.message || String(err)
							}`,
						),
					);
					return;
				}

				try {
					const obj = JSON.parse(stdout || '{}');
					finish('iobroker object get', pickNative(obj));
				} catch (e) {
					reject(new Error(`Blink adapter configuration could not be parsed: ${e.message}`));
				}
			});
		}

		try {
			getObject(`system.adapter.${BLINK_INSTANCE}`, (err, obj) => {
				if (err || !obj || !obj.native) {
					tryCliFallback(err ? String(err) : 'no object/native');
					return;
				}

				const creds = pickNative(obj);

				// In manchen JavaScript-Adapter-Kontexten kommen system.adapter.* Objekte ohne native-Werte an.
				// Dann sicherheitshalber per ioBroker-CLI nachlesen, ohne die Werte ins Log zu schreiben.
				if (!creds.email || !creds.password) {
					tryCliFallback('native leer oder unvollstaendig via getObject');
					return;
				}

				finish('getObject', creds);
			});
		} catch (e) {
			tryCliFallback(e.message || String(e));
		}
	});
}

function execPromise(cmd, opts) {
	opts = opts || {};
	return new Promise(resolve => {
		exec(cmd, opts, (err, stdout, stderr) => {
			resolve({ err: err, stdout: stdout || '', stderr: stderr || '' });
		});
	});
}

function readFileSafe(file, maxLen) {
	try {
		let s = fs.readFileSync(file, 'utf8');
		if (maxLen && s.length > maxLen) {
			s = s.slice(-maxLen);
		}
		return s;
	} catch (e) {
		return '';
	}
}

function safeJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		return null;
	}
}

function getFirstLiveCommand(session) {
	try {
		const cmds =
			session && session.raw_poll && Array.isArray(session.raw_poll.commands) ? session.raw_poll.commands : [];
		return cmds[0] || null;
	} catch (e) {
		return null;
	}
}

function parseCommandDebug(debugValue) {
	const raw = String(debugValue || '');
	const out = {
		raw: raw,
		hasCommandError: /command_error/i.test(raw),
		hasLfrOk: /lfr_ok/i.test(raw),
		lfrOk: null,
		commandError: null,
	};

	for (const part of raw.split('|')) {
		const s = part.trim();
		if (!s) {
			continue;
		}
		try {
			const obj = JSON.parse(s);
			if (obj && Object.prototype.hasOwnProperty.call(obj, 'lfr_ok')) {
				out.lfrOk = obj.lfr_ok;
			}
			if (obj && Object.prototype.hasOwnProperty.call(obj, 'command_error')) {
				out.commandError = obj.command_error;
			}
		} catch (e) {
			// debug ist nicht immer sauberes JSON – Rohtext-Erkennung reicht als Fallback.
		}
	}

	return out;
}

function detectLfrLiveViewRejection(session) {
	const cmd = getFirstLiveCommand(session);
	if (!cmd) {
		return null;
	}

	const debug = parseCommandDebug(cmd.debug);
	const lfrAckZero = Number(cmd.lfr_ack || 0) === 0;
	const isOldLfrPath =
		!session.is_mclv &&
		!session.first_joiner &&
		!session.parent_command_id &&
		(cmd.stage_lv == null || typeof cmd.stage_lv === 'undefined') &&
		String(cmd.state_stage || session.state_stage || '') === 'vs';

	if (isOldLfrPath && lfrAckZero) {
		const hasCommandErrorText = debug.hasCommandError ? ', command_error vorhanden' : '';
		return {
			reason:
				`XT2/LFR LiveView was not confirmed by Blink: lfr_ack=0, stage_lv=null${hasCommandErrorText}. ` +
				`This camera does not provide a usable stream via the current immis/HLS path.`,
			detail: {
				state_stage: cmd.state_stage,
				stage_lv: cmd.stage_lv,
				stage_vs: cmd.stage_vs,
				sm_ack: cmd.sm_ack,
				lfr_ack: cmd.lfr_ack,
				sequence: cmd.sequence,
				debug: debug.raw,
				lfr_ok: debug.lfrOk,
				command_error: debug.commandError,
				transaction: cmd.transaction,
				player_transaction: cmd.player_transaction,
				server: cmd.server,
			},
		};
	}

	return null;
}

function getPiHost(req) {
	const host = req && req.headers && req.headers.host ? String(req.headers.host).split(':')[0] : '127.0.0.1';
	return host || '127.0.0.1';
}

function publicHlsUrl(req) {
	return `http://${getPiHost(req)}:${PORT}/live-hls/live.m3u8?t=${Date.now()}`;
}

function getStateAsync(id) {
	return new Promise(resolve => {
		try {
			getState(id, (err, st) => resolve(!err && st ? st : null));
		} catch (e) {
			resolve(null);
		}
	});
}

function setStateAsync(id, value, ack) {
	return new Promise(resolve => {
		try {
			setState(id, value, ack !== false, err => resolve(!err));
		} catch (e) {
			resolve(false);
		}
	});
}

async function markCameraUnsupported(cameraId, reason) {
	const id = CAMERA_PREFIX + cameraId + UNSUPPORTED_STATE;
	if (!objectExists(id)) {
		log(`markCameraUnsupported: State ${id} does not exist; restart the adapter?`, 'warn');
		return;
	}
	try {
		const st = await getStateAsync(id);
		if (st && st.val === true) {
			return; // bereits markiert
		}
		const ok = await setStateAsync(id, true, true);
		if (ok) {
			log(
				`Camera ${cameraId} permanently marked as unsupported for LiveView. Reason: ${reason || 'unknown'}`,
				'warn',
			);
		}
	} catch (e) {
		log(`markCameraUnsupported for ${cameraId} failed: ${e.message || e}`, 'warn');
	}
}

function objectExists(id) {
	try {
		if (typeof existsState === 'function') {
			return !!existsState(id);
		}
	} catch (e) {}
	try {
		if (typeof existsObject === 'function') {
			return !!existsObject(id);
		}
	} catch (e) {}
	return true;
}

async function readStateString(id) {
	if (!objectExists(id)) {
		return '';
	}
	const st = await getStateAsync(id);
	if (!st || st.val === null || typeof st.val === 'undefined') {
		return '';
	}
	return String(st.val).trim();
}

async function readFirstStateString(ids) {
	for (const id of ids) {
		const v = await readStateString(id);
		if (v) {
			return v;
		}
	}
	return '';
}

let __syncNetworkIdsCache = null;

function discoverSyncNetworkIds() {
	if (__syncNetworkIdsCache) {
		return __syncNetworkIdsCache;
	}

	const ids = new Set();
	const selectors = ['channel[id=blink.0.sync.*]', 'device[id=blink.0.sync.*]', 'state[id=blink.0.sync.*]'];

	for (const selector of selectors) {
		try {
			$(selector).each(id => {
				const m = String(id).match(/^blink\.0\.sync\.(\d+)(?:\.|$)/);
				if (m) {
					ids.add(m[1]);
				}
			});
		} catch (e) {
			// Manche ioBroker-Installationen kennen nicht alle Selektortypen.
		}
	}

	__syncNetworkIdsCache = Array.from(ids).sort();
	return __syncNetworkIdsCache;
}

function getNetworkFallbackInfo() {
	const syncIds = discoverSyncNetworkIds();

	if (syncIds.length === 1) {
		return {
			networkId: syncIds[0],
			ambiguous: false,
			all: syncIds,
			source: 'blink.0.sync.*',
		};
	}

	if (syncIds.length > 1) {
		return {
			networkId: null,
			ambiguous: true,
			all: syncIds,
			source: 'multiple blink.0.sync.*',
		};
	}

	if (DEFAULT_NETWORK_ID) {
		return {
			networkId: String(DEFAULT_NETWORK_ID),
			ambiguous: false,
			all: [],
			source: 'DEFAULT_NETWORK_ID',
		};
	}

	return {
		networkId: null,
		ambiguous: false,
		all: [],
		source: 'none',
	};
}

function addNumericCandidate(map, value, source) {
	const v = String(value == null ? '' : value).trim();
	if (!/^\d+$/.test(v)) {
		return;
	}
	if (!map[v]) {
		map[v] = [];
	}
	if (source && !map[v].includes(source)) {
		map[v].push(source);
	}
}

function scanAccountIdsFromAny(value, map, source, depth) {
	// Wichtig: Nicht beliebige Zahlen aus JSON-Dateien als Account-ID sammeln.
	// Sonst landen command_id, camera_id, duration, status_code usw. als falsche Kandidaten
	// in der Account-Automatik. Wir akzeptieren nur explizite Account-Felder.
	if (depth > 6 || value == null) {
		return;
	}

	if (Array.isArray(value)) {
		value.forEach((v, i) => scanAccountIdsFromAny(v, map, `${source}[${i}]`, depth + 1));
		return;
	}

	if (typeof value !== 'object') {
		return;
	}

	for (const key of Object.keys(value)) {
		const lower = key.toLowerCase();
		if (lower === 'account_id' || lower === 'accountid') {
			addNumericCandidate(map, value[key], `${source}.${key}`);
		} else if ((lower === 'id' || lower === 'account') && /accounts?$/i.test(source)) {
			addNumericCandidate(map, value[key], `${source}.${key}`);
		} else if (/(^|\.)accounts?(\.|$)|native\.accounts/i.test(`${source}.${key}`)) {
			scanAccountIdsFromAny(value[key], map, `${source}.${key}`, depth + 1);
		} else if (lower === 'account' && typeof value[key] === 'object') {
			scanAccountIdsFromAny(value[key], map, `${source}.${key}`, depth + 1);
		}
	}
}

function discoverAccountIdsFromObjects(map) {
	const selectors = [
		'channel[id=blink.0.account.*]',
		'device[id=blink.0.account.*]',
		'state[id=blink.0.account.*]',
		'channel[id=blink.0.accounts.*]',
		'device[id=blink.0.accounts.*]',
		'state[id=blink.0.accounts.*]',
	];

	for (const selector of selectors) {
		try {
			$(selector).each(id => {
				const m = String(id).match(/^blink\.0\.accounts?\.(\d+)(?:\.|$)/);
				if (m) {
					addNumericCandidate(map, m[1], selector);
				}
			});
		} catch (e) {
			// Manche ioBroker-Installationen kennen nicht alle Selektortypen.
		}
	}
}

function discoverAccountIdsFromSessionFiles(map) {
	const files = [];

	try {
		for (const f of fs.readdirSync('/tmp')) {
			if (/^blink_liveview_session.*\.json$/.test(f)) {
				files.push(path.join('/tmp', f));
			}
		}
	} catch (e) {}

	try {
		const cacheDir = '/tmp/blink_session_cache';
		if (fs.existsSync(cacheDir)) {
			for (const f of fs.readdirSync(cacheDir)) {
				if (/\.json$/i.test(f)) {
					files.push(path.join(cacheDir, f));
				}
			}
		}
	} catch (e) {}

	for (const file of files) {
		try {
			const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (!obj || typeof obj !== 'object') {
				continue;
			}

			// Nur explizite Account-Felder verwenden. Keine freie JSON-Zahlensuche.
			addNumericCandidate(map, obj.account_id, `${file}.account_id`);
			addNumericCandidate(map, obj.accountId, `${file}.accountId`);
			addNumericCandidate(map, obj.raw_start && obj.raw_start.account_id, `${file}.raw_start.account_id`);
			addNumericCandidate(map, obj.raw_start && obj.raw_start.accountId, `${file}.raw_start.accountId`);
			addNumericCandidate(map, obj.raw_poll && obj.raw_poll.account_id, `${file}.raw_poll.account_id`);
			addNumericCandidate(map, obj.raw_poll && obj.raw_poll.accountId, `${file}.raw_poll.accountId`);
			if (obj.raw_poll && Array.isArray(obj.raw_poll.commands)) {
				obj.raw_poll.commands.forEach((cmd, i) => {
					addNumericCandidate(map, cmd && cmd.account_id, `${file}.raw_poll.commands[${i}].account_id`);
					addNumericCandidate(map, cmd && cmd.accountId, `${file}.raw_poll.commands[${i}].accountId`);
				});
			}

			// Falls die Datei eine echte Accounts-Struktur enthält, nur daraus extrahieren.
			if (obj.accounts) {
				scanAccountIdsFromAny(obj.accounts, map, `${file}.accounts`, 0);
			}
			if (obj.account) {
				scanAccountIdsFromAny(obj.account, map, `${file}.account`, 0);
			}
		} catch (e) {}
	}
}

function getObjectAsync(id) {
	return new Promise(resolve => {
		try {
			getObject(id, (err, obj) => resolve(!err && obj ? obj : null));
		} catch (e) {
			resolve(null);
		}
	});
}

async function getAccountFallbackInfo() {
	const map = {};

	discoverAccountIdsFromObjects(map);
	discoverAccountIdsFromSessionFiles(map);

	const adapterObj = await getObjectAsync(`system.adapter.${BLINK_INSTANCE}`);
	if (adapterObj && adapterObj.native) {
		addNumericCandidate(map, adapterObj.native.accountId, 'adapter-config.accountId');
		addNumericCandidate(map, adapterObj.native.account_id, 'adapter-config.account_id');
		scanAccountIdsFromAny(adapterObj.native.accounts, map, 'adapter-config.accounts', 0);
	}

	const stateAccountId = await readFirstStateString([
		'blink.0.account_id',
		'blink.0.accountId',
		'blink.0.info.account_id',
		'blink.0.info.accountId',
		'blink.0.config.account_id',
		'blink.0.config.accountId',
		'blink.0.account.id',
	]);
	if (stateAccountId) {
		addNumericCandidate(map, stateAccountId, 'blink.0 account state');
	}

	if (DEFAULT_ACCOUNT_ID) {
		addNumericCandidate(map, DEFAULT_ACCOUNT_ID, 'DEFAULT_ACCOUNT_ID');
	}

	const ids = Object.keys(map).sort();

	if (ids.length === 1) {
		return {
			accountId: ids[0],
			ambiguous: false,
			all: ids,
			sources: map,
		};
	}

	if (ids.length > 1) {
		return {
			accountId: null,
			ambiguous: true,
			all: ids,
			sources: map,
		};
	}

	return {
		accountId: null,
		ambiguous: false,
		all: [],
		sources: map,
	};
}

async function buildLiveviewConfigForCamera(cam) {
	const id = String(cam.id);
	const ov = LIVEVIEW_CAMERA_OVERRIDES[id] || {};

	const serial =
		ov.serial ||
		(await readFirstStateString([
			`${CAMERA_PREFIX + id}.info.serial`,
			`${CAMERA_PREFIX + id}.serial`,
			`${CAMERA_PREFIX + id}.device.serial`,
			`${CAMERA_PREFIX + id}.info.serial_number`,
			`${CAMERA_PREFIX + id}.info.serialNumber`,
		]));

	// Typ automatisch erkennen, sonst Standard: normale Blink-Kamera.
	// Sonderfälle wie owl/doorbell per LIVEVIEW_CAMERA_OVERRIDES setzen.
	const detectedType = await readFirstStateString([
		`${CAMERA_PREFIX + id}.info.type`,
		`${CAMERA_PREFIX + id}.type`,
		`${CAMERA_PREFIX + id}.device.type`,
		`${CAMERA_PREFIX + id}.info.device_type`,
		`${CAMERA_PREFIX + id}.info.deviceType`,
	]);
	const type = ov.type || detectedType || 'camera';

	const detectedNetworkId = await readFirstStateString([
		`${CAMERA_PREFIX + id}.info.network_id`,
		`${CAMERA_PREFIX + id}.info.networkId`,
		`${CAMERA_PREFIX + id}.network_id`,
		`${CAMERA_PREFIX + id}.networkId`,
		`${CAMERA_PREFIX + id}.network.id`,
		`${CAMERA_PREFIX + id}.device.network_id`,
		`${CAMERA_PREFIX + id}.device.networkId`,
	]);

	const detectedAccountId = await readFirstStateString([
		`${CAMERA_PREFIX + id}.info.account_id`,
		`${CAMERA_PREFIX + id}.info.accountId`,
		`${CAMERA_PREFIX + id}.account_id`,
		`${CAMERA_PREFIX + id}.accountId`,
		`${CAMERA_PREFIX + id}.account.id`,
		`${CAMERA_PREFIX + id}.device.account_id`,
		`${CAMERA_PREFIX + id}.device.accountId`,
	]);

	const accountFallback = await getAccountFallbackInfo();
	const networkFallback = getNetworkFallbackInfo();
	const accountId = ov.accountId || detectedAccountId || accountFallback.accountId;
	const networkId = ov.networkId || detectedNetworkId || networkFallback.networkId;

	const missing = [];
	const warnings = [];
	if (!accountId) {
		missing.push('accountId');
	}
	if (!networkId) {
		missing.push('networkId');
	}
	if (!type) {
		missing.push('type');
	}
	if (!id) {
		missing.push('id');
	}
	if (!serial) {
		missing.push('serial');
	}

	if (!accountId && accountFallback.ambiguous) {
		warnings.push(
			`Multiple account IDs found (${accountFallback.all.join(
				', ',
			)}), but no camera accountId. Please set accountId via LIVEVIEW_CAMERA_OVERRIDES.`,
		);
	}

	if (!networkId && networkFallback.ambiguous) {
		warnings.push(
			`Multiple sync modules found (${networkFallback.all.join(
				', ',
			)}), but no camera networkId. Please set networkId via LIVEVIEW_CAMERA_OVERRIDES.`,
		);
	}

	if (missing.length) {
		return {
			liveview: null,
			missing: missing,
			warnings: warnings,
			syncNetworks: networkFallback.all,
			accountCandidates: accountFallback.all,
		};
	}

	return {
		liveview: {
			id: id,
			name: ov.name || cam.name || `Camera ${id}`,
			accountId: String(accountId),
			networkId: String(networkId),
			type: String(type),
			serial: String(serial),
			hasSerial: true,
			accountSource: ov.accountId
				? 'override'
				: detectedAccountId
					? 'camera-state'
					: accountFallback.sources && accountFallback.sources[accountId]
						? accountFallback.sources[accountId].join(', ')
						: 'auto',
			accountCandidates: accountFallback.all,
			networkSource: ov.networkId ? 'override' : detectedNetworkId ? 'camera-state' : networkFallback.source,
		},
		missing: [],
		warnings: warnings,
		syncNetworks: networkFallback.all,
		accountCandidates: accountFallback.all,
	};
}

// ---------- Kameras automatisch entdecken ----------
async function discoverCameras() {
	const cams = [];
	const seen = new Set();

	$(`state[id=${CAMERA_PREFIX}*${NAME_STATE}]`).each(id => {
		const rest = id.slice(CAMERA_PREFIX.length);
		const camId = rest.split('.')[0];
		if (!seen.has(camId)) {
			seen.add(camId);
			const history = [];
			for (let i = 0; i < HISTORY_SIZE; i++) {
				history.push({
					slot: i,
					file_datapoint: `${CAMERA_PREFIX}${camId}.video.history.${i}.file`,
					timestamp_datapoint: `${CAMERA_PREFIX}${camId}.video.history.${i}.timestamp`,
					id_datapoint: `${CAMERA_PREFIX}${camId}.video.history.${i}.id`,
					source_datapoint: `${CAMERA_PREFIX}${camId}.video.history.${i}.source`,
				});
			}
			cams.push({
				id: camId,
				datapoint: CAMERA_PREFIX + camId + VIDEO_STATE,
				ts_datapoint: CAMERA_PREFIX + camId + TS_STATE,
				ready_datapoint: CAMERA_PREFIX + camId + READY_STATE,
				error_datapoint: CAMERA_PREFIX + camId + ERROR_STATE,
				unsupported_datapoint: CAMERA_PREFIX + camId + UNSUPPORTED_STATE,
				history: history,
				name: null,
				liveview: null,
				liveCapable: false,
				liveMissing: [],
				liveWarnings: [],
			});
		}
	});

	for (const c of cams) {
		const name = await readStateString(CAMERA_PREFIX + c.id + NAME_STATE);
		if (name) {
			c.name = name;
		}
		const live = await buildLiveviewConfigForCamera(c);
		c.liveview = live.liveview;
		c.liveCapable = !!live.liveview;
		c.liveMissing = live.missing || [];
		c.liveWarnings = live.warnings || [];
		c.syncNetworks = live.syncNetworks || discoverSyncNetworkIds();
		c.accountCandidates = live.accountCandidates || [];

		// Selbstlernender Marker aus dem ioBroker-Adapter:
		// Wenn der Adapter diese Camera bereits als "LiveView nicht unterstützt"
		// erkannt hat (z. B. klassische XT/XT2 ohne immis://-Server), Live-Button sperren.
		const unsupportedStateId = CAMERA_PREFIX + c.id + UNSUPPORTED_STATE;
		if (objectExists(unsupportedStateId)) {
			try {
				const st = await getStateAsync(unsupportedStateId);
				if (st && st.val === true) {
					c.liveCapable = false;
					c.liveMissing = (c.liveMissing || []).concat([
						'Camera model does not support LiveView (detected by adapter)',
					]);
				}
			} catch (e) {
				// State nicht lesbar – nicht weiter schlimm, dann bleibt liveCapable wie gehabt.
			}
		}
	}

	return cams.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

function cleanupHlsDir() {
	try {
		if (!fs.existsSync(HLS_DIR)) {
			fs.mkdirSync(HLS_DIR, { recursive: true });
		}
		const files = fs.readdirSync(HLS_DIR);
		for (const file of files) {
			const full = path.join(HLS_DIR, file);
			try {
				fs.rmSync(full, { recursive: true, force: true });
			} catch (e) {
				log(`HLS file could not be deleted: ${full} / ${e.message}`, 'warn');
			}
		}
		try {
			fs.chmodSync(HLS_DIR, 0o777);
		} catch (e) {}
	} catch (e) {
		log(`HLS cleanup error: ${e.message}`, 'warn');
	}
}

async function stopLiveViewProcess() {
	const pid = liveStatus.pid;
	if (pid) {
		await execPromise(`kill ${shellQuote(pid)} 2>/dev/null || true`);
	}
	await execPromise('pkill -f immi-live-hls || true; pkill -f ffmpeg || true');
	liveStatus.running = false;
	liveStatus.pid = null;
	liveStatus.playlist = fs.existsSync(path.join(HLS_DIR, 'live.m3u8'));
}

function waitForPlaylist(timeoutMs) {
	const start = Date.now();
	const playlist = path.join(HLS_DIR, 'live.m3u8');
	return new Promise(resolve => {
		const t = setInterval(() => {
			const ok = fs.existsSync(playlist) && fs.statSync(playlist).size > 0;
			if (ok) {
				clearInterval(t);
				resolve(true);
				return;
			}
			if (Date.now() - start > timeoutMs) {
				clearInterval(t);
				resolve(false);
			}
		}, 500);
	});
}

async function startLiveForCamera(cameraId, req) {
	const cams = await discoverCameras();
	const cam = cams.find(c => String(c.id) === String(cameraId));
	if (!cam) {
		throw new Error(`Unknown camera ID: ${cameraId}`);
	}
	if (!cam.liveview) {
		throw new Error(
			`LiveView is not configured for camera ${cameraId}: missing ${(cam.liveMissing || []).join(', ')}`,
		);
	}

	const lv = cam.liveview;
	log(`Starting LiveView for camera "${lv.name}" id=${lv.id} type=${lv.type} serial=${lv.serial ? 'yes' : 'no'}`);

	await stopLiveViewProcess();
	cleanupHlsDir();

	const sessionFile = `/tmp/blink_liveview_session_${lv.id}.json`;
	const bridgeLog = `/tmp/blink_liveview_bridge_${lv.id}.log`;
	try {
		fs.rmSync(sessionFile, { force: true });
	} catch (e) {}
	try {
		fs.rmSync('/tmp/blink_liveview_session.json', { force: true });
	} catch (e) {}
	try {
		fs.rmSync(bridgeLog, { force: true });
	} catch (e) {}

	const creds = await readBlinkCredentials();

	const restCmd =
		`cd ${shellQuote(LIVEVIEW_DIR)} && ` +
		`BLINK_EMAIL=${shellQuote(creds.email)} ` +
		`BLINK_PASSWORD=${shellQuote(creds.password)} ` +
		`BLINK_PIN=${shellQuote(creds.pin)} ` +
		`BLINK_ACCOUNT_ID=${shellQuote(lv.accountId)} ` +
		`BLINK_NETWORK_ID=${shellQuote(lv.networkId)} ` +
		`BLINK_DEVICE_TYPE=${shellQuote(lv.type)} ` +
		`BLINK_DEVICE_ID=${shellQuote(lv.id)} ` +
		`BLINK_DEBUG=1 BLINK_POLL_ATTEMPTS=1 ` +
		`/usr/bin/node ${shellQuote(LIVEVIEW_REST_SCRIPT)}`;

	const rest = await execPromise(restCmd, { timeout: 180000 });
	if (rest.err) {
		const msg = rest.stdout || rest.stderr || rest.err.message || 'REST LiveView failed';
		liveStatus.last_error = msg;
		liveStatus.last_log = msg;
		throw new Error(msg);
	}

	if (!fs.existsSync('/tmp/blink_liveview_session.json')) {
		const msg = `REST LiveView did not create a session file. Log: ${rest.stdout || rest.stderr || ''}`;
		liveStatus.last_error = msg;
		liveStatus.last_log = msg;
		throw new Error(msg);
	}
	fs.copyFileSync('/tmp/blink_liveview_session.json', sessionFile);

	const session = safeJson(sessionFile);
	if (!session || !session.server || !String(session.server).startsWith('immis://')) {
		const msg = 'Session file contains no valid immis:// server.';
		liveStatus.last_error = msg;
		liveStatus.last_log = JSON.stringify(session || {}, null, 2).slice(0, 2000);
		// Klassische XT/XT2 melden hier nichts brauchbares – dauerhaft markieren.
		await markCameraUnsupported(cameraId, 'no immis:// server in session');
		throw new Error(msg);
	}
	if (String(session.device_id) !== String(lv.id)) {
		const msg = `Falsche Session-ID: erwartet ${lv.id}, erhalten ${session.device_id}`;
		liveStatus.last_error = msg;
		liveStatus.last_log = JSON.stringify(session || {}, null, 2).slice(0, 2000);
		throw new Error(msg);
	}

	const lfrReject = detectLfrLiveViewRejection(session);
	if (lfrReject) {
		liveStatus.last_error = lfrReject.reason;
		liveStatus.last_log = JSON.stringify(lfrReject.detail, null, 2).slice(0, 4000);
		await markCameraUnsupported(cameraId, lfrReject.reason);
		throw new Error(`${lfrReject.reason}\n${liveStatus.last_log}`);
	}

	const hlsUrl = publicHlsUrl(req);
	const bridgeCmd =
		`cd ${shellQuote(LIVEVIEW_DIR)} && ` +
		`IMMI_SERIAL=${shellQuote(lv.serial)} ` +
		`IMMI_RUNTIME_SECONDS=${shellQuote(LIVEVIEW_RUNTIME_SEC)} ${
			FFMPEG_PATH ? `IMMI_FFMPEG_PATH=${shellQuote(FFMPEG_PATH)} ` : ''
		}NODE_TLS_REJECT_UNAUTHORIZED=0 ` +
		`nohup /usr/bin/node ${shellQuote(LIVEVIEW_HLS_SCRIPT)} ${shellQuote(sessionFile)} > ${shellQuote(
			bridgeLog,
		)} 2>&1 & echo $!`;

	const bridge = await execPromise(bridgeCmd, { timeout: 5000 });
	const pid = String(bridge.stdout || '')
		.trim()
		.split(/\s+/)
		.pop();

	liveStatus = {
		enabled: true,
		// Erst nach erfolgreichem Playlist-Check auf true setzen.
		// Sonst zeigt /live/last-session dem Grid zu frueh einen laufenden Stream.
		running: false,
		pid: pid || null,
		playlist: false,
		hls_url: hlsUrl,
		camera_id: lv.id,
		camera_name: lv.name,
		device_type: lv.type,
		session_file: sessionFile,
		last_error: '',
		last_log: '',
	};

	const ok = await waitForPlaylist(90000);
	liveStatus.playlist = ok;
	liveStatus.running = !!ok;
	liveStatus.last_log = readFileSafe(bridgeLog, 12000);

	if (!ok) {
		liveStatus.running = false;
		liveStatus.last_error = 'HLS playlist was not created.';
		// Bewusst KEINE dauerhafte Markierung hier: "HLS-Playlist nicht erzeugt" kann
		// auch bei Cams auftreten, die LiveView eigentlich können (z. B. min agoi, die erst
		// beim zweiten Anlauf streamt) oder bei temporären Netzproblemen. Die zuverlässige
		// modellbasierte Erkennung (white/xt2) macht bereits der Adapter beim Discovery.
		throw new Error(`HLS playlist was not created. Bridge-Log:\n${liveStatus.last_log}`);
	}

	// Erfolg: einen evtl. zugesetzten unsupported-Marker zuruecknehmen.
	const unsupportedId = CAMERA_PREFIX + cameraId + UNSUPPORTED_STATE;
	if (objectExists(unsupportedId)) {
		try {
			const prev = await getStateAsync(unsupportedId);
			if (prev && prev.val === true) {
				await setStateAsync(unsupportedId, false, true);
				log(`Camera ${cameraId}: unsupported marker removed (LiveView works again).`, 'info');
			}
		} catch (e) {
			/* not critical */
		}
	}

	return {
		ok: true,
		camera_id: lv.id,
		camera_name: lv.name,
		hls_url: hlsUrl,
		pid: liveStatus.pid,
	};
}

function serveFile(req, res, fullPath, contentType, noCache) {
	fs.stat(fullPath, (err, stat) => {
		if (err || !stat.isFile()) {
			res.writeHead(404);
			res.end('File Not Found');
			return;
		}
		const headers = {
			'Content-Type': contentType || 'application/octet-stream',
			'Content-Length': stat.size,
			'Accept-Ranges': 'bytes',
			'Access-Control-Allow-Origin': '*',
		};
		if (noCache) {
			headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
			headers['Pragma'] = 'no-cache';
			headers['Expires'] = '0';
		}
		const range = req.headers.range;
		if (range) {
			const parts = range.replace(/bytes=/, '').split('-');
			const start = parseInt(parts[0], 10);
			const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
			if (!isNaN(start) && !isNaN(end)) {
				res.writeHead(206, {
					...headers,
					'Content-Range': `bytes ${start}-${end}/${stat.size}`,
					'Content-Length': end - start + 1,
				});
				fs.createReadStream(fullPath, { start, end }).pipe(res);
				return;
			}
		}
		res.writeHead(200, headers);
		fs.createReadStream(fullPath).pipe(res);
	});
}

const COMMON_JS = `
const VIDEO_PREFIX = location.protocol + '//' + location.hostname + ':__VIDEO_PORT__' + '__VIDEO_BASE__';
const IOBROKER_URL = location.protocol + '//' + location.hostname + ':__IOBROKER_PORT__';
const HISTORY_SIZE = __HISTORY_SIZE__;

function buildUrl(v, ts) {
  if (!v) return null;
  if (/^https?:\\/\\//.test(v)) return v;
  const fn = encodeURIComponent(String(v).split('/').pop());
  return VIDEO_PREFIX + fn + '?t=' + (ts || Date.now());
}
function formatTs(isoOrMs) {
  if (!isoOrMs) return '';
  const d = new Date(isoOrMs);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
function relativeTime(ms) {
  if (!ms) return '';
  const t = typeof ms === 'string' ? new Date(ms).getTime() : ms;
  if (!t || isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return '' + min + ' min ago';
  const h = Math.floor(min / 60);
  if (h < 24) return '' + h + ' h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return '' + d + ' Tag' + (d===1?'':'en');
  return new Date(t).toLocaleDateString('de-DE');
}
function isVideoValid(value, ready, lastError) {
  if (!value) return false;
  if (lastError && String(lastError).trim() !== '' && String(lastError).toLowerCase() !== 'null') return false;
  if (ready === false) return false;
  return true;
}
`;

const GRID_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blink Cameras</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.3.0/socket.io.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.20/hls.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background:#1a1a1a; color:#eee; font-family:-apple-system,system-ui,sans-serif; min-height:100vh; padding:12px; }
.topbar { display:flex; justify-content:space-between; align-items:center; padding:0 4px 12px; gap:12px; }
.topbar .title { font-size:14px; font-weight:600; }
.status { font-size:11px; padding:3px 8px; border-radius:10px; background:#555; }
.status.ok { background:#2d6a3e; }
.status.err { background:#8b2d2d; }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:12px; }
.cam { background:#2a2a2a; border-radius:10px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:flex; flex-direction:column; }
.cam-head { padding:8px 12px; background:#333; display:flex; justify-content:space-between; align-items:center; gap:8px; }
.cam-name { font-size:13px; font-weight:600; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cam-time { font-size:11px; color:#aaa; flex-shrink:0; }
.cam-content { display:block; position:relative; }
.cam-video-wrap { position:relative; background:#000; aspect-ratio:16/9; cursor:pointer; }
.cam-video-wrap video { width:100%; height:100%; display:block; object-fit:contain; background:#000; }
.cam-video-wrap.live-playing video { object-fit:contain; }
.cam-video-wrap .overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none; background:rgba(0,0,0,0.25); transition:opacity 0.2s; }
.cam-video-wrap.playing .overlay, .cam-video-wrap.live-playing .overlay { opacity:0; }
.cam-video-wrap .play-btn { width:56px; height:56px; border-radius:50%; background:rgba(0,0,0,0.6); border:2px solid rgba(255,255,255,0.8); display:flex; align-items:center; justify-content:center; }
.cam-video-wrap .play-btn::after { content:''; width:0; height:0; margin-left:4px; border-top:10px solid transparent; border-bottom:10px solid transparent; border-left:16px solid white; }
.cam-video-wrap .slot-badge { position:absolute; top:6px; left:6px; background:rgba(0,0,0,0.7); color:white; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; pointer-events:none; }
.cam-empty { aspect-ratio:16/9; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; color:#888; font-size:13px; background:#1a1a1a; padding:8px; text-align:center; }
.cam-empty .err-msg { color:#e88; font-size:11px; white-space:pre-wrap; max-height:160px; overflow:auto; }
.cam-actions { display:flex; align-items:center; gap:8px; padding:8px 12px; border-top:1px solid #383838; background:#252525; flex-wrap:wrap; }
.cam-actions button { border:none; border-radius:7px; padding:6px 10px; color:#fff; cursor:pointer; font-weight:600; }
.cam-actions button.live { background:#19618a; }
.cam-actions button.stop { background:#8b332b; }
.cam-actions button:disabled { opacity:.4; cursor:not-allowed; }
.cam-actions .live-label { color:#bbb; font-size:12px; }
.cam-nav { display:flex; align-items:center; justify-content:space-between; padding:8px 8px; background:#222; gap:8px; border-top:1px solid #383838; }
.cam-nav button { background:#444; color:#eee; border:none; padding:7px 12px; border-radius:7px; font-size:13px; cursor:pointer; min-width:44px; }
.cam-nav button:hover { background:#555; }
.cam-nav button:disabled { opacity:0.35; cursor:not-allowed; }
.cam-nav .label { font-size:12px; color:#bbb; flex:1; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cam-nav .label .source { font-size:9px; padding:1px 4px; border-radius:3px; background:#444; margin-left:4px; vertical-align:middle; }
.cam-nav .label .source.cloud { background:#2d4a6a; }
.cam-nav .label .source.local_storage { background:#4a3a2d; }
</style>
</head>
<body>
<div class="topbar">
  <span class="title">📹 Blink cameras</span>
  <span class="status" id="status">Connecting…</span>
</div>
<div class="grid" id="grid"></div>
<script>
__COMMON_JS__

const $status = document.getElementById('status');
const $grid   = document.getElementById('grid');
let socket;
const cards = {};
let cameras = [];
window.__blinkLiveState = { running:false, camera_id:null, hls_url:null };
window.__blinkLiveStarting = null;
window.__blinkLiveStartSeq = 0;

function setStatus(t, c) { $status.textContent = t; $status.className = 'status' + (c?' '+c:''); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>\"]/g, function(ch){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[ch]; }); }

function attachLiveHls(video, url) {
  if (video._hls) { try { video._hls.destroy(); } catch(e) {} video._hls = null; }
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 8,
      maxLiveSyncPlaybackRate: 1.0,
      backBufferLength: 20,
      maxBufferLength: 20,
      maxMaxBufferLength: 30,
      enableWorker: true
    });

    video._hls = hls;
    video.muted = true;
    video.controls = true;
    video.autoplay = true;

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      video.play().catch(function(e){ console.warn('Video play error:', e); });
    });

    hls.on(Hls.Events.ERROR, function (event, data) {
      console.warn('HLS error:', data);

      if (data && data.details === 'bufferStalledError') {
        try {
          video.currentTime = Math.max(video.currentTime - 0.5, 0);
          video.play().catch(function(){});
        } catch (e) {}
        return;
      }

      if (data && data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          try { hls.startLoad(); } catch (e) {}
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch (e) {}
        } else {
          try { hls.destroy(); } catch (e) {}
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.muted = true;
    video.play().catch(function(){});
  } else {
    console.error('HLS is not supported by this browser');
  }
}

function cleanupVideoElement(el) {
  if (!el) return;
  const vids = el.querySelectorAll ? el.querySelectorAll('video') : [];
  vids.forEach(function(v){ if (v._hls) { try { v._hls.destroy(); } catch(e) {} v._hls = null; } });
}

function clearContent(c) {
  while (c.contentHost.firstChild) {
    cleanupVideoElement(c.contentHost.firstChild);
    c.contentHost.removeChild(c.contentHost.firstChild);
  }
  c.currentMode = null;
  c.liveUrl = null;
}

function buildCard(cam) {
  const card = document.createElement('div');
  card.className = 'cam';
  card.dataset.cam = cam.id;

  const head = document.createElement('div');
  head.className = 'cam-head';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'cam-name';
  nameSpan.textContent = cam.name || ('Camera ' + cam.id);
  const timeSpan = document.createElement('span');
  timeSpan.className = 'cam-time';
  head.appendChild(nameSpan);
  head.appendChild(timeSpan);

  const contentHost = document.createElement('div');
  contentHost.className = 'cam-content';
  const empty = document.createElement('div');
  empty.className = 'cam-empty';
  empty.textContent = 'Lade…';
  contentHost.appendChild(empty);

  const actions = document.createElement('div');
  actions.className = 'cam-actions';
  const liveBtn = document.createElement('button');
  liveBtn.className = 'live';
  liveBtn.textContent = cam.liveCapable ? '📡 Live' : '🚫 No LiveView';
  liveBtn.disabled = !cam.liveCapable;
  liveBtn.title = cam.liveCapable ? 'Start LiveView' : ('LiveView not available: ' + (cam.liveMissing || []).join(', '));
  const stopBtn = document.createElement('button');
  stopBtn.className = 'stop';
  stopBtn.textContent = '▪ Stop';
  stopBtn.disabled = true;
  const liveLabel = document.createElement('span');
  liveLabel.className = 'live-label';
  actions.appendChild(liveBtn);
  actions.appendChild(stopBtn);
  actions.appendChild(liveLabel);

  const nav = document.createElement('div');
  nav.className = 'cam-nav';
  const olderBtn = document.createElement('button');
  olderBtn.textContent = '◀';
  olderBtn.title = 'Older clip';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'Aktuell';
  const currentBtn = document.createElement('button');
  currentBtn.textContent = 'Aktuell';
  currentBtn.title = 'Aktuellen Clip anzeigen';
  const newerBtn = document.createElement('button');
  newerBtn.textContent = '▶';
  newerBtn.title = 'Neuerer Clip';
  nav.appendChild(olderBtn);
  nav.appendChild(label);
  nav.appendChild(currentBtn);
  nav.appendChild(newerBtn);

  card.appendChild(head);
  card.appendChild(contentHost);
  card.appendChild(actions);
  card.appendChild(nav);
  $grid.appendChild(card);

  cards[cam.id] = {
    value: null, ts: null, ready: null, error: null,
    hist: new Array(HISTORY_SIZE).fill(null).map(function(){ return {}; }),
    pickIdx: null,
    root: card, contentHost: contentHost, timeEl: timeSpan,
    olderBtn: olderBtn, newerBtn: newerBtn, currentBtn: currentBtn, label: label,
    liveBtn: liveBtn, stopBtn: stopBtn, liveLabel: liveLabel,
    datapoint: cam.datapoint,
    ts_datapoint: cam.ts_datapoint,
    ready_datapoint: cam.ready_datapoint,
    error_datapoint: cam.error_datapoint,
    history: cam.history,
    name: cam.name || ('Camera ' + cam.id),
    liveCapable: !!cam.liveCapable,
    liveMissing: cam.liveMissing || [],
    currentMode: null,
    liveUrl: null
  };

  olderBtn.addEventListener('click', function(){ navigate(cam.id, +1); });
  newerBtn.addEventListener('click', function(){ navigate(cam.id, -1); });
  currentBtn.addEventListener('click', function(){ cards[cam.id].pickIdx = null; renderCard(cam.id); });
  liveBtn.addEventListener('click', function(){ startLive(cam.id); });
  stopBtn.addEventListener('click', function(){ stopLive(); });
  updateLiveButtons();
}

function updateLiveButtons() {
  Object.keys(cards).forEach(function(id) {
    const c = cards[id];
    const isStarting = window.__blinkLiveStarting && String(window.__blinkLiveStarting) === String(id);
    const isActive = window.__blinkLiveState && window.__blinkLiveState.running &&
      String(window.__blinkLiveState.camera_id) === String(id);

    if (c.liveBtn) {
      c.liveBtn.disabled = !c.liveCapable || isStarting || isActive;
      if (!c.liveCapable) {
        c.liveBtn.textContent = '🚫 No LiveView';
      } else {
        c.liveBtn.textContent = isStarting ? '⏳ Starting…' : (isActive ? '📡 Live running' : '📡 Live');
      }
      c.liveBtn.title = !c.liveCapable
        ? ('LiveView not available: ' + (c.liveMissing || []).join(', '))
        : (isActive ? 'LiveView is already running' : 'Start LiveView');
    }

    if (c.stopBtn) {
      c.stopBtn.disabled = !(isStarting || isActive);
      c.stopBtn.textContent = isStarting ? '✕ Cancel' : '▪ Stop';
      c.stopBtn.title = isStarting ? 'Cancel start/stop LiveView' : (isActive ? 'Stop LiveView' : 'No LiveView aktiv');
    }

    if (c.liveLabel && isStarting) {
      c.liveLabel.textContent = 'Starting LiveView…';
    }
  });
}

function navigate(camId, delta) {
  const c = cards[camId];
  if (!c) return;
  let next = c.pickIdx == null ? 0 : c.pickIdx + delta;
  if (next < 0) { c.pickIdx = null; renderCard(camId); return; }
  if (next >= HISTORY_SIZE) next = HISTORY_SIZE - 1;
  while (next >= 0 && next < HISTORY_SIZE && !c.hist[next].file) next += delta;
  if (next >= 0 && next < HISTORY_SIZE) c.pickIdx = next;
  else c.pickIdx = null;
  renderCard(camId);
}

function setEmpty(c, text, errMsg) {
  clearContent(c);
  const empty = document.createElement('div');
  empty.className = 'cam-empty';
  const main = document.createElement('div');
  main.textContent = text;
  empty.appendChild(main);
  if (errMsg) {
    const sub = document.createElement('div');
    sub.className = 'err-msg';
    sub.textContent = '⚠ ' + errMsg;
    empty.appendChild(sub);
  }
  c.contentHost.appendChild(empty);
}

function renderLiveCard(camId, hlsUrl) {
  const c = cards[camId];
  if (!c) return;

  c.liveLabel.textContent = 'LIVE: ' + c.name + ' (' + camId + ')';
  if (c.timeEl) c.timeEl.textContent = 'LIVE';
  c.label.textContent = 'LIVE · ' + c.name;

  const iframeSrc = '/live-player?camera=' + encodeURIComponent(camId) + '&t=' + Date.now();

  if (c.currentMode === 'live' && c.liveUrl === hlsUrl && c.contentHost.querySelector('iframe')) {
    return;
  }

  clearContent(c);
  c.currentMode = 'live';
  c.liveUrl = hlsUrl;

  const wrap = document.createElement('div');
  wrap.className = 'cam-video-wrap playing live-playing';

  const iframe = document.createElement('iframe');
  iframe.src = iframeSrc;
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.display = 'block';
  iframe.allow = 'autoplay; fullscreen';
  iframe.allowFullscreen = true;
  iframe.title = 'Blink LiveView ' + c.name;

  wrap.appendChild(iframe);
  c.contentHost.appendChild(wrap);
  updateLiveButtons();
}

function renderCard(camId) {
  const c = cards[camId];
  if (!c) return;

  if (window.__blinkLiveState && window.__blinkLiveState.running &&
      String(window.__blinkLiveState.camera_id) === String(camId) &&
      window.__blinkLiveState.hls_url) {
    renderLiveCard(camId, window.__blinkLiveState.hls_url);
    updateNav(c);
    return;
  }

  if (window.__blinkLiveStarting && String(window.__blinkLiveStarting) === String(camId)) {
    c.liveLabel.textContent = 'Starting LiveView…';
  } else {
    c.liveLabel.textContent = '';
  }
  if (c.timeEl) c.timeEl.textContent = c.ts ? relativeTime(c.ts) : '';

  let showFile, showTs, showSource, slotLabel;
  if (c.pickIdx !== null && c.hist[c.pickIdx] && c.hist[c.pickIdx].file) {
    const h = c.hist[c.pickIdx];
    showFile = h.file;
    showTs = h.timestamp;
    showSource = h.source;
    slotLabel = '#' + c.pickIdx;
  } else if (isVideoValid(c.value, c.ready, c.error)) {
    showFile = c.value;
    showTs = c.ts;
    showSource = null;
    slotLabel = null;
    c.pickIdx = null;
  } else {
    const errText = c.error && String(c.error).trim() && String(c.error).toLowerCase() !== 'null' ? String(c.error) : null;
    setEmpty(c, 'No current video', errText);
    updateNav(c);
    return;
  }

  const url = buildUrl(showFile, showTs);
  if (!url) { setEmpty(c, 'No video'); updateNav(c); return; }

  if (c.currentMode === 'clip' && c.clipUrl === url) {
    updateNav(c);
    return;
  }

  clearContent(c);
  c.currentMode = 'clip';
  c.clipUrl = url;

  const wrap = document.createElement('div');
  wrap.className = 'cam-video-wrap';
  wrap.dataset.cam = camId;

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.dataset.cam = camId;

  const source = document.createElement('source');
  source.setAttribute('src', url);
  source.setAttribute('type', 'video/mp4');
  video.appendChild(source);

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const playBtn = document.createElement('div');
  playBtn.className = 'play-btn';
  overlay.appendChild(playBtn);

  wrap.appendChild(video);
  wrap.appendChild(overlay);

  if (slotLabel) {
    const badge = document.createElement('div');
    badge.className = 'slot-badge';
    badge.textContent = slotLabel;
    wrap.appendChild(badge);
  }

  wrap.addEventListener('click', function() {
    if (video.paused) {
      video.controls = true;
      wrap.classList.add('playing');
      video.muted = false;
      video.play().catch(function(){ video.muted = true; video.play().catch(function(){}); });
    }
  });
  video.addEventListener('ended', function(){ wrap.classList.remove('playing'); video.controls = false; });
  video.addEventListener('pause', function(){ if (video.ended) wrap.classList.remove('playing'); });

  c.contentHost.appendChild(wrap);
  video.load();

  let lbl = (slotLabel ? (slotLabel + ' · ') : 'Aktuell · ') + (formatTs(showTs).replace(/, \\d{4}/, '') || '—');
  if (showSource) lbl += '<span class="source ' + showSource + '">' + showSource + '</span>';
  c.label.innerHTML = lbl;

  updateNav(c);
}

function updateNav(c) {
  const nextIdx = c.pickIdx == null ? 0 : c.pickIdx + 1;
  c.olderBtn.disabled = !c.hist.slice(nextIdx).some(function(h){ return h && h.file; });
  c.newerBtn.disabled = c.pickIdx === null;
  c.currentBtn.disabled = c.pickIdx === null;
}

function renderAllCards() {
  Object.keys(cards).forEach(function(id){ renderCard(id); });
}

function updateAllTimes() {
  Object.keys(cards).forEach(function(id) {
    const c = cards[id];
    if (window.__blinkLiveState.running && String(window.__blinkLiveState.camera_id) === String(id)) {
      if (c.timeEl) c.timeEl.textContent = 'LIVE';
    } else if (c.timeEl) {
      c.timeEl.textContent = c.ts ? relativeTime(c.ts) : '';
    }
  });
}
setInterval(updateAllTimes, 30000);

async function refreshLiveState() {
  try {
    const r = await fetch('/live/last-session?t=' + Date.now(), { cache: 'no-store' });
    const j = await r.json();
    const st = j.status || {};
    const oldCam = window.__blinkLiveState.camera_id;
    window.__blinkLiveState = {
      // Erst als LIVE anzeigen, wenn die HLS-Playlist wirklich existiert.
      // Sonst rendert das Grid waehrend des Starts bereits den Player und der Browser
      // zeigt "Playlist nicht verfuegbar: HTTP 404".
      running: !!(st.running && st.hls_url && st.playlist),
      camera_id: st.camera_id || null,
      hls_url: st.hls_url || null
    };
    if (oldCam && String(oldCam) !== String(window.__blinkLiveState.camera_id || '')) renderCard(oldCam);
    if (window.__blinkLiveState.camera_id) renderCard(window.__blinkLiveState.camera_id);
    updateLiveButtons();
  } catch (e) {}
}
setInterval(refreshLiveState, 5000);

async function startLive(camId) {
  const c = cards[camId];
  if (!c || !c.liveCapable) return;

  // Nur ein Startvorgang gleichzeitig. Doppelklicks oder mehrere schnelle Klicks
  // haben vorher mehrere /live/start Requests ausgelöst und den Buttonzustand
  // anschließend durcheinandergebracht.
  if (window.__blinkLiveStarting) return;

  const seq = ++window.__blinkLiveStartSeq;
  window.__blinkLiveStarting = String(camId);
  c.liveLabel.textContent = 'Starting LiveView…';
  updateLiveButtons();

  try {
    const r = await fetch('/live/start?camera=' + encodeURIComponent(camId) + '&t=' + Date.now(), { cache: 'no-store' });
    const text = await r.text();

    // Wurde während des Starts auf Stop geklickt, diese alte Antwort ignorieren.
    if (seq !== window.__blinkLiveStartSeq) return;

    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(text); }
    if (!data.ok) throw new Error(data.error || 'Start failed');

    const previous = window.__blinkLiveState.camera_id;
    window.__blinkLiveState = { running:true, camera_id:String(data.camera_id), hls_url:data.hls_url };
    if (previous && String(previous) !== String(data.camera_id)) renderCard(previous);
    renderCard(data.camera_id);
  } catch (e) {
    if (seq === window.__blinkLiveStartSeq) {
      c.liveLabel.textContent = '';
      setEmpty(c, 'LiveView start error', e.message || String(e));
    }
  } finally {
    if (seq === window.__blinkLiveStartSeq) {
      window.__blinkLiveStarting = null;
      updateLiveButtons();
    }
  }
}

async function stopLive() {
  const old = window.__blinkLiveState.camera_id;
  const starting = window.__blinkLiveStarting;

  // Laufenden Start im Frontend ungültig machen, damit eine verspätete
  // /live/start Antwort den Stop nicht wieder überschreibt.
  window.__blinkLiveStartSeq++;
  window.__blinkLiveStarting = null;
  updateLiveButtons();

  try { await fetch('/live/stop?t=' + Date.now(), { cache: 'no-store' }); } catch (e) {}
  window.__blinkLiveState = { running:false, camera_id:null, hls_url:null };

  if (old) renderCard(old);
  if (starting && String(starting) !== String(old || '')) renderCard(starting);
  renderAllCards();
  updateLiveButtons();
}

fetch('/cameras?t=' + Date.now(), { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(list) {
  cameras = list;
  if (!list.length) {
    setStatus('No cameras', 'err');
    $grid.innerHTML = '<div style="padding:40px;text-align:center;color:#777">No cameras found</div>';
    return;
  }
  list.forEach(buildCard);
  updateLiveButtons();

  if (typeof io === 'undefined') { setStatus('Socket.IO library is missing', 'err'); return; }
  socket = io(IOBROKER_URL, { transports: ['websocket', 'polling'] });
  socket.on('connect', function() {
    setStatus('Verbunden', 'ok');
    list.forEach(function(cam) {
      let pending = 4 + 4 * HISTORY_SIZE;
      const done = function(){ if (--pending === 0) renderCard(cam.id); };

      socket.emit('getState', cam.ts_datapoint, function(e, st){ if (st && st.val) cards[cam.id].ts = st.val; done(); });
      socket.emit('getState', cam.ready_datapoint, function(e, st){ if (st) cards[cam.id].ready = st.val; done(); });
      socket.emit('getState', cam.error_datapoint, function(e, st){ if (st) cards[cam.id].error = st.val; done(); });
      socket.emit('getState', cam.datapoint, function(e, st){ if (st) cards[cam.id].value = st.val; done(); });

      socket.emit('subscribe', cam.datapoint);
      socket.emit('subscribe', cam.ts_datapoint);
      socket.emit('subscribe', cam.ready_datapoint);
      socket.emit('subscribe', cam.error_datapoint);
      if (cam.unsupported_datapoint) {
        socket.emit('subscribe', cam.unsupported_datapoint);
      }

      cam.history.forEach(function(h, idx) {
        socket.emit('getState', h.file_datapoint, function(e, st){ cards[cam.id].hist[idx].file = st ? st.val : null; done(); });
        socket.emit('getState', h.timestamp_datapoint, function(e, st){ cards[cam.id].hist[idx].timestamp = st ? st.val : null; done(); });
        socket.emit('getState', h.id_datapoint, function(e, st){ cards[cam.id].hist[idx].id = st ? st.val : null; done(); });
        socket.emit('getState', h.source_datapoint, function(e, st){ cards[cam.id].hist[idx].source = st ? st.val : null; done(); });
        socket.emit('subscribe', h.file_datapoint);
        socket.emit('subscribe', h.timestamp_datapoint);
        socket.emit('subscribe', h.id_datapoint);
        socket.emit('subscribe', h.source_datapoint);
      });
    });
    refreshLiveState();
  });
  socket.on('disconnect', function(){ setStatus('Disconnected', 'err'); });
  socket.on('connect_error', function(e){ setStatus('Connection error', 'err'); console.error(e); });
  socket.on('stateChange', function(id, state) {
    if (!state) return;
    for (const cam of list) {
      if (id === cam.datapoint)        { cards[cam.id].value = state.val; cards[cam.id].ts = state.ts || cards[cam.id].ts; renderCard(cam.id); return; }
      if (id === cam.ts_datapoint)     { if (state.val) cards[cam.id].ts = state.val; renderCard(cam.id); return; }
      if (id === cam.ready_datapoint)  { cards[cam.id].ready = state.val; renderCard(cam.id); return; }
      if (id === cam.error_datapoint)  { cards[cam.id].error = state.val; renderCard(cam.id); return; }
      if (id === cam.unsupported_datapoint) {
        const UNSUPPORTED_MSG = 'Camera model does not support LiveView (detected by adapter)';
        const isUnsupported = state.val === true;
        // Basis-liveMissing aus dem Discovery beibehalten, nur unseren Marker togglen.
        const baseMissing = (cam.liveMissing || []).filter(function(m){ return m !== UNSUPPORTED_MSG; });
        if (isUnsupported) {
          cards[cam.id].liveCapable = false;
          cards[cam.id].liveMissing = baseMissing.concat([UNSUPPORTED_MSG]);
        } else {
          // Adapter hat die Sperre aufgehoben – auf den Original-Discovery-Stand zurück.
          cards[cam.id].liveCapable = !!cam.liveCapable;
          cards[cam.id].liveMissing = baseMissing;
        }
        updateLiveButtons();
        return;
      }
      for (let idx = 0; idx < HISTORY_SIZE; idx++) {
        const h = cam.history[idx];
        if (id === h.file_datapoint)      { cards[cam.id].hist[idx].file = state.val; renderCard(cam.id); return; }
        if (id === h.timestamp_datapoint) { cards[cam.id].hist[idx].timestamp = state.val; renderCard(cam.id); return; }
        if (id === h.id_datapoint)        { cards[cam.id].hist[idx].id = state.val; renderCard(cam.id); return; }
        if (id === h.source_datapoint)    { cards[cam.id].hist[idx].source = state.val; renderCard(cam.id); return; }
      }
    }
  });
}).catch(function(e){ setStatus('Server error', 'err'); console.error(e); });
</script>
</body>
</html>`;

function buildHTML(template) {
	return template
		.replace('__COMMON_JS__', COMMON_JS)
		.replace(/__VIDEO_BASE__/g, VIDEO_BASE)
		.replace(/__VIDEO_PORT__/g, PORT)
		.replace(/__IOBROKER_PORT__/g, IOBROKER_PORT)
		.replace(/__HISTORY_SIZE__/g, HISTORY_SIZE);
}
const GRID_PAGE = buildHTML(GRID_HTML);

const MIME = {
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.html': 'text/html; charset=utf-8',
	'.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
	try {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		const parsed = new URL(req.url, 'http://localhost');
		const urlPath = parsed.pathname;

		if (urlPath === '/cameras') {
			const cams = await discoverCameras();
			res.writeHead(200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
			});
			res.end(JSON.stringify(cams));
			return;
		}

		if (urlPath === '/live/debug-cameras' || urlPath === '/debug-cameras') {
			const cams = await discoverCameras();
			const out = cams.map(c => ({
				id: c.id,
				name: c.name,
				liveview: c.liveview
					? {
							id: c.liveview.id,
							name: c.liveview.name,
							accountId: c.liveview.accountId,
							accountSource: c.liveview.accountSource,
							accountCandidates: c.liveview.accountCandidates || c.accountCandidates || [],
							networkId: c.liveview.networkId,
							networkSource: c.liveview.networkSource,
							type: c.liveview.type,
							hasSerial: !!c.liveview.serial,
						}
					: null,
				missing: c.liveMissing || [],
				warnings: c.liveWarnings || [],
				accountCandidates: c.accountCandidates || [],
				syncNetworks: c.syncNetworks || [],
			}));
			res.writeHead(200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
			});
			res.end(JSON.stringify(out, null, 2));
			return;
		}

		if (urlPath === '/live/start') {
			const cameraId = parsed.searchParams.get('camera');
			if (!cameraId) {
				res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify({ ok: false, error: 'camera is missing' }));
				return;
			}

			// Schutz: vom Adapter als "kein LiveView möglich" markierte Kameras gleich abweisen.
			const unsupportedStateId = CAMERA_PREFIX + cameraId + UNSUPPORTED_STATE;
			if (objectExists(unsupportedStateId)) {
				try {
					const st = await getStateAsync(unsupportedStateId);
					if (st && st.val === true) {
						log(`LiveView fuer Camera ${cameraId} blocked: marked as unsupported by the adapter.`, 'warn');
						res.writeHead(409, {
							'Content-Type': 'application/json; charset=utf-8',
							'Cache-Control': 'no-cache, no-store, must-revalidate',
						});
						res.end(
							JSON.stringify({
								ok: false,
								error: 'Camera model does not support LiveView (detected by adapter)',
								unsupported: true,
							}),
						);
						return;
					}
				} catch (e) {
					// State nicht lesbar – wir fahren normal fort.
				}
			}

			try {
				const out = await startLiveForCamera(cameraId, req);
				res.writeHead(200, {
					'Content-Type': 'application/json; charset=utf-8',
					'Cache-Control': 'no-cache, no-store, must-revalidate',
				});
				res.end(JSON.stringify(out));
			} catch (e) {
				log(`LiveView start error fuer Camera ${cameraId}: ${e.message || e}`, 'warn');
				res.writeHead(500, {
					'Content-Type': 'application/json; charset=utf-8',
					'Cache-Control': 'no-cache, no-store, must-revalidate',
				});
				res.end(JSON.stringify({ ok: false, error: e.message || String(e), status: liveStatus }));
			}
			return;
		}

		if (urlPath === '/live/stop') {
			await stopLiveViewProcess();
			liveStatus.running = false;
			liveStatus.pid = null;
			liveStatus.playlist = fs.existsSync(path.join(HLS_DIR, 'live.m3u8'));
			res.writeHead(200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
			});
			res.end(JSON.stringify({ ok: true, status: liveStatus }));
			return;
		}

		if (urlPath === '/live/last-session') {
			liveStatus.playlist = fs.existsSync(path.join(HLS_DIR, 'live.m3u8'));
			if (!liveStatus.playlist) {
				// Waehrend des Startvorgangs darf der Status noch nicht als laufender LiveView
				// im Frontend erscheinen. Erst vorhandene Playlist = wirklich laufend.
				liveStatus.running = false;
			}
			let session = null;
			if (liveStatus.session_file) {
				const raw = safeJson(liveStatus.session_file);
				if (raw) {
					session = {
						device_id: raw.device_id,
						device_type: raw.device_type,
						command_id: raw.command_id,
						state_condition: raw.state_condition,
						status_msg: raw.status_msg,
						server_present: !!raw.server,
						token_present: !!raw.liveview_token,
					};
				}
			}
			res.writeHead(200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
			});
			res.end(JSON.stringify({ status: liveStatus, session: session }, null, 2));
			return;
		}

		if (urlPath === '/live-player') {
			const html = String.raw`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blink LiveView</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.20/hls.min.js"></script>
<style>
html, body { margin:0; padding:0; width:100%; height:100%; background:#000; overflow:hidden; }
body { display:flex; align-items:center; justify-content:center; }
video { width:100%; height:100%; background:#000; object-fit:contain; }
.status { position:absolute; left:8px; bottom:8px; color:#fff; background:rgba(0,0,0,.68); padding:4px 8px; border-radius:6px; font:12px system-ui,-apple-system,sans-serif; max-width:calc(100% - 16px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; z-index:5; }
</style>
</head>
<body>
<video id="v" controls autoplay muted playsinline></video>
<div class="status" id="s">Warte auf LiveView-Playlist…</div>
<script>
(function(){
  const video = document.getElementById('v');
  const statusEl = document.getElementById('s');
  const manifestUrl = '/live-hls/live.m3u8';
  let hls = null;
  let manifestAttempts = 0;
  let started = false;

  function setStatus(t) {
    statusEl.style.display = '';
    statusEl.textContent = t;
  }

  function hideStatusSoon() {
    setTimeout(function(){ statusEl.style.display = 'none'; }, 2500);
  }

  async function waitForManifest() {
    manifestAttempts++;
    setStatus('Warte auf Playlist… ' + manifestAttempts);

    try {
      const r = await fetch(manifestUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      if (txt.indexOf('#EXTM3U') < 0) throw new Error('no M3U8');
      if (txt.indexOf('#EXTINF') < 0 || txt.indexOf('.ts') < 0) throw new Error('no segments yet');
      startPlayer();
      return;
    } catch (e) {
      if (manifestAttempts < 80) {
        setTimeout(waitForManifest, 500);
      } else {
        setStatus('Playlist not available: ' + (e && e.message ? e.message : e));
      }
    }
  }

  function playVideo() {
    video.muted = true;
    video.controls = true;
    video.play().then(function(){
      setStatus('LiveView running');
      hideStatusSoon();
    }).catch(function(){
      setStatus('Autoplay blockiert – bitte ins Video klicken');
    });
  }

  function destroyHls() {
    if (hls) {
      try { hls.destroy(); } catch(e) {}
      hls = null;
    }
  }

  function restartSoon(reason) {
    setStatus('HLS Neustart: ' + reason);
    destroyHls();
    started = false;
    manifestAttempts = 0;
    setTimeout(waitForManifest, 1000);
  }

  function startPlayer() {
    if (started) return;
    started = true;
    const url = manifestUrl + '?t=' + Date.now();

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: false,
        liveSyncDurationCount: 4,
        liveMaxLatencyDurationCount: 8,
        maxLiveSyncPlaybackRate: 1.0,
        backBufferLength: 20,
        maxBufferLength: 20,
        maxMaxBufferLength: 30,
        enableWorker: true,
        startFragPrefetch: true,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 20,
        manifestLoadingRetryDelay: 500,
        manifestLoadingMaxRetryTimeout: 5000,
        levelLoadingMaxRetry: 20,
        levelLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 12,
        fragLoadingRetryDelay: 500
      });

      hls.on(Hls.Events.MEDIA_ATTACHED, function () {
        setStatus('Player verbunden, lade Manifest…');
        hls.loadSource(url);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        setStatus('Manifest geladen');
        playVideo();
      });

      hls.on(Hls.Events.ERROR, function (event, data) {
        console.warn('HLS error:', data);
        const details = data && data.details ? data.details : 'Error';
        setStatus('HLS: ' + details);

        if (details === 'bufferStalledError') {
          try { hls.startLoad(-1); } catch(e) {}
          try { video.play().catch(function(){}); } catch(e) {}
          return;
        }

        if (details === 'manifestLoadError' || details === 'manifestLoadTimeOut') {
          if (data && data.fatal) restartSoon(details);
          return;
        }

        if (data && data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try { hls.startLoad(); } catch(e) { restartSoon(details); }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try { hls.recoverMediaError(); } catch(e) { restartSoon(details); }
          } else {
            restartSoon(details);
          }
        }
      });

      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      playVideo();
    } else {
      setStatus('HLS is not supported');
    }
  }

  video.addEventListener('click', function(){ video.play().catch(function(){}); });
  video.addEventListener('playing', function(){ setStatus('LiveView running'); hideStatusSoon(); });
  video.addEventListener('waiting', function(){ setStatus('Puffert…'); });
  video.addEventListener('error', function(){ setStatus('Video-Error'); });

  waitForManifest();
})();
</script>
</body>
</html>`;
			res.writeHead(200, {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
			});
			res.end(html);
			return;
		}

		if (urlPath === '/grid' || urlPath === '/grid.html' || urlPath === '/' || urlPath === '/index.html') {
			res.writeHead(200, {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
			});
			res.end(GRID_PAGE);
			return;
		}

		if (urlPath.startsWith('/live-hls/')) {
			const filename = decodeURIComponent(urlPath.slice('/live-hls/'.length));
			if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
				res.writeHead(403);
				res.end('Forbidden');
				return;
			}
			const ext = path.extname(filename).toLowerCase();
			const type =
				ext === '.m3u8'
					? 'application/vnd.apple.mpegurl'
					: ext === '.ts'
						? 'video/mp2t'
						: 'application/octet-stream';
			serveFile(req, res, path.join(HLS_DIR, filename), type, true);
			return;
		}

		if (urlPath.startsWith(VIDEO_BASE)) {
			const filename = decodeURIComponent(urlPath.slice(VIDEO_BASE.length));
			if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
				res.writeHead(403);
				res.end('Forbidden');
				return;
			}
			const fullPath = path.join(ROOT_DIR, filename);
			if (!fullPath.startsWith(ROOT_DIR)) {
				res.writeHead(403);
				res.end('Forbidden');
				return;
			}
			const ext = path.extname(filename).toLowerCase();
			serveFile(req, res, fullPath, MIME[ext] || 'application/octet-stream', ext === '.mp4');
			return;
		}

		res.writeHead(404);
		res.end('Not Found');
	} catch (e) {
		log(`Server-Request Error: ${e.stack || e.message || e}`, 'error');
		try {
			res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end(`Server error: ${e.message || e}`);
		} catch (ignore) {}
	}
});

server.listen(PORT, () => {
	log(`Blink server running: http://<host>:${PORT}/grid`);
});
server.on('error', err => log(`Blink-Server Error: ${err.message}`, 'error'));

globalThis.__blinkServer = server;

onStop(() => {
	if (server) {
		server.close();
		log('Blink server stopped');
	}
	try {
		stopLiveViewProcess();
	} catch (e) {}
}, 2000);
