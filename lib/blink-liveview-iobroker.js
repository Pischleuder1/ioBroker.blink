#!/usr/bin/env node
'use strict';

/**
 * Blink LiveView helper for ioBroker / Node.js
 *
 * Uses your existing ./blink-api.js only for login/session handling.
 * This file does NOT play video. It starts a Blink LiveView session, polls
 * the command endpoint and returns the session/status data as JSON.
 *
 * Confirmed for: owl, doorbell. Camera endpoint is included as experimental.
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_OUTPUT = '/tmp/blink_liveview_session.json';
const DEFAULT_DEBUG_LOG = '/tmp/blink_liveview_iobroker_debug.log';

function env(name, fallback = undefined) {
	const value = process.env[name];
	return value === undefined || value === '' ? fallback : value;
}

function boolEnv(name, fallback = false) {
	const value = env(name);
	if (value === undefined) {
		return fallback;
	}
	return /^(1|true|yes|y|j|ja)$/i.test(String(value).trim());
}

function numberEnv(name, fallback) {
	const value = env(name);
	if (value === undefined) {
		return fallback;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function appendDebug(message) {
	if (!boolEnv('BLINK_DEBUG', false)) {
		return;
	}
	const line = `[${new Date().toISOString()}] ${message}\n`;
	fs.appendFileSync(env('BLINK_DEBUG_LOG', DEFAULT_DEBUG_LOG), line);
}

function normalizeApiHost(apiHost) {
	if (!apiHost) {
		throw new Error('apiHost is missing. Login session contains no API host.');
	}
	let host = String(apiHost).trim();
	host = host.replace(/^https?:\/\//i, '');
	host = host.replace(/\/api\/?$/i, '');
	host = host.replace(/\/$/, '');
	return host;
}

function buildUrl(apiHost, pathName) {
	const host = normalizeApiHost(apiHost);
	const cleanPath = String(pathName).startsWith('/') ? String(pathName) : `/${pathName}`;
	return `https://${host}${cleanPath}`;
}

function readJsonResponse(res, rawBody, method, urlPath) {
	const contentType = String(res.headers['content-type'] || '');
	if (!rawBody) {
		return null;
	}
	if (contentType.includes('application/json') || /^[\s\r\n]*[[{]/.test(rawBody)) {
		try {
			return JSON.parse(rawBody);
		} catch (err) {
			throw new Error(`Response was not valid JSON for ${method} ${urlPath}: ${err.message}\nBody=${rawBody}`);
		}
	}
	return rawBody;
}

/**
 * Runs an HTTP(S) request against the Blink API and parses the JSON response.
 *
 * @param {object} root0 - Request-Optionen.
 * @param {string} root0.apiHost - Der API-Host der Blink-Session.
 * @param {string} root0.token - Der Bearer-Access-Token.
 * @param {string} [root0.method] - Die HTTP-Methode.
 * @param {string} root0.path - Der Request-Pfad.
 * @param {object} [root0.body] - Optionaler Request-Body (wird als JSON gesendet).
 * @param {number} [root0.timeoutMs] - Timeout in Millisekunden.
 * @returns {Promise<object|string|null>} Die geparste Antwort.
 */
function requestJson({ apiHost, token, method = 'GET', path: urlPath, body = undefined, timeoutMs = 30000 }) {
	return new Promise((resolve, reject) => {
		const url = new URL(buildUrl(apiHost, urlPath));
		const payload = body === undefined ? undefined : JSON.stringify(body);

		const headers = {
			Accept: 'application/json',
			'User-Agent': 'Blink/ios ioBroker-liveview-test',
		};

		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}

		if (payload !== undefined) {
			headers['Content-Type'] = 'application/json';
			headers['Content-Length'] = Buffer.byteLength(payload);
		}

		const options = {
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port || 443,
			path: `${url.pathname}${url.search}`,
			method,
			headers,
			timeout: timeoutMs,
		};

		appendDebug(`${method} ${url.href}`);
		if (payload !== undefined) {
			appendDebug(`REQUEST_BODY ${payload}`);
		}

		const req = https.request(options, res => {
			let raw = '';
			res.setEncoding('utf8');
			res.on('data', chunk => {
				raw += chunk;
			});
			res.on('end', () => {
				appendDebug(`RESPONSE ${res.statusCode} ${method} ${urlPath}: ${raw}`);
				const parsed = readJsonResponse(res, raw, method, urlPath);
				if (res.statusCode < 200 || res.statusCode >= 300) {
					const err = new Error(`HTTP ${res.statusCode} bei ${method} ${urlPath}`);
					err.statusCode = res.statusCode;
					err.body = parsed;
					err.rawBody = raw;
					return reject(err);
				}
				resolve(parsed);
			});
		});

		req.on('timeout', () => {
			req.destroy(new Error(`Timeout nach ${timeoutMs}ms bei ${method} ${urlPath}`));
		});
		req.on('error', reject);
		if (payload !== undefined) {
			req.write(payload);
		}
		req.end();
	});
}

function getTokenFromSession(session) {
	return (
		session &&
		(session.accessToken || session.access_token || session.token || session.authToken || session.auth_token)
	);
}

function getApiHostFromSession(session) {
	return session && (session.apiHost || session.api_host || session.host || session.restHost || session.regionHost);
}

function getAccountIdFromSession(session) {
	return (
		env('BLINK_ACCOUNT_ID') ||
		(session &&
			(session.accountId ||
				session.account_id ||
				(session.account && (session.account.id || session.account.account_id)) ||
				(session.user && (session.user.account_id || session.user.accountId))))
	);
}

/**
 * Baut den LiveView-Start-Pfad abhängig vom device type.
 *
 * @param {object} root0 - Pfad-Parameter.
 * @param {string|number} root0.accountId - Die Account-ID.
 * @param {string|number} root0.networkId - Die Netzwerk-ID.
 * @param {string} root0.deviceType - Der device type (owl, doorbell, camera).
 * @param {string|number} root0.deviceId - Die device ID.
 * @returns {string} Der LiveView-Start-Pfad.
 */
function liveViewStartPath({ accountId, networkId, deviceType, deviceId }) {
	const type = String(deviceType || '').toLowerCase();
	if (type === 'owl') {
		return `/api/v2/accounts/${accountId}/networks/${networkId}/owls/${deviceId}/liveview`;
	}
	if (type === 'doorbell' || type === 'lotus') {
		return `/api/v2/accounts/${accountId}/networks/${networkId}/doorbells/${deviceId}/liveview`;
	}

	// Experimental. The classic camera endpoint was not confirmed in the same way
	// as owl/doorbell in the decompiled Android sources.
	if (type === 'camera' || type === 'classic') {
		return `/api/v6/accounts/${accountId}/networks/${networkId}/cameras/${deviceId}/liveview`;
	}

	throw new Error(`Unbekannter Device-Type: ${deviceType}. Erlaubt: owl, doorbell, camera`);
}

/**
 * Builds the poll path for a LiveView command.
 *
 * @param {object} root0 - Pfad-Parameter.
 * @param {string|number} root0.accountId - Die Account-ID.
 * @param {string|number} root0.networkId - Die Netzwerk-ID.
 * @param {string|number} root0.commandId - Die Command-ID.
 * @returns {string} Der Poll-Pfad.
 */
function pollPath({ accountId, networkId, commandId }) {
	// Important: Android CommandApi uses a leading slash endpoint. In practice this
	// is NOT below /api, unlike the liveview POST endpoint.
	return `/accounts/${accountId}/networks/${networkId}/commands/${commandId}`;
}

function extractFirstCommand(pollResponse) {
	if (!pollResponse || !Array.isArray(pollResponse.commands) || pollResponse.commands.length === 0) {
		return null;
	}
	return pollResponse.commands[0];
}

/**
 * Fasst Start- und Poll-Daten einer LiveView-Session zu einem JSON-Objekt zusammen.
 *
 * @param {object} root0 - Zusammenfassungs-Parameter.
 * @param {string} root0.startPath - Der verwendete Start-Pfad.
 * @param {string} [root0.pollUsedPath] - Der verwendete Poll-Pfad.
 * @param {object} root0.start - Die Antwort des Start-Requests.
 * @param {object} [root0.poll] - Die Antwort des Poll-Requests.
 * @param {string} root0.deviceType - Der device type.
 * @param {string|number} root0.deviceId - Die device ID.
 * @param {string|number} root0.networkId - Die Netzwerk-ID.
 * @param {string|number} root0.accountId - Die Account-ID.
 * @param {string} [root0.deviceSerial] - Die device serial number.
 * @returns {object} Die zusammengefasste Session-Info.
 */
function summarizeLiveView({
	startPath,
	pollUsedPath,
	start,
	poll,
	deviceType,
	deviceId,
	networkId,
	accountId,
	deviceSerial,
}) {
	const command = extractFirstCommand(poll);
	const commandId = start.command_id || start.commandId || (command && command.id);
	return {
		ok: true,
		note: 'REST/API-Sessiondaten. Video selbst benoetigt den nativen Blink-Walnut-Player.',
		account_id: Number(accountId),
		network_id: Number(networkId),
		device_type: deviceType,
		device_id: Number(deviceId),
		device_serial: deviceSerial || null,
		start_path: startPath,
		poll_path: pollUsedPath || null,
		command_id: commandId || null,
		parent_command_id:
			start.parent_command_id || start.parentCommandId || (command && command.parent_command_id) || null,
		server: start.server || (command && command.server) || null,
		liveview_token: start.liveview_token || start.liveViewToken || null,
		duration: start.duration ?? null,
		extended_duration: start.extended_duration ?? null,
		continue_interval: start.continue_interval ?? null,
		continue_warning: start.continue_warning ?? null,
		polling_interval: start.polling_interval || start.pollingIntervalInSeconds || null,
		is_mclv: start.is_mclv ?? start.isMultiClientLiveViewSession ?? null,
		first_joiner: start.first_joiner ?? start.isFirstJoiner ?? null,
		type: start.type || start.liveViewType || (command && command.command) || null,
		complete: poll ? poll.complete : null,
		status: poll ? poll.status : null,
		status_msg: poll ? poll.status_msg : null,
		status_code: poll ? poll.status_code : null,
		state_condition: command ? command.state_condition : null,
		state_stage: command ? command.state_stage : null,
		transaction: command ? command.transaction : null,
		player_transaction: command ? command.player_transaction : null,
		media_id: poll ? poll.media_id : start.media_id || null,
		raw_start: start,
		raw_poll: poll || null,
		created_at: new Date().toISOString(),
	};
}

/**
 * Starts a LiveView session via the Blink API.
 *
 * @param {object} root0 - Start-Parameter.
 * @param {string} root0.apiHost - Der API-Host.
 * @param {string} root0.token - Der Access-Token.
 * @param {string|number} root0.accountId - Die Account-ID.
 * @param {string|number} root0.networkId - Die Netzwerk-ID.
 * @param {string} root0.deviceType - Der device type.
 * @param {string|number} root0.deviceId - Die device ID.
 * @param {string} [root0.deviceSerial] - Die Seriennummer.
 * @param {string} [root0.intent] - Der Intent-Parameter.
 * @returns {Promise<object>} Start-Pfad, Start-Antwort und Zusammenfassung.
 */
async function startLiveView({
	apiHost,
	token,
	accountId,
	networkId,
	deviceType,
	deviceId,
	deviceSerial,
	intent = 'liveview',
}) {
	const startPath = liveViewStartPath({ accountId, networkId, deviceType, deviceId });
	const body = {
		intent,
		motion_event_start_time: null,
	};
	const start = await requestJson({ apiHost, token, method: 'POST', path: startPath, body });
	return {
		startPath,
		start,
		summary: summarizeLiveView({ startPath, start, deviceType, deviceId, networkId, accountId, deviceSerial }),
	};
}

/**
 * Pollt den Command-Endpoint einer LiveView-Session.
 *
 * @param {object} root0 - Poll-Parameter.
 * @param {string} root0.apiHost - Der API-Host.
 * @param {string} root0.token - Der Access-Token.
 * @param {string|number} root0.accountId - Die Account-ID.
 * @param {string|number} root0.networkId - Die Netzwerk-ID.
 * @param {string|number} root0.commandId - Die Command-ID.
 * @param {number} [root0.attempts] - Anzahl der Poll-Versuche.
 * @param {number} [root0.intervalSeconds] - Wartezeit zwischen Versuchen in Sekunden.
 * @param {boolean} [root0.stopOnComplete] - Stop as soon as complete=true.
 * @returns {Promise<object>} Verwendeter Pfad und letzte Poll-Antwort.
 */
async function pollLiveView({
	apiHost,
	token,
	accountId,
	networkId,
	commandId,
	attempts = 3,
	intervalSeconds = 15,
	stopOnComplete = true,
}) {
	const usedPath = pollPath({ accountId, networkId, commandId });
	let last = null;

	for (let i = 1; i <= attempts; i++) {
		if (i > 1 || intervalSeconds > 0) {
			await sleep(intervalSeconds * 1000);
		}
		console.error(`Poll ${i}/${attempts}: GET ${usedPath}`);
		last = await requestJson({ apiHost, token, method: 'GET', path: usedPath });
		if (stopOnComplete && last && last.complete === true) {
			break;
		}
	}

	return { path: usedPath, poll: last };
}

/**
 * Starts a LiveView session and then polls the command endpoint.
 *
 * @param {object} options - options for start and poll (siehe startLiveView und pollLiveView).
 * @returns {Promise<object>} Die zusammengefasste Session-Info.
 */
async function startLiveViewAndPoll(options) {
	const started = await startLiveView(options);
	const start = started.start;
	const commandId = start.command_id || start.commandId;
	if (!commandId) {
		throw new Error(`LiveView start returned no command_id: ${JSON.stringify(start)}`);
	}

	const intervalSeconds = numberEnv(
		'BLINK_POLL_INTERVAL',
		Number(start.polling_interval || start.pollingIntervalInSeconds || options.pollIntervalSeconds || 15),
	);
	const attempts = numberEnv('BLINK_POLL_ATTEMPTS', options.pollAttempts || 3);

	let pollResult = null;
	if (!boolEnv('BLINK_NO_POLL', false)) {
		console.error(`command_id=${commandId}, polling_interval=${intervalSeconds}s, attempts=${attempts}`);
		pollResult = await pollLiveView({
			...options,
			commandId,
			attempts,
			intervalSeconds,
			stopOnComplete: boolEnv('BLINK_STOP_ON_COMPLETE', true),
		});
	}

	return summarizeLiveView({
		startPath: started.startPath,
		pollUsedPath: pollResult && pollResult.path,
		start,
		poll: pollResult && pollResult.poll,
		deviceType: options.deviceType,
		deviceId: options.deviceId,
		networkId: options.networkId,
		accountId: options.accountId,
		deviceSerial: options.deviceSerial,
	});
}

async function question(prompt, { silent = false, defaultValue = '' } = {}) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const q = defaultValue ? `${prompt} [${defaultValue}]: ` : `${prompt}: `;

	if (!silent) {
		return new Promise(resolve =>
			rl.question(q, answer => {
				rl.close();
				resolve(answer || defaultValue);
			}),
		);
	}

	// Password-like input without echo. Works well enough for terminal use.
	return new Promise(resolve => {
		const stdin = process.stdin;
		const stdout = process.stdout;
		stdout.write(q);
		let value = '';
		stdin.setRawMode && stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');
		function onData(ch) {
			ch = String(ch);
			if (ch === '\r' || ch === '\n' || ch === '\u0004') {
				stdout.write('\n');
				stdin.setRawMode && stdin.setRawMode(false);
				stdin.pause();
				stdin.removeListener('data', onData);
				rl.close();
				resolve(value || defaultValue);
			} else if (ch === '\u0003') {
				process.exit(130);
			} else if (ch === '\u007f') {
				value = value.slice(0, -1);
			} else {
				value += ch;
			}
		}
		stdin.on('data', onData);
	});
}

async function getLoginSession() {
	const loginModulePath = path.resolve(process.cwd(), env('BLINK_LOGIN_MODULE', './blink-api.js'));
	if (!fs.existsSync(loginModulePath)) {
		throw new Error(`Existing blink-api.js not found: ${loginModulePath}`);
	}

	const existing = require(loginModulePath);
	const getSession = existing.getSession || (existing.default && existing.default.getSession);
	const login = existing.login || (existing.default && existing.default.login);

	const email = env('BLINK_EMAIL') || (await question('Blink E-Mail'));
	const password = env('BLINK_PASSWORD') || (await question('Blink Passwort', { silent: true }));
	const pin = env('BLINK_PIN') || (await question('Blink PIN / 2FA-Code', { defaultValue: '' }));

	console.error('Login using existing blink-api.js ...');
	if (typeof getSession === 'function') {
		return getSession(email, password, pin);
	}
	if (typeof login === 'function') {
		return login(email, password, pin);
	}
	throw new Error('Die vorhandene blink-api.js exportiert weder getSession noch login.');
}

async function cli() {
	try {
		const session = await getLoginSession();
		const token = getTokenFromSession(session);
		const apiHost = env('BLINK_API_HOST') || getApiHostFromSession(session);
		const accountId = getAccountIdFromSession(session) || (await question('Account-ID'));
		const networkId = env('BLINK_NETWORK_ID') || (await question('Network-ID'));
		const deviceType =
			env('BLINK_DEVICE_TYPE') ||
			(await question('Device-Type (owl, doorbell, camera)', { defaultValue: 'owl' }));
		const deviceId = env('BLINK_DEVICE_ID') || (await question('Device-ID'));
		const deviceSerial = env('BLINK_DEVICE_SERIAL') || null;

		if (!token) {
			throw new Error('Login OK, but no accessToken/token found in session.');
		}
		if (!apiHost) {
			throw new Error('Login OK, but no apiHost found in session.');
		}
		if (!accountId) {
			throw new Error('Account ID is missing. Set BLINK_ACCOUNT_ID.');
		}
		if (!networkId) {
			throw new Error('Network ID is missing. Set BLINK_NETWORK_ID.');
		}
		if (!deviceId) {
			throw new Error('Device ID is missing. Set BLINK_DEVICE_ID.');
		}

		console.error(`Login OK. API host: ${apiHost}`);
		console.error(`Account-ID: ${accountId}`);
		console.error(`Network-ID: ${networkId}`);
		console.error(`Device-Type: ${deviceType}`);
		console.error(`Device-ID: ${deviceId}`);

		const result = await startLiveViewAndPoll({
			apiHost,
			token,
			accountId,
			networkId,
			deviceType,
			deviceId,
			deviceSerial,
		});

		const output = env('BLINK_OUTPUT', DEFAULT_OUTPUT);
		fs.writeFileSync(output, JSON.stringify(result, null, 2));
		console.error(`\nLiveView JSON gespeichert: ${output}`);
		console.log(JSON.stringify(result, null, 2));
	} catch (err) {
		const output = env('BLINK_OUTPUT', DEFAULT_OUTPUT);
		const failure = {
			ok: false,
			error: err.message,
			statusCode: err.statusCode || null,
			body: err.body || null,
			rawBody: err.rawBody || null,
			created_at: new Date().toISOString(),
		};
		try {
			fs.writeFileSync(output, JSON.stringify(failure, null, 2));
		} catch {
			// Writing the error file itself failed; intentionally ignored.
		}
		console.error('\nFEHLER:');
		console.error(err.stack || err.message);
		if (err.body || err.rawBody) {
			console.error('\nAntwort vom Server:');
			console.error(typeof err.body === 'string' ? err.body : JSON.stringify(err.body || err.rawBody, null, 2));
		}
		console.error(`\nDebug-Log: ${env('BLINK_DEBUG_LOG', DEFAULT_DEBUG_LOG)}`);
		process.exit(1);
	}
}

module.exports = {
	requestJson,
	startLiveView,
	pollLiveView,
	startLiveViewAndPoll,
	liveViewStartPath,
	pollPath,
	summarizeLiveView,
};

if (require.main === module) {
	cli();
}
