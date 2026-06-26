'use strict';

/**
 * Blink API Client
 * Optional debug logging to /tmp/blink_debug.log.
 * Sensitive values are redacted before they are written to the debug log.
 */

const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URLSearchParams } = require('node:url');

const DEBUG_LOG = '/tmp/blink_debug.log';
let DEBUG_ENABLED = false;

/**
 * Enables or disables debug logging to /tmp/blink_debug.log.
 *
 * @param {boolean} v - true enables logging, false disables it.
 */
function setDebugEnabled(v) {
	DEBUG_ENABLED = !!v;
}

function dbg(msg) {
	if (!DEBUG_ENABLED) {
		return;
	}
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	try {
		fs.appendFileSync(DEBUG_LOG, line);
	} catch {
		// Debug logging must never interrupt the actual workflow.
	}
}

// ─── Constants ─────────────────────────────────────────────

const HTTP_TIMEOUT_MS = Number(process.env.BLINK_API_HTTP_TIMEOUT_MS || 30000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.BLINK_API_DOWNLOAD_TIMEOUT_MS || 90000);

function applyRequestTimeout(req, timeoutMs, label) {
	req.setTimeout(timeoutMs, () => {
		req.destroy(new Error(`${label} timed out after ${timeoutMs} ms`));
	});
}

function maskHeader(name, value) {
	const key = String(name || '').toLowerCase();
	if (key === 'cookie' || key === 'set-cookie' || key === 'authorization' || key === 'x-auth-token') {
		return '[redacted]';
	}
	return maskBody(value);
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const OAUTH_HOST = 'api.oauth.blink.com';
const OAUTH_ORIGIN = 'https://api.oauth.blink.com';
const CLIENT_ID = 'ios';
const APP_BRAND = 'blink';
const APP_VERSION = '50.1';
const SCOPE = 'client';
const REDIRECT_URI = 'immedia-blink://applinks.blink.com/signin/callback';
const UA_HTML =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const UA_TOKEN = 'Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0';
const REST_HOST = 'rest-prod.immedia-semi.com';
const CACHE_DIR = '/tmp/blink_session_cache';

function toBase64UrlNoPad(buf) {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function newPkcePair() {
	const verifier = toBase64UrlNoPad(crypto.randomBytes(32));
	const challenge = toBase64UrlNoPad(crypto.createHash('sha256').update(verifier).digest());
	return { verifier, challenge };
}

function decodedBody(res, rawBuf) {
	const enc = (res.headers['content-encoding'] || '').toLowerCase();
	try {
		if (enc.includes('br')) {
			return zlib.brotliDecompressSync(rawBuf).toString('utf8');
		}
		if (enc.includes('gzip')) {
			return zlib.gunzipSync(rawBuf).toString('utf8');
		}
		if (enc.includes('deflate')) {
			return zlib.inflateSync(rawBuf).toString('utf8');
		}
	} catch (e) {
		dbg(`DECODE ERROR (${enc}): ${e.message}`);
	}
	return rawBuf.toString('utf8');
}

function maskBody(s) {
	return String(s)
		.replace(
			/((?:password|pin|2fa_code|auth_token|access_token|refresh_token|client_secret|code)=)[^&\s]*/gi,
			'$1***',
		)
		.replace(
			/("(?:password|pin|2fa_code|auth_token|access_token|refresh_token|client_secret|code)"\s*:\s*")[^"]*(")/gi,
			'$1***$2',
		)
		.replace(/("(?:token|liveview_token)"\s*:\s*")[^"]*(")/gi, '$1***$2')
		.replace(/((?:token|liveview_token)=)[^&\s]*/gi, '$1***');
}

function rawReq(label, opts, bodyStr) {
	return new Promise((resolve, reject) => {
		const fullUrl = `https://${opts.hostname}${opts.path}`;
		dbg('');
		dbg(`========== ${label} ==========`);
		dbg(`${opts.method} ${fullUrl}`);
		dbg(`REQUEST HEADERS:`);
		for (const [k, v] of Object.entries(opts.headers || {})) {
			dbg(`  ${k}: ${maskHeader(k, v)}`);
		}
		if (bodyStr) {
			dbg(`REQUEST BODY (${Buffer.byteLength(bodyStr)} bytes):`);
			dbg(`  ${maskBody(bodyStr)}`);
		}

		const req = https.request(opts, res => {
			const chunks = [];
			res.on('data', d => chunks.push(d));
			res.on('end', () => {
				const raw = Buffer.concat(chunks);
				const body = decodedBody(res, raw);
				dbg(`RESPONSE: HTTP ${res.statusCode} ${res.statusMessage || ''}`);
				dbg(`RESPONSE HEADERS:`);
				for (const [k, v] of Object.entries(res.headers)) {
					dbg(`  ${k}: ${maskHeader(k, Array.isArray(v) ? v.join(' ||| ') : v)}`);
				}
				const safeBody = maskBody(body);
				dbg(`RESPONSE BODY (${body.length} chars, encoding=${res.headers['content-encoding'] || 'none'}):`);
				dbg(safeBody.length > 3000 ? `${safeBody.slice(0, 3000)}\n...[TRUNCATED at 3000 chars]` : safeBody);
				resolve({ status: res.statusCode, headers: res.headers, body });
			});
		});
		applyRequestTimeout(req, HTTP_TIMEOUT_MS, label);
		req.on('error', e => {
			dbg(`REQUEST ERROR: ${e.message}`);
			reject(e);
		});
		if (bodyStr) {
			req.write(bodyStr);
		}
		req.end();
	});
}

function mergeCookies(jar, headers) {
	for (const line of headers['set-cookie'] || []) {
		const seg = line.split(';')[0].trim();
		const i = seg.indexOf('=');
		if (i < 0) {
			continue;
		}
		jar[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
	}
}
function cookieStr(jar) {
	return Object.entries(jar)
		.map(([k, v]) => `${k}=${v}`)
		.join('; ');
}

function extractCsrf(html) {
	const scriptMatch = html.match(
		/<script\s+id=["']oauth-args["']\s+type=["']application\/json["']>([\s\S]*?)<\/script>/i,
	);
	if (scriptMatch) {
		try {
			const parsed = JSON.parse(scriptMatch[1]);
			if (parsed && typeof parsed['csrf-token'] === 'string' && parsed['csrf-token']) {
				dbg(`CSRF found via script#oauth-args JSON`);
				return parsed['csrf-token'];
			}
		} catch (e) {
			dbg(`CSRF oauth-args JSON parse error: ${e.message}`);
		}
	}
	dbg(`CSRF: script#oauth-args with 'csrf-token' not found`);
	return null;
}

function buildQS(obj) {
	return new URLSearchParams(obj).toString();
}
function tryJSON(t) {
	try {
		return JSON.parse(t);
	} catch {
		return {};
	}
}

function maskPhoneForLog(value) {
	const s = String(value || '');
	if (!s) {
		return '';
	}
	return s.replace(/(\+?\d{2})\d+(\d{2})$/, '$1******$2');
}

function isTsvChallenge(status, parsedBody) {
	return (
		status === 202 &&
		parsedBody &&
		typeof parsedBody === 'object' &&
		(Array.isArray(parsedBody.tsv_methods) || parsedBody.tsv_state || parsedBody.next_time_in_secs)
	);
}

function tsvChallengeMessage(parsedBody) {
	const methods = Array.isArray(parsedBody?.tsv_methods) ? parsedBody.tsv_methods.join(', ') : '';
	const state = parsedBody?.tsv_state ? String(parsedBody.tsv_state) : '';
	const phone = parsedBody?.phone ? maskPhoneForLog(parsedBody.phone) : '';
	const wait = Number.isFinite(Number(parsedBody?.next_time_in_secs)) ? Number(parsedBody.next_time_in_secs) : null;
	return [
		'Blink TSV/2FA required.',
		state ? `Aktiver Kanal: ${state}.` : '',
		methods ? `Available channels: ${methods}.` : '',
		phone ? `Ziel: ${phone}.` : '',
		wait !== null ? `Next delivery in ${wait}s.` : '',
		'Code in der Adapter-Konfiguration unter PIN / 2FA-Code eintragen und Adapter neu starten.',
	]
		.filter(Boolean)
		.join(' ');
}

function isTsvRateLimit(status, parsedBody) {
	const cause = String(parsedBody?.error_cause || parsedBody?.error || '').toLowerCase();
	const desc = String(parsedBody?.error_description || parsedBody?.message || '').toLowerCase();
	return (
		status === 429 &&
		parsedBody &&
		typeof parsedBody === 'object' &&
		(cause.includes('2fa_rate_limit_exceeded') ||
			cause.includes('too_many_requests') ||
			desc.includes('2fa rate limit'))
	);
}

function tsvRateLimitWaitSeconds(parsedBody, fallback = 600) {
	const n = Number(parsedBody?.next_time_in_secs);
	return Number.isFinite(n) && n > 0 ? Math.ceil(n) : fallback;
}

function makeTsvRateLimitError(parsedBody, statusCode = 429) {
	const wait = tsvRateLimitWaitSeconds(parsedBody);
	const until = new Date(Date.now() + wait * 1000).toISOString();
	const err = new Error(
		`Blink 2FA rate limit is active. Pause further 2FA/login attempts for ${wait}s pausieren ` +
			`(until approx. ${until}). Delete the old PIN/2FA code and then retry with a new code.`,
	);
	err.code = 'BLINK_2FA_RATE_LIMIT';
	err.statusCode = statusCode;
	err.nextTimeInSecs = wait;
	err.retryAt = Date.now() + wait * 1000;
	err.body = parsedBody || null;
	return err;
}

function cacheFile(email) {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	return path.join(CACHE_DIR, `${crypto.createHash('sha256').update(email).digest('hex')}.json`);
}
function loadSession(email) {
	try {
		return JSON.parse(fs.readFileSync(cacheFile(email), 'utf8'));
	} catch {
		return null;
	}
}
/**
 * Schreibt die Session-Daten persistent in den Cache (Schreibfehler werden
 * verschluckt – die Session bleibt im Speicher gültig).
 *
 * @param {string} email - E-Mail-Adresse des Blink-Accounts.
 * @param {object} s - Vollständiges Session-Objekt mit Tokens und Metadaten.
 */
function saveSession(email, s) {
	try {
		fs.writeFileSync(cacheFile(email), JSON.stringify(s), 'utf8');
	} catch {
		// Cache ist optional; Fehler dürfen den Login-Fluss nicht stoppen.
	}
}
/**
 * Entfernt die im Cache hinterlegte Session zu der angegebenen E-Mail-Adresse.
 *
 * @param {string} email - E-Mail-Adresse des Blink-Accounts.
 */
function clearSession(email) {
	try {
		fs.unlinkSync(cacheFile(email));
	} catch {
		// Datei existiert evtl. nicht – das ist kein Fehler.
	}
}

function hdrsGet(jar) {
	const h = {
		'User-Agent': UA_HTML,
		Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		'Accept-Language': 'en-US,en;q=0.9',
		'Accept-Encoding': 'gzip, deflate, br',
		Connection: 'keep-alive',
	};
	if (jar && Object.keys(jar).length > 0) {
		h['Cookie'] = cookieStr(jar);
	}
	return h;
}

function hdrsPost(jar, refererPath) {
	const referer = refererPath ? `${OAUTH_ORIGIN}${refererPath}` : `${OAUTH_ORIGIN}/oauth/v2/signin`;
	const h = {
		'User-Agent': UA_HTML,
		'Content-Type': 'application/x-www-form-urlencoded',
		Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		'Accept-Language': 'en-US,en;q=0.9',
		'Accept-Encoding': 'gzip, deflate, br',
		Origin: OAUTH_ORIGIN,
		Referer: referer,
		Connection: 'keep-alive',
	};
	if (jar && Object.keys(jar).length > 0) {
		h['Cookie'] = cookieStr(jar);
	}
	return h;
}

function hdrsToken() {
	return {
		'User-Agent': UA_TOKEN,
		'Content-Type': 'application/x-www-form-urlencoded',
		Accept: '*/*',
		'Accept-Language': 'en-US,en;q=0.9',
		'Accept-Encoding': 'gzip, deflate, br',
		Connection: 'keep-alive',
	};
}

// ─── Login ────────────────────────────────────────────────────────────────────

/**
 * Führt den vollständigen OAuth-Login gegen api.oauth.blink.com durch
 * (PKCE, ggf. 2FA) und liefert eine gültige Session inkl. Access-Token.
 *
 * @param {string} email - E-Mail-Adresse des Blink-Accounts.
 * @param {string} password - Passwort des Blink-Accounts.
 * @param {string} [pin] - Optionaler 2FA-/PIN-Code, falls required.
 * @param {string} [hardwareId] - Bereits bekannte Hardware-ID; wird sonst neu generiert.
 * @returns {Promise<object>} Session-Objekt mit accessToken, refreshToken, apiHost u. a.
 * @throws {Error} Wenn der Login scheitert (z. B. NEED_2FA, falsches Passwort, Netzwerkfehler).
 */
async function login(email, password, pin, hardwareId) {
	if (DEBUG_ENABLED) {
		try {
			fs.writeFileSync(
				DEBUG_LOG,
				`======================================================\n` +
					`Blink OAuth Debug-Log\n` +
					`Start: ${new Date().toISOString()}\n` +
					`Email: ${email}\n` +
					`PIN angegeben: ${pin ? 'ja' : 'nein'}\n` +
					`hardwareId cached: ${hardwareId || '(neu generiert)'}\n` +
					`Node: ${process.version}\n` +
					`======================================================\n`,
			);
		} catch {
			// Debug-Log ist optional – Schreibfehler dürfen den Login nicht verhindern.
		}
	}

	if (!hardwareId) {
		hardwareId = crypto.randomUUID().toUpperCase();
	}
	dbg(`hardwareId final: ${hardwareId}`);

	const { verifier, challenge } = newPkcePair();
	dbg(`PKCE verifier length: ${verifier.length}`);
	dbg(`PKCE challenge: ${challenge}`);

	const jar = {};

	const authQS = buildQS({
		app_brand: APP_BRAND,
		app_version: APP_VERSION,
		client_id: CLIENT_ID,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		device_brand: 'Apple',
		device_model: 'iPhone16,1',
		device_os_version: '26.1',
		hardware_id: hardwareId,
		redirect_uri: REDIRECT_URI,
		response_type: 'code',
		scope: SCOPE,
	});

	const s1 = await rawReq('STEP 1: GET /oauth/v2/authorize', {
		hostname: OAUTH_HOST,
		path: `/oauth/v2/authorize?${authQS}`,
		method: 'GET',
		headers: hdrsGet(null),
	});
	mergeCookies(jar, s1.headers);
	dbg(`Cookie jar after STEP 1: [${Object.keys(jar).join(', ')}]`);

	let signinPath = s1.headers['location'];
	if (signinPath) {
		dbg(`STEP 1 redirect to: ${signinPath}`);
		if (signinPath.startsWith('http')) {
			const u = new URL(signinPath);
			signinPath = u.pathname + u.search;
			dbg(`Redirect path extracted: ${signinPath}`);
		}
	} else {
		dbg(`STEP 1 has no redirect, using fallback /oauth/v2/signin`);
		signinPath = '/oauth/v2/signin';
	}

	const s2 = await rawReq(`STEP 2: GET ${signinPath}`, {
		hostname: OAUTH_HOST,
		path: signinPath,
		method: 'GET',
		headers: hdrsGet(jar),
	});
	mergeCookies(jar, s2.headers);
	dbg(`Cookie jar after STEP 2: [${Object.keys(jar).join(', ')}]`);

	let html = s2.body;
	let finalSigninPath = signinPath;

	if ((s2.status === 301 || s2.status === 302) && s2.headers['location']) {
		let loc = s2.headers['location'];
		if (loc.startsWith('http')) {
			const u = new URL(loc);
			loc = u.pathname + u.search;
		}
		dbg(`STEP 2 additional redirect to: ${loc}`);
		finalSigninPath = loc;
		const s2b = await rawReq(`STEP 2b: GET ${finalSigninPath}`, {
			hostname: OAUTH_HOST,
			path: finalSigninPath,
			method: 'GET',
			headers: hdrsGet(jar),
		});
		mergeCookies(jar, s2b.headers);
		html = s2b.body;
	}

	const csrfToken = extractCsrf(html);
	const csrfField = 'csrf-token';
	dbg(`CSRF from HTML: ${csrfToken ? `found (${csrfToken.length} chars)` : 'NOT found'}`);
	dbg(`CSRF-Feldname fix: ${csrfField}`);

	if (!csrfToken) {
		const snippet = html.slice(0, 1500).replace(/\s+/g, ' ');
		dbg(`CSRF MISSING! HTML start (1500 chars): ${snippet}`);
		throw new Error(`CSRF token not found. Debug-Log: ${DEBUG_LOG}`);
	}
	dbg(`CSRF final: token[0..10]=${csrfToken.slice(0, 10)}... field="${csrfField}"`);

	// STEP 3: POST form-encoded mit csrf-token im Body.
	const s3body = buildQS({
		username: email,
		password: password,
		[csrfField]: csrfToken,
	});
	const s3hdrs = hdrsPost(jar, finalSigninPath);
	s3hdrs['Accept'] = '*/*';
	s3hdrs['Content-Length'] = Buffer.byteLength(s3body);

	const s3 = await rawReq(
		`STEP 3: POST ${finalSigninPath} (form-encoded)`,
		{
			hostname: OAUTH_HOST,
			path: finalSigninPath,
			method: 'POST',
			headers: s3hdrs,
		},
		s3body,
	);
	mergeCookies(jar, s3.headers);
	dbg(`Cookie jar after STEP 3: [${Object.keys(jar).join(', ')}]`);

	let step3location = s3.headers['location'] || '';
	dbg(`STEP 3 Location: ${step3location}`);

	const s3json = tryJSON(s3.body);

	if (isTsvRateLimit(s3.status, s3json)) {
		const wait = tsvRateLimitWaitSeconds(s3json);
		dbg(`STEP 3: Blink 2FA Rate-Limit HTTP 429: next=${wait}s body=${s3.body.slice(0, 300)}`);
		throw makeTsvRateLimitError(s3json, s3.status);
	}

	const tsvChallenge = isTsvChallenge(s3.status, s3json);
	if (tsvChallenge) {
		dbg(
			`STEP 3: TSV/2FA Challenge HTTP 202: state=${s3json.tsv_state || ''} ` +
				`methods=${Array.isArray(s3json.tsv_methods) ? s3json.tsv_methods.join(',') : ''} ` +
				`phone=${maskPhoneForLog(s3json.phone || '')} next=${s3json.next_time_in_secs || ''}`,
		);
	}

	if (s3.status === 412 || tsvChallenge) {
		if (pin) {
			const step3State = { jar, csrfToken, csrfField, signinPath: finalSigninPath, step3location };
			await _step3b(step3State, pin);
			step3location = step3State.step3location || step3location;
			dbg(`STEP 3b Location: ${step3location}`);
		} else {
			const err = new Error(
				tsvChallenge
					? tsvChallengeMessage(s3json)
					: '2FA/PIN required. PIN in Konfiguration eintragen und neu starten.',
			);
			err.code = 'NEED_2FA';
			err.tsv = tsvChallenge
				? {
						methods: Array.isArray(s3json.tsv_methods) ? s3json.tsv_methods : [],
						state: s3json.tsv_state || null,
						nextTimeInSecs: s3json.next_time_in_secs || null,
						phoneMasked: maskPhoneForLog(s3json.phone || ''),
					}
				: null;
			err.state = { jar, csrfToken, csrfField, signinPath: finalSigninPath, hardwareId, verifier };
			throw err;
		}
	} else if (!(s3.status >= 300 && s3.status < 400 && step3location)) {
		throw new Error(
			`Blink Login failed: HTTP ${s3.status} – Location="${step3location}" Body=${s3.body.slice(0, 300)}\n` +
				`Siehe Debug-Log: ${DEBUG_LOG}`,
		);
	}

	return _step4_5({ jar, hardwareId, verifier, step3location }, email);
}

async function _step3b(state, pin) {
	const { jar, csrfToken, signinPath } = state;
	const body = buildQS({
		'2fa_code': pin,
		'csrf-token': csrfToken,
		remember_me: 'false',
	});
	const hdrs = hdrsPost(jar, signinPath || '/oauth/v2/signin');
	hdrs['Accept'] = '*/*';
	hdrs['Content-Length'] = Buffer.byteLength(body);

	const r = await rawReq(
		'STEP 3b: POST /oauth/v2/2fa/verify (form-encoded)',
		{
			hostname: OAUTH_HOST,
			path: '/oauth/v2/2fa/verify',
			method: 'POST',
			headers: hdrs,
		},
		body,
	);
	mergeCookies(state.jar, r.headers);

	if (r.status >= 400) {
		const rjson = tryJSON(r.body);
		if (isTsvRateLimit(r.status, rjson)) {
			const wait = tsvRateLimitWaitSeconds(rjson);
			dbg(`STEP 3b: Blink 2FA Rate-Limit HTTP 429: next=${wait}s body=${r.body.slice(0, 300)}`);
			throw makeTsvRateLimitError(rjson, r.status);
		}
		throw new Error(`2FA failed: HTTP ${r.status} – ${r.body.slice(0, 200)}`);
	}
	if (r.headers['location']) {
		state.step3location = r.headers['location'];
	}
}

async function _step4_5(state, email) {
	const { jar, hardwareId, verifier, step3location } = state;

	let authPath = step3location || '';
	if (authPath.startsWith('http')) {
		const u = new URL(authPath);
		if (u.hostname === OAUTH_HOST) {
			authPath = u.pathname + u.search;
		} else {
			const code = u.searchParams.get('code');
			if (code) {
				return _exchangeCode({ jar, hardwareId, verifier, code }, email);
			}
		}
	}

	if (!authPath) {
		dbg(`STEP 4: no redirect aus STEP 3/3b, trying another GET /oauth/v2/authorize`);
		const s4bare = await rawReq('STEP 4a: GET /oauth/v2/authorize (bare)', {
			hostname: OAUTH_HOST,
			path: '/oauth/v2/authorize',
			method: 'GET',
			headers: hdrsGet(jar),
		});
		mergeCookies(jar, s4bare.headers);
		const loc4bare = s4bare.headers['location'] || '';
		dbg(`STEP 4a Location: ${loc4bare}`);

		let codeBare = null;
		try {
			const u = loc4bare.startsWith('http') ? new URL(loc4bare) : new URL(`https://x${loc4bare}`);
			codeBare = u.searchParams.get('code');
			if (!authPath && u.hostname === OAUTH_HOST) {
				authPath = u.pathname + u.search;
			}
		} catch {
			const m = loc4bare.match(/[?&]code=([^&]+)/);
			codeBare = m ? m[1] : null;
		}
		if (codeBare) {
			return _exchangeCode({ jar, hardwareId, verifier, code: codeBare }, email);
		}

		if (!authPath) {
			const challenge = toBase64UrlNoPad(crypto.createHash('sha256').update(verifier).digest());
			const authQS = buildQS({
				app_brand: APP_BRAND,
				app_version: APP_VERSION,
				client_id: CLIENT_ID,
				code_challenge: challenge,
				code_challenge_method: 'S256',
				device_brand: 'Apple',
				device_model: 'iPhone16,1',
				device_os_version: '26.1',
				hardware_id: hardwareId,
				redirect_uri: REDIRECT_URI,
				response_type: 'code',
				scope: SCOPE,
			});
			const fullPath = `/oauth/v2/authorize?${authQS}`;
			dbg(`STEP 4b: bare authorize returned no code, trying full authorize URL again`);
			const s4full = await rawReq('STEP 4b: GET /oauth/v2/authorize?…', {
				hostname: OAUTH_HOST,
				path: fullPath,
				method: 'GET',
				headers: hdrsGet(jar),
			});
			mergeCookies(jar, s4full.headers);
			const loc4full = s4full.headers['location'] || '';
			dbg(`STEP 4b Location: ${loc4full}`);

			let codeFull = null;
			try {
				const u = loc4full.startsWith('http') ? new URL(loc4full) : new URL(`https://x${loc4full}`);
				codeFull = u.searchParams.get('code');
				if (!authPath && u.hostname === OAUTH_HOST) {
					authPath = u.pathname + u.search;
				}
			} catch {
				const m = loc4full.match(/[?&]code=([^&]+)/);
				codeFull = m ? m[1] : null;
			}
			if (codeFull) {
				return _exchangeCode({ jar, hardwareId, verifier, code: codeFull }, email);
			}
		}
	}

	if (!authPath) {
		throw new Error('OAuth Step4: Kein Redirect-Ziel aus STEP 3, 3b oder erneutem /authorize');
	}

	const s4 = await rawReq(`STEP 4: GET ${authPath}`, {
		hostname: OAUTH_HOST,
		path: authPath,
		method: 'GET',
		headers: hdrsGet(jar),
	});
	mergeCookies(jar, s4.headers);

	const loc4 = s4.headers['location'] || '';
	dbg(`STEP 4 Location: ${loc4}`);

	let code;
	try {
		const u = loc4.startsWith('http') ? new URL(loc4) : new URL(`https://x${loc4}`);
		code = u.searchParams.get('code');
	} catch {
		const m = loc4.match(/[?&]code=([^&]+)/);
		code = m ? m[1] : null;
	}

	if (!code) {
		throw new Error(`OAuth Step4: Kein auth_code. Status=${s4.status} Location="${loc4.slice(0, 300)}"`);
	}
	return _exchangeCode({ jar, hardwareId, verifier, code }, email);
}

async function _exchangeCode(state, email) {
	const { hardwareId, verifier, code } = state;
	const tokBody = buildQS({
		app_brand: APP_BRAND,
		client_id: CLIENT_ID,
		code,
		code_verifier: verifier,
		grant_type: 'authorization_code',
		hardware_id: hardwareId,
		redirect_uri: REDIRECT_URI,
		scope: SCOPE,
	});
	const hdrs = hdrsToken();
	hdrs['Content-Length'] = Buffer.byteLength(tokBody);

	const s5 = await rawReq(
		'STEP 5: POST /oauth/token',
		{
			hostname: OAUTH_HOST,
			path: '/oauth/token',
			method: 'POST',
			headers: hdrs,
		},
		tokBody,
	);

	if (s5.status !== 200) {
		throw new Error(`OAuth Token: HTTP ${s5.status} – ${s5.body.slice(0, 200)}`);
	}
	const tok = tryJSON(s5.body);
	if (!tok.access_token) {
		throw new Error(`OAuth: no access_token. Body: ${s5.body.slice(0, 200)}`);
	}

	const apiHost = await _resolveApiHost(tok.access_token);
	const session = {
		accessToken: tok.access_token,
		refreshToken: tok.refresh_token || null,
		expiresAt: Date.now() + ((tok.expires_in || 3600) - 60) * 1000,
		hardwareId,
		apiHost,
		email,
	};
	saveSession(email, session);
	dbg(`LOGIN SUCCESSFUL. apiHost=${apiHost}`);
	return session;
}

async function _refreshToken(session) {
	if (!session.refreshToken) {
		throw new Error('Kein refresh_token');
	}
	const body = buildQS({
		app_brand: APP_BRAND,
		client_id: CLIENT_ID,
		grant_type: 'refresh_token',
		refresh_token: session.refreshToken,
		hardware_id: session.hardwareId,
		scope: SCOPE,
	});
	const hdrs = hdrsToken();
	hdrs['Content-Length'] = Buffer.byteLength(body);

	const r = await rawReq(
		'Token-Refresh: POST /oauth/token',
		{
			hostname: OAUTH_HOST,
			path: '/oauth/token',
			method: 'POST',
			headers: hdrs,
		},
		body,
	);
	if (r.status !== 200) {
		throw new Error(`Token-Refresh: HTTP ${r.status}`);
	}
	const tok = tryJSON(r.body);
	if (!tok.access_token) {
		throw new Error('Token refresh: no access_token');
	}

	session.accessToken = tok.access_token;
	if (tok.refresh_token) {
		session.refreshToken = tok.refresh_token;
	}
	session.expiresAt = Date.now() + ((tok.expires_in || 3600) - 60) * 1000;
	saveSession(session.email, session);
	return session;
}

async function _resolveApiHost(accessToken) {
	try {
		const r = await _restGet('/api/v1/users/tier_info', accessToken, REST_HOST);
		if (r?.tier) {
			return `rest-${r.tier}.immedia-semi.com`;
		}
	} catch {
		// Tier-Info nicht ermittelbar – Default-Host als Fallback verwenden.
	}
	return REST_HOST;
}

/**
 * Liefert eine gültige Blink-Session: nutzt zuerst den lokalen Cache, versucht
 * bei abgelaufenem Token einen Refresh und führt sonst einen vollständigen
 * Login durch.
 *
 * @param {string} email - E-Mail-Adresse des Blink-Accounts.
 * @param {string} password - Passwort des Blink-Accounts.
 * @param {string} [pin] - Optionaler 2FA-/PIN-Code, falls für den Login benötigt.
 * @returns {Promise<object>} Gültige Session mit accessToken und apiHost.
 */
async function getSession(email, password, pin = '') {
	let s = loadSession(email);
	if (s?.accessToken) {
		if (Date.now() < (s.expiresAt || 0)) {
			return s;
		}
		if (s.refreshToken) {
			try {
				return await _refreshToken(s);
			} catch {
				clearSession(email);
			}
		}
	}
	return login(email, password, pin, s?.hardwareId);
}

// ─── REST-API ─────────────────────────────────────────────────────────────────

function _apiHdrs(tok) {
	return {
		Authorization: `Bearer ${tok}`,
		'Content-Type': 'application/json',
		'User-Agent': UA_TOKEN,
		Accept: '*/*',
		'Accept-Language': 'en-US,en;q=0.9',
		'Accept-Encoding': 'gzip, deflate, br',
	};
}

function _restGet(urlPath, tok, host) {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{ hostname: host || REST_HOST, path: urlPath, method: 'GET', headers: _apiHdrs(tok) },
			res => {
				const ch = [];
				res.on('data', d => ch.push(d));
				res.on('end', () => {
					const t = decodedBody(res, Buffer.concat(ch));
					if (res.statusCode >= 400) {
						const e = new Error(`HTTP ${res.statusCode}: ${t.slice(0, 300)}`);
						e.statusCode = res.statusCode;
						return reject(e);
					}
					try {
						resolve(JSON.parse(t));
					} catch {
						resolve(t);
					}
				});
			},
		);
		applyRequestTimeout(req, HTTP_TIMEOUT_MS, `GET ${urlPath}`);
		req.on('error', reject);
		req.end();
	});
}

function _isSystemBusyError(err) {
	const msg = String(err?.message || err || '');
	return err?.statusCode === 409 && msg.includes('System is busy');
}

function _restPost(urlPath, tok, host, body) {
	const bs = body ? JSON.stringify(body) : '';
	const hdrs = { ..._apiHdrs(tok), 'Content-Length': Buffer.byteLength(bs) };
	return new Promise((resolve, reject) => {
		const req = https.request(
			{ hostname: host || REST_HOST, path: urlPath, method: 'POST', headers: hdrs },
			res => {
				const ch = [];
				res.on('data', d => ch.push(d));
				res.on('end', () => {
					const t = decodedBody(res, Buffer.concat(ch));
					if (res.statusCode >= 400) {
						const e = new Error(`HTTP ${res.statusCode}: ${t.slice(0, 300)}`);
						e.statusCode = res.statusCode;
						return reject(e);
					}
					try {
						resolve(JSON.parse(t));
					} catch {
						resolve(t);
					}
				});
			},
		);
		applyRequestTimeout(req, HTTP_TIMEOUT_MS, `POST ${urlPath}`);
		req.on('error', reject);
		if (bs) {
			req.write(bs);
		}
		req.end();
	});
}

function _decodeBinaryResponse(res, rawBuf) {
	const enc = (res.headers['content-encoding'] || '').toLowerCase();
	try {
		if (enc.includes('br')) {
			return zlib.brotliDecompressSync(rawBuf);
		}
		if (enc.includes('gzip')) {
			return zlib.gunzipSync(rawBuf);
		}
		if (enc.includes('deflate')) {
			return zlib.inflateSync(rawBuf);
		}
	} catch (e) {
		dbg(`BINARY DECODE ERROR (${enc}): ${e.message}`);
	}
	return rawBuf;
}

async function _downloadBinary(url, tok) {
	return new Promise((resolve, reject) => {
		const { URL: NURL } = require('node:url');
		const u = new NURL(url.startsWith('http') ? url : `https://${REST_HOST}${url}`);
		const req = https.request(
			{ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: _apiHdrs(tok) },
			res => {
				if (res.statusCode === 301 || res.statusCode === 302) {
					const loc = res.headers.location;
					if (!loc) {
						return reject(new Error(`HTTP ${res.statusCode}: Redirect without Location`));
					}
					const nextUrl = /^https?:\/\//i.test(loc) ? loc : new NURL(loc, u).toString();
					return _downloadBinary(nextUrl, tok).then(resolve).catch(reject);
				}
				const ch = [];
				res.on('data', d => ch.push(d));
				res.on('end', () => {
					const body = _decodeBinaryResponse(res, Buffer.concat(ch));
					if (res.statusCode >= 400) {
						const msg = body.toString('utf8');
						const e = new Error(`HTTP ${res.statusCode}: ${msg.slice(0, 300)}`);
						e.statusCode = res.statusCode;
						return reject(e);
					}
					return resolve(body);
				});
			},
		);
		applyRequestTimeout(req, DOWNLOAD_TIMEOUT_MS, `DOWNLOAD ${u.hostname}${u.pathname}`);
		req.on('error', reject);
		req.end();
	});
}

async function _getAccountId(session) {
	if (session._accountId) {
		return session._accountId;
	}
	try {
		const ti = await _restGet('/api/v1/users/tier_info', session.accessToken, session.apiHost);
		if (ti?.account_id) {
			session._accountId = ti.account_id;
			return ti.account_id;
		}
	} catch {
		// tier_info can fail, then we try /networks.
	}
	const nets = await _restGet('/networks', session.accessToken, session.apiHost);
	const id = nets?.networks?.[0]?.account_id || nets?.account_id;
	if (id) {
		session._accountId = id;
		return id;
	}
	throw new Error('Could not determine account_id');
}

function firstDefined(...values) {
	for (const value of values) {
		if (value !== undefined && value !== null && value !== '') {
			return value;
		}
	}
	return null;
}

function deepFindByKeys(obj, keys) {
	const wanted = new Set((keys || []).map(k => String(k).toLowerCase()));
	const seen = new Set();

	function visit(node) {
		if (!node || typeof node !== 'object') {
			return null;
		}
		if (seen.has(node)) {
			return null;
		}
		seen.add(node);

		if (Array.isArray(node)) {
			for (const item of node) {
				const hit = visit(item);
				if (hit !== null && hit !== undefined && hit !== '') {
					return hit;
				}
			}
			return null;
		}

		for (const [k, v] of Object.entries(node)) {
			if (wanted.has(String(k).toLowerCase()) && v !== undefined && v !== null && v !== '') {
				return v;
			}
		}

		for (const v of Object.values(node)) {
			const hit = visit(v);
			if (hit !== null && hit !== undefined && hit !== '') {
				return hit;
			}
		}
		return null;
	}

	return visit(obj);
}

function _cameraConfigPath(accountId, apiType, networkId, cameraId) {
	if (!networkId || !cameraId) {
		return null;
	}
	switch (apiType) {
		case 'owl':
			return `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/config`;
		case 'doorbell':
			return `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/config`;
		default:
			return `/network/${networkId}/camera/${cameraId}/config`;
	}
}

async function _getCameraConfigCached(session, accountId, apiType, networkId, cameraId) {
	const path = _cameraConfigPath(accountId, apiType, networkId, cameraId);
	if (!path) {
		return null;
	}
	const now = Date.now();
	const key = `${apiType}:${networkId}:${cameraId}`;
	if (!session._cameraConfigCache) {
		session._cameraConfigCache = new Map();
	}
	const cached = session._cameraConfigCache.get(key);
	if (cached && now - cached.ts < 6 * 60 * 60 * 1000) {
		return cached.data;
	}
	try {
		const data = await _restGet(path, session.accessToken, session.apiHost);
		session._cameraConfigCache.set(key, { ts: now, data });
		return data;
	} catch {
		session._cameraConfigCache.set(key, { ts: now, data: null });
		return null;
	}
}

function _cameraSignalsPaths(accountId, apiType, networkId, cameraId) {
	if (!networkId || !cameraId) {
		return [];
	}
	const generic = `/network/${networkId}/camera/${cameraId}/signals`;
	switch (String(apiType || 'camera').toLowerCase()) {
		case 'doorbell':
			return [
				`/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/signals`,
				`/api/v1/accounts/${accountId}/networks/${networkId}/doorbell/${cameraId}/signals`,
				generic,
			];
		case 'owl':
		case 'mini':
			return [
				`/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/signals`,
				`/api/v1/accounts/${accountId}/networks/${networkId}/owl/${cameraId}/signals`,
				generic,
			];
		default:
			return [generic];
	}
}

async function _getCameraSignalsCached(session, accountId, apiType, networkId, cameraId) {
	const paths = _cameraSignalsPaths(accountId, apiType, networkId, cameraId);
	if (!paths.length) {
		return null;
	}
	const now = Date.now();
	const key = `${apiType}:${networkId}:${cameraId}`;
	if (!session._cameraSignalsCache) {
		session._cameraSignalsCache = new Map();
	}
	const cached = session._cameraSignalsCache.get(key);
	if (cached && now - cached.ts < 15 * 60 * 1000) {
		return cached.data;
	}
	for (const path of paths) {
		try {
			const data = await _restGet(path, session.accessToken, session.apiHost);
			const hasUsefulData = !!(
				data &&
				typeof data === 'object' &&
				!Array.isArray(data) &&
				Object.keys(data).length > 0
			);
			if (!hasUsefulData) {
				dbg(`signals fallback apiType=${apiType} path=${path} empty`);
				continue;
			}
			session._cameraSignalsCache.set(key, { ts: now, data });
			return data;
		} catch (e) {
			dbg(`signals fallback apiType=${apiType} path=${path} failed: ${e.message}`);
		}
	}
	session._cameraSignalsCache.set(key, { ts: now, data: null });
	return null;
}

function _summarizeVideoEntry(v) {
	if (!v || typeof v !== 'object') {
		return String(v);
	}
	const pick = {};
	for (const k of [
		'id',
		'video_id',
		'created_at',
		'camera_id',
		'device_id',
		'network_id',
		'media',
		'clip',
		'address',
		'url',
		'download_url',
		'playback_url',
		'source',
		'metadata',
		'deleted',
	]) {
		if (v[k] !== undefined) {
			pick[k] = v[k];
		}
	}
	return JSON.stringify(pick);
}

function _videoHasPlayableUrl(v) {
	return !!(v?.media || v?.clip || v?.address || v?.url || v?.download_url || v?.playback_url);
}

function _videoPrimaryUrl(v) {
	return v?.media || v?.clip || v?.address || v?.url || v?.download_url || v?.playback_url || null;
}

function _debugVideoCandidate(prefix, v) {
	if (!v || typeof v !== 'object') {
		dbg(`${prefix} value=${String(v)}`);
		return;
	}
	const keys = Object.keys(v).slice(0, 40).join(',');
	const sample = {
		id: v.id,
		video_id: v.video_id,
		camera_id: v.camera_id,
		device_id: v.device_id,
		network_id: v.network_id,
		created_at: v.created_at,
		updated_at: v.updated_at,
		type: v.type,
		source: v.source,
		device: v.device,
		device_name: v.device_name,
		media: v.media,
		clip: v.clip,
		address: v.address,
		url: v.url,
		download_url: v.download_url,
		playback_url: v.playback_url,
		thumbnail: v.thumbnail,
		metadata: v.metadata,
	};
	dbg(`${prefix} keys=[${keys}] sample=${JSON.stringify(sample).slice(0, 3000)}`);
}

function _videoEndpointCandidates(accountId, networkId, cameraId) {
	return [
		{
			label: 'camera/videos v1 plural',
			path: `/api/v1/accounts/${accountId}/networks/${networkId}/cameras/${cameraId}/videos`,
		},
		{
			label: 'camera/videos v1 singular',
			path: `/api/v1/accounts/${accountId}/networks/${networkId}/camera/${cameraId}/videos`,
		},
		{
			label: 'camera/videos network singular',
			path: `/network/${networkId}/camera/${cameraId}/videos`,
		},
		{
			label: 'camera/videos network plural',
			path: `/network/${networkId}/cameras/${cameraId}/videos`,
		},
	];
}

function _mediaChangedEndpointCandidates(accountId, since, page, networkId, cameraId) {
	const encSince = encodeURIComponent(since);
	return [
		{
			label: 'media/changed v1',
			path: `/api/v1/accounts/${accountId}/media/changed?since=${encSince}&page=${page}`,
		},
		{
			label: 'media/changed v1 no-since',
			path: `/api/v1/accounts/${accountId}/media/changed?page=${page}`,
		},
		{
			label: 'media/changed v3 guessed',
			path: `/api/v3/accounts/${accountId}/media/changed?since=${encSince}&page=${page}`,
		},
		{
			label: 'media/changed with network',
			path: `/api/v1/accounts/${accountId}/media/changed?since=${encSince}&page=${page}&network_id=${networkId}`,
		},
		{
			label: 'media/changed with device',
			path: `/api/v1/accounts/${accountId}/media/changed?since=${encSince}&page=${page}&device_id=${cameraId}`,
		},
	];
}

function _findCandidateVideos(list, cameraId, networkId) {
	const arr = Array.isArray(list) ? list.filter(v => !v?.deleted) : [];
	if (!arr.length) {
		return [];
	}
	const camId = String(cameraId);
	const netId = networkId == null ? null : String(networkId);

	const direct = arr.filter(
		v => String(firstDefined(v?.camera_id, v?.camera, v?.device_id, v?.device, v?.cameraId, v?.deviceId)) === camId,
	);
	if (direct.length) {
		return direct;
	}

	if (netId != null) {
		const sameNetwork = arr.filter(v => String(firstDefined(v?.network_id, v?.network, v?.networkId)) === netId);
		if (sameNetwork.length === 1) {
			return sameNetwork;
		}
		const sameNetworkWithUrl = sameNetwork.filter(v => _videoHasPlayableUrl(v));
		if (sameNetworkWithUrl.length === 1) {
			return sameNetworkWithUrl;
		}
	}

	const withUrl = arr.filter(v => _videoHasPlayableUrl(v));
	if (withUrl.length === 1) {
		return withUrl;
	}

	return [];
}

function _pickBestVideoHit(list, cameraId, networkId) {
	const arr = Array.isArray(list) ? list.filter(v => !v?.deleted) : [];
	if (!arr.length) {
		return null;
	}

	const matches = _findCandidateVideos(arr, cameraId, networkId);
	if (!matches.length) {
		// Kein Clip eindeutig dieser Kamera zuordenbar – lieber nichts zurückgeben,
		// als versehentlich den Clip einer anderen Kamera anzuzeigen.
		return null;
	}

	matches.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

	const withPlayableUrl = matches.find(v => _videoHasPlayableUrl(v));
	return withPlayableUrl || matches[0] || null;
}

/**
 * Sucht das jüngste verfügbare Video-Clip-Objekt für eine Kamera. Probiert
 * dazu mehrere Endpunkte (kamera-spezifisch + media/changed-Pagination).
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID der Kamera.
 * @param {string|number} cameraId - Kamera-ID, für die ein Clip gesucht wird.
 * @returns {Promise<object>} Roh-Eintrag des neuesten Clips inkl. URL/Metadaten.
 * @throws {Error} Mit code 'NO_VIDEO', wenn kein Clip found wurde.
 */
async function getLatestVideoInfo(session, networkId, cameraId) {
	const accountId = await _getAccountId(session);
	let cameraScopedCount = 0;
	let mediaChangedCount = 0;
	const tried = [];

	for (const ep of _videoEndpointCandidates(accountId, networkId, cameraId)) {
		tried.push(ep.path);
		try {
			const res = await _restGet(ep.path, session.accessToken, session.apiHost);
			const allVideos = (res?.videos || (Array.isArray(res) ? res : [])).filter(v => !v?.deleted);
			cameraScopedCount += allVideos.length;

			const matches = _findCandidateVideos(allVideos, cameraId, networkId);
			dbg(
				`VIDEO DEBUG camera=${cameraId} network=${networkId} endpoint=${ep.label} total=${allVideos.length} matches=${matches.length}`,
			);

			if (allVideos.length) {
				dbg(`VIDEO DEBUG ${ep.label} sample=${allVideos.slice(0, 3).map(_summarizeVideoEntry).join(' | ')}`);
				for (const v of allVideos.slice(0, 2)) {
					_debugVideoCandidate(`VIDEO DETAIL ${ep.label}`, v);
				}
			}

			const hit = _pickBestVideoHit(allVideos, cameraId, networkId);
			if (hit) {
				dbg(`VIDEO DEBUG hit via ${ep.label} url=${_videoPrimaryUrl(hit) || '(none)'}`);
				return hit;
			}
		} catch (e) {
			dbg(`VIDEO DEBUG camera=${cameraId} network=${networkId} endpoint=${ep.label} error=${e?.message || e}`);
		}
	}

	const since = '2015-04-19T23:11:20+0000';
	for (let page = 1; page <= 3; page++) {
		let pageHadAnyData = false;

		for (const ep of _mediaChangedEndpointCandidates(accountId, since, page, networkId, cameraId)) {
			tried.push(ep.path);
			try {
				const res = await _restGet(ep.path, session.accessToken, session.apiHost);
				const media = (res?.media || res?.videos || (Array.isArray(res) ? res : [])).filter(v => !v?.deleted);
				mediaChangedCount += media.length;
				pageHadAnyData = pageHadAnyData || media.length > 0;

				const matches = _findCandidateVideos(media, cameraId, networkId);
				dbg(
					`VIDEO DEBUG camera=${cameraId} network=${networkId} endpoint=${ep.label} page=${page} total=${media.length} matches=${matches.length}`,
				);

				if (media.length) {
					dbg(`VIDEO DEBUG ${ep.label} sample=${media.slice(0, 3).map(_summarizeVideoEntry).join(' | ')}`);
					for (const v of media.slice(0, 2)) {
						_debugVideoCandidate(`VIDEO DETAIL ${ep.label}`, v);
					}
				}

				const hit = _pickBestVideoHit(media, cameraId, networkId);
				if (hit) {
					dbg(`VIDEO DEBUG hit via ${ep.label} page=${page} url=${_videoPrimaryUrl(hit) || '(none)'}`);
					return hit;
				}
			} catch (e) {
				dbg(
					`VIDEO DEBUG camera=${cameraId} network=${networkId} endpoint=${ep.label} page=${page} error=${e?.message || e}`,
				);
			}
		}

		if (!pageHadAnyData) {
			break;
		}
	}

	const err = new Error(
		`Kein Video vorhanden (camera/videos=${cameraScopedCount}, media/changed=${mediaChangedCount}, tried=${tried.length})`,
	);
	err.code = 'NO_VIDEO';
	err.tried = tried;
	throw err;
}

function normalizeMediaUrl(videoUrl, apiHost) {
	if (!videoUrl) {
		return null;
	}
	const raw = String(videoUrl).trim();
	if (!raw) {
		return null;
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		return raw;
	}
	return `https://${apiHost}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

/**
 * Lädt das neueste Video einer Kamera als MP4 herunter und speichert es lokal.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID der Kamera.
 * @param {string|number} cameraId - Kamera-ID.
 * @param {string} outFile - Zielpfad der heruntergeladenen Datei.
 * @param {object|null} [latestVideo] - Optional bereits ermitteltes Clip-Objekt.
 * @returns {Promise<object>} Metadaten zum Download (Pfad, Größe, Zeitstempel, ID, URL).
 */
async function downloadVideo(session, networkId, cameraId, outFile, latestVideo = null) {
	const latest = latestVideo || (await getLatestVideoInfo(session, networkId, cameraId));

	let videoUrl =
		latest?.media || latest?.clip || latest?.address || latest?.url || latest?.download_url || latest?.playback_url;
	if (!videoUrl) {
		_debugVideoCandidate(`VIDEO DOWNLOAD no-url camera=${cameraId} network=${networkId}`, latest);
		throw new Error('Keine Video-URL');
	}

	let fullUrl = normalizeMediaUrl(videoUrl, session.apiHost);
	let data;
	let lastErr = null;

	const tryUrls = [];
	for (const raw of [
		latest?.media,
		latest?.clip,
		latest?.address,
		latest?.url,
		latest?.download_url,
		latest?.playback_url,
	]) {
		const u = normalizeMediaUrl(raw, session.apiHost);
		if (u && !tryUrls.includes(u)) {
			tryUrls.push(u);
		}
	}

	dbg(`VIDEO DOWNLOAD camera=${cameraId} network=${networkId} tryUrls=${JSON.stringify(tryUrls)}`);

	for (const url of tryUrls) {
		try {
			dbg(`VIDEO DOWNLOAD TRY ${url}`);
			data = await _downloadBinary(url, session.accessToken);
			fullUrl = url;
			break;
		} catch (e) {
			lastErr = e;
			dbg(`VIDEO DOWNLOAD FAIL ${url}: ${e?.message || e}`);
		}
	}

	if (!data) {
		throw lastErr || new Error('Video-Download failed');
	}

	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, data);
	return {
		ok: true,
		file: outFile,
		size: data.length,
		created_at: latest?.created_at || null,
		id: latest?.id || latest?.video_id || null,
		url: fullUrl,
	};
}

// ─── Local Storage (Sync Module 2 / XR) ──────────────────────────────────────

/**
 * Wartet darauf, dass ein async-Kommando des Sync Module fertig wird, und
 * gibt am Ende die Response-Daten zurück.
 *
 * Funktionsweise (FW 16.0.36, sm2):
 * Solange das Sync Module noch arbeitet, antwortet der Status-Endpoint mit
 * HTTP 409 + code 2113 ("command is in process"). Sobald es fertig ist,
 * liefert er HTTP 200 mit dem Ergebnis-Body (z. B. dem Manifest selbst).
 *
 * @param {() => Promise<object>} fn - Funktion, die den Status-Request ausführt.
 * @param {object} [opts] - Optionen-Objekt.
 * @param {number} [opts.timeoutMs] - Maximale Wartezeit.
 * @param {number} [opts.intervalMs] - Wartezeit zwischen den Versuchen.
 * @returns {Promise<object>} Erfolgs-Response (HTTP 200).
 */
async function _pollUntilReady(fn, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
	const start = Date.now();
	let lastErr;
	while (Date.now() - start < timeoutMs) {
		try {
			return await fn();
		} catch (e) {
			lastErr = e;
			// HTTP 409 = "command in process" → kurz warten und erneut versuchen.
			const msg = String(e?.message || '');
			const stillRunning = e?.statusCode === 409 || /in process/i.test(msg) || /2113/.test(msg);
			if (!stillRunning) {
				throw e;
			}
			dbg(`POLL still running: ${msg.slice(0, 120)}`);
			await _sleep(intervalMs);
		}
	}
	throw new Error(`Local-Storage-Kommando Timeout nach ${timeoutMs}ms: ${lastErr?.message || ''}`);
}

/**
 * Holt das Manifest aller lokal auf dem USB-Stick / SD-Karte gespeicherten
 * Clips eines Sync Module. Funktioniert nur, wenn ein Sync Module 2 (USB) oder
 * Sync Module XR (microSD) angeschlossen ist und ein erkanntes Speichermedium
 * eingesteckt wurde.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID des Systems.
 * @param {string|number} syncId - Sync-Module-ID (aus getDevices().syncModules[i].id).
 * @returns {Promise<{manifestId: string, clips: object[]}>}
 *   manifestId wird für den Clip-Download benötigt; clips enthält
 *   { id, camera_name, created_at, size } pro Eintrag (alle als Strings).
 */
async function getLocalStorageClips(session, networkId, syncId) {
	const accountId = await _getAccountId(session);
	const base = `/api/v1/accounts/${accountId}/networks/${networkId}/sync_modules/${syncId}/local_storage`;

	// 1) Manifest-Erstellung anstoßen.
	const reqRes = await _restPost(`${base}/manifest/request`, session.accessToken, session.apiHost);
	const manifestRequestId = reqRes?.id || reqRes?.command_id;
	if (!manifestRequestId) {
		throw new Error(`Kein manifest_request_id in Response: ${JSON.stringify(reqRes).slice(0, 200)}`);
	}
	dbg(`LOCAL STORAGE manifest_request_id=${manifestRequestId}`);

	// 2) Auf das fertige Manifest pollen – fertig = HTTP 200 mit Body.
	const manifestRes = await _pollUntilReady(
		() => _restGet(`${base}/manifest/request/${manifestRequestId}`, session.accessToken, session.apiHost),
		{ timeoutMs: 60000, intervalMs: 2000 },
	);
	const manifestId = manifestRes?.manifest_id;
	const clips = manifestRes?.clips || [];
	if (!manifestId) {
		throw new Error(`Kein manifest_id in Response: ${JSON.stringify(manifestRes).slice(0, 200)}`);
	}
	dbg(`LOCAL STORAGE manifest_id=${manifestId} clips=${clips.length}`);
	return { manifestId, clips };
}

/**
 * Lädt einen Clip aus dem lokalen Speicher des Sync Module herunter. Der Clip
 * wird dabei vom Sync Module zunächst in Blinks Cloud hochgeladen und kann
 * danach als MP4 abgerufen werden.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID.
 * @param {string|number} syncId - Sync-Module-ID.
 * @param {string} manifestId - manifestId aus {@link getLocalStorageClips}.
 * @param {string|number} clipId - clip.id aus dem Manifest.
 * @param {string} outFile - Zielpfad der MP4-Datei.
 * @returns {Promise<{ok: true, file: string, size: number, clipId: string, url: string}>} Download-Ergebnis mit Metadaten.
 */
async function downloadLocalClip(session, networkId, syncId, manifestId, clipId, outFile) {
	const accountId = await _getAccountId(session);
	const base = `/api/v1/accounts/${accountId}/networks/${networkId}/sync_modules/${syncId}/local_storage`;
	const clipPath = `${base}/manifest/${manifestId}/clip/request/${clipId}`;

	// 1) Upload Stick → Cloud anstoßen. Response: { id: <command_id>, network_id }
	const upReq = await _restPost(clipPath, session.accessToken, session.apiHost);
	const commandId = upReq?.id || upReq?.command_id;
	dbg(`LOCAL STORAGE upload-request clipId=${clipId} commandId=${commandId}`);
	if (!commandId) {
		throw new Error(`Kein command_id in Upload-Response: ${JSON.stringify(upReq).slice(0, 200)}`);
	}

	// 2) Auf Upload-Fertigstellung pollen über den allgemeinen Command-Status-Endpoint.
	//    Antwortet mit { complete: false, ... } während des Uploads und { complete: true, ... }
	//    sobald der Clip in der Cloud bereitsteht.
	await _pollUntilComplete(
		() => _restGet(`/network/${networkId}/command/${commandId}`, session.accessToken, session.apiHost),
		{ timeoutMs: 120000, intervalMs: 1000 },
	);
	dbg(`LOCAL STORAGE upload command ${commandId} complete`);

	// 3) Clip jetzt aus der Cloud holen – derselbe Pfad wie der Upload-Request.
	const url = `https://${session.apiHost}${clipPath}`;
	dbg(`LOCAL STORAGE download TRY ${url}`);
	const data = await _downloadBinary(url, session.accessToken);

	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, data);
	return { ok: true, file: outFile, size: data.length, clipId: String(clipId), url };
}

/**
 * Pollt den /network/{id}/command/{id}-Endpoint, bis das Command-Objekt
 * `complete: true` meldet (oder ein Failure-Status erscheint).
 *
 * @param {() => Promise<object>} fn - Status-Request-Funktion.
 * @param {object} [opts] - Optionen-Objekt.
 * @param {number} [opts.timeoutMs] - Maximale Wartezeit in Millisekunden.
 * @param {number} [opts.intervalMs] - Wartezeit zwischen Versuchen in Millisekunden.
 * @returns {Promise<object>} Erfolgs-Response.
 */
async function _pollUntilComplete(fn, { timeoutMs = 120000, intervalMs = 1000 } = {}) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeoutMs) {
		try {
			last = await fn();
		} catch (e) {
			dbg(`POLL command transient: ${e?.message || e}`);
			await _sleep(intervalMs);
			continue;
		}
		if (last?.complete === true) {
			return last;
		}
		// Failure-Erkennung: status != 0 ist ein Hinweis auf Fehler (siehe blinkpy).
		const statusCode = last?.status;
		if (statusCode != null && statusCode !== 0 && last?.complete === false) {
			throw new Error(`Command failed: status=${statusCode} msg="${last?.status_msg || ''}"`);
		}
		await _sleep(intervalMs);
	}
	throw new Error(`Command-Timeout nach ${timeoutMs}ms: ${JSON.stringify(last || {}).slice(0, 200)}`);
}

/**
 * Holt die neueste verfügbare Aufnahme einer Kamera. Probiert zuerst die
 * Cloud (für Nutzer mit Abo) und fällt auf den lokalen Speicher des Sync
 * Module 2 / XR zurück, wenn Cloud-seitig nichts vorhanden ist.
 *
 * Das Manifest des Sync Module wird pro Aufruf gecached und kann von außen
 * mitgegeben werden, um Mehrfachabfragen für mehrere Kameras zu vermeiden.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID.
 * @param {string|number} cameraId - Kamera-ID.
 * @param {string} cameraName - Anzeigename der Kamera (steht so im Manifest).
 * @param {string} outFile - Zielpfad der MP4.
 * @param {object} [opts] - Optionen-Objekt.
 * @param {string|number} [opts.syncId] - Sync-Module-ID; ohne diese kein Local-Fallback.
 * @param {{manifestId: string, clips: object[]}} [opts.manifestCache]
 *   Falls vorhanden, wird kein neues Manifest angefordert.
 * @returns {Promise<object>} Download-Ergebnis (wie {@link downloadVideo}/{@link downloadLocalClip}).
 */

/**
 * Liefert eine kompakte Zusammenfassung der Smart-Detection-Metadaten des
 * neuesten Cloud-Videos einer Kamera. Wird vom Adapter für die Erkennungs-
 * States verwendet (Person/Fahrzeug/Tier/Paket).
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID.
 * @param {string|number} cameraId - Kamera-ID.
 * @returns {Promise<object>} Zusammenfassung mit Detection-Flags.
 */
async function getLatestVideoSummary(session, networkId, cameraId) {
	let latest;
	try {
		latest = await getLatestVideoInfo(session, networkId, cameraId);
	} catch (e) {
		if (e?.code === 'NO_VIDEO') {
			return {};
		}
		throw e;
	}
	if (!latest) {
		return {};
	}

	// Smart-Detection-Daten können in unterschiedlichen Feldern stecken.
	// Wir extrahieren defensiv – ist ein Feld nicht da, bleibt es false/empty.
	const raw = latest?.smart_detection || latest?.detection || {};
	const types = Array.isArray(latest?.detection_types)
		? latest.detection_types
		: typeof raw === 'object' && Array.isArray(raw?.detected)
			? raw.detected
			: [];
	const has = name => {
		if (types.some(t => String(t).toLowerCase().includes(name))) {
			return true;
		}
		if (raw && typeof raw === 'object') {
			const v = raw[name] ?? raw[`${name}_detected`] ?? raw[`is_${name}`];
			if (v === true || v === 'true' || v === 1) {
				return true;
			}
		}
		const source = String(latest?.source || '').toLowerCase();
		return source.includes(name);
	};

	return {
		id: latest?.id || latest?.video_id || null,
		created_at: latest?.created_at || '',
		smart_detection: !!(latest?.smart_detection || (types && types.length)),
		person_detected: has('person'),
		vehicle_detected: has('vehicle') || has('car'),
		animal_detected: has('animal') || has('pet'),
		package_detected: has('package'),
		detection_type: types.join(',') || String(latest?.source || ''),
		smart_detection_raw: typeof raw === 'object' ? JSON.stringify(raw).slice(0, 500) : String(raw),
		motion_source: String(latest?.source || ''),
	};
}

/**
 * Listet die N neuesten Cloud-Clips einer Kamera über media/changed. Liefert
 * eine Liste im selben Schema wie die Local-Storage-Clips, plus eine direkte
 * `media`-URL fürs Downloading. Bei Konten ohne Abo ist das Ergebnis empty.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID.
 * @param {string|number} cameraId - Kamera-ID.
 * @param {string} cameraName - Anzeigename (für Konsistenz mit Local-Manifest).
 * @param {number} [limit] - Maximale Anzahl Clips.
 * @returns {Promise<{clips: object[], source: 'cloud'}>} Liste neuester Clips.
 */
async function getCloudClips(session, networkId, cameraId, cameraName, limit = 10) {
	const accountId = await _getAccountId(session);
	const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days back
	const collected = [];

	// Wir probieren primär den v1-Endpoint mit since und paginieren so weit,
	// bis wir genug Treffer haben oder eine emptye Seite kommt.
	for (let page = 1; page <= 5 && collected.length < limit; page++) {
		const path = `/api/v1/accounts/${accountId}/media/changed?since=${encodeURIComponent(since)}&page=${page}`;
		let body;
		try {
			body = await _restGet(path, session.accessToken, session.apiHost);
		} catch (e) {
			dbg(`CLOUD CLIPS page=${page} error=${e?.message || e}`);
			break;
		}
		const media = Array.isArray(body?.media) ? body.media : [];
		dbg(`CLOUD CLIPS page=${page} total=${media.length}`);
		if (!media.length) {
			break;
		}
		// Auf diese Kamera filtern.
		const camMatches = media.filter(v => {
			if (v?.deleted) {
				return false;
			}
			const matchCam =
				String(firstDefined(v?.camera_id, v?.device_id, v?.camera, v?.device)) === String(cameraId) ||
				String(v?.device_name || v?.camera_name || '') === String(cameraName);
			return matchCam;
		});
		collected.push(...camMatches);
	}

	// Neueste zuerst, auf Limit kappen, in das Standard-Schema mappen.
	collected.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
	const clips = collected.slice(0, limit).map(v => ({
		id: String(v?.id || v?.video_id || ''),
		camera_name: cameraName,
		created_at: v?.created_at || '',
		size: v?.size || 0,
		_cloudUrl: firstDefined(v?.media, v?.url, v?.address, v?.media_url),
	}));
	return { clips, source: 'cloud' };
}

/**
 * Lädt einen Cloud-Clip direkt über die `media`-URL aus media/changed. Viel
 * schneller als der Local-Storage-Pfad, weil kein Upload-Command nötig ist.
 *
 * @param {object} session - Gültige Session.
 * @param {object} clip - Clip-Objekt aus {@link getCloudClips}.
 * @param {string} outFile - Zielpfad der MP4-Datei.
 */
async function downloadCloudClip(session, clip, outFile) {
	if (!clip?._cloudUrl) {
		throw new Error('Cloud-Clip ohne media-URL');
	}
	const url = clip._cloudUrl.startsWith('http') ? clip._cloudUrl : `https://${session.apiHost}${clip._cloudUrl}`;
	dbg(`CLOUD CLIPS download TRY ${url}`);
	const data = await _downloadBinary(url, session.accessToken);
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, data);
	return { ok: true, file: outFile, size: data.length, clipId: String(clip.id), url };
}

/**
 * Liefert eine vereinheitlichte Liste der N neuesten Clips einer Kamera.
 * Probiert zuerst die Cloud (für Abo-Nutzer schneller, weil kein Stick-Upload
 * nötig). Wenn die Cloud nichts liefert, fällt sie auf das Local-Storage-
 * Manifest des Sync Module zurück.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID.
 * @param {string|number} cameraId - Kamera-ID.
 * @param {string} cameraName - Anzeigename.
 * @param {object} [opts] - Optionen-Objekt.
 * @param {string|number} [opts.syncId] - Sync-Module-ID für Local-Fallback.
 * @param {{manifestId: string, clips: object[]}} [opts.localManifest]
 *   Vorgefertigtes Local-Manifest (z. B. aus dem Polling-Cache).
 * @param {number} [opts.limit] - Maximale Anzahl Clips.
 * @returns {Promise<{clips: object[], source: 'cloud'|'local_storage'|'none', manifestId?: string}>} Historie-Ergebnis.
 */
async function getHistoryClips(session, networkId, cameraId, cameraName, opts = {}) {
	const limit = opts.limit || 10;

	// 1) Cloud zuerst.
	try {
		const cloud = await getCloudClips(session, networkId, cameraId, cameraName, limit);
		if (cloud.clips.length) {
			return { clips: cloud.clips, source: 'cloud' };
		}
	} catch (e) {
		dbg(`HISTORY cloud failed: ${e?.message || e}`);
	}

	// 2) Local-Storage-Fallback.
	const syncId = opts.syncId;
	if (!syncId) {
		return { clips: [], source: 'none' };
	}
	const manifest = opts.localManifest || (await getLocalStorageClips(session, networkId, syncId));
	const matches = manifest.clips
		.filter(c => String(c.camera_name) === String(cameraName))
		.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
		.slice(0, limit);
	return { clips: matches, source: 'local_storage', manifestId: manifest.manifestId };
}

/**
 * Liefert die aktuelle Geräteliste (Kameras, Doorbells, Owls + Sync-Module)
 * mitsamt aufbereiteten Sensorwerten wie Batterie, Temperatur und WLAN.
 *
 * @param {object} session - Gültige Session aus {@link getSession} oder {@link login}.
 * @returns {Promise<{cameras: object[], syncModules: object[]}>} Aufbereitete Geräteliste.
 */
async function getDevices(session) {
	const accountId = await _getAccountId(session);
	const hs = await _restGet(`/api/v3/accounts/${accountId}/homescreen`, session.accessToken, session.apiHost);
	const cameras = [],
		syncModules = [];

	const syncList = Array.isArray(hs?.sync_modules) ? hs.sync_modules : [];
	const syncByNetworkId = new Map();
	const syncById = new Map();
	for (const item of syncList) {
		const rawSync = item?.sync_module || item || {};
		const networkId = firstDefined(rawSync?.network_id, item?.network_id, rawSync?.network, item?.network);
		const syncId = firstDefined(rawSync?.id, rawSync?.sync_module_id, item?.id, item?.sync_module_id);
		if (networkId != null) {
			syncByNetworkId.set(String(networkId), rawSync);
		}
		if (syncId != null) {
			syncById.set(String(syncId), rawSync);
		}
	}

	for (const net of hs?.networks || []) {
		const rawNet = net?.network || net || {};
		const netId = firstDefined(rawNet?.network_id, rawNet?.id, net?.network_id, net?.id);
		const linkedSync =
			firstDefined(
				net?.sync_module,
				rawNet?.sync_module,
				net?.sync_module_info,
				rawNet?.sync_module_info,
				net?.syncModule,
				rawNet?.syncModule,
				netId != null ? syncByNetworkId.get(String(netId)) : undefined,
				rawNet?.sync_module_id != null ? syncById.get(String(rawNet.sync_module_id)) : undefined,
				net?.sync_module_id != null ? syncById.get(String(net.sync_module_id)) : undefined,
			) || {};
		const syncObj = firstDefined(linkedSync, net, rawNet) || {};
		const syncSerial = firstDefined(
			linkedSync?.serial,
			linkedSync?.serial_number,
			linkedSync?.device_serial,
			linkedSync?.sync_serial,
			linkedSync?.sync_module_serial,
			linkedSync?.unit_serial,
			linkedSync?.module_serial,
			net?.sync_module?.serial,
			net?.sync_module?.serial_number,
			net?.sync_module?.device_serial,
			net?.sync_module?.sync_serial,
			rawNet?.sync_module?.serial,
			rawNet?.sync_module?.serial_number,
			rawNet?.sync_module?.device_serial,
			rawNet?.sync_module?.sync_serial,
			net?.sync_module_info?.serial,
			net?.sync_module_info?.serial_number,
			rawNet?.sync_module_info?.serial,
			rawNet?.sync_module_info?.serial_number,
			rawNet?.serial,
			rawNet?.serial_number,
			rawNet?.device_serial,
			rawNet?.sync_serial,
			rawNet?.sync_module_serial,
			deepFindByKeys(syncObj, [
				'serial',
				'serial_number',
				'device_serial',
				'sync_serial',
				'sync_module_serial',
				'unit_serial',
				'module_serial',
			]),
		);
		if (syncSerial == null) {
			dbg(
				`SYNC SERIAL is missing for network ${netId}; keys(rawNet)=[${Object.keys(rawNet).join(',')}] keys(syncObj)=[${Object.keys(syncObj || {}).join(',')}] topLevelSyncs=${syncList.length}`,
			);
		}
		const localStorageEnabled = firstDefined(linkedSync?.local_storage_enabled, rawNet?.local_storage_enabled);
		const localStorageStatus = firstDefined(linkedSync?.local_storage_status, rawNet?.local_storage_status);
		// Echte Sync-Module-ID (≠ network_id) für Local-Storage-Aufrufe.
		const realSyncId = firstDefined(
			linkedSync?.id,
			linkedSync?.sync_module_id,
			net?.sync_module?.id,
			net?.sync_module_id,
		);
		syncModules.push({
			id: netId,
			sync_id: realSyncId != null ? Number(realSyncId) : null,
			name: firstDefined(rawNet?.name, linkedSync?.name, net?.sync_module?.name, String(netId)),
			serial: syncSerial != null ? String(syncSerial) : null,
			armed:
				firstDefined(rawNet?.armed, linkedSync?.armed, net?.armed) != null
					? Boolean(firstDefined(rawNet?.armed, linkedSync?.armed, net?.armed))
					: null,
			network_id: netId,
			local_storage_enabled: localStorageEnabled != null ? Boolean(localStorageEnabled) : null,
			local_storage_status: localStorageStatus != null ? String(localStorageStatus) : null,
			updated: new Date().toISOString(),
		});
	}

	const allCams = [
		...(hs?.cameras || []).map(cam => ({ cam, apiType: 'camera' })),
		...(hs?.owls || []).map(cam => ({ cam, apiType: 'owl' })),
		...(hs?.doorbells || []).map(cam => ({ cam, apiType: 'doorbell' })),
	];

	for (const entry of allCams) {
		const cam = entry.cam;
		const dev = cam?.device || cam || {};
		const status = cam?.camera_status || cam?.status || {};
		const signals = status?.signals || dev?.signals || cam?.signals || {};
		const camId = dev.id || dev.camera_id || cam.id || cam.camera_id;
		const netId = firstDefined(dev?.network_id, cam?.network_id, status?.network_id);
		const sync = syncModules.find(s => String(s.network_id) === String(netId));

		let batteryVoltageRaw = firstDefined(
			status?.battery_voltage,
			status?.battery_volt,
			dev?.battery_voltage,
			dev?.battery_volt,
			cam?.battery_voltage,
			cam?.battery_volt,
			signals?.battery_voltage,
		);
		let batteryLevelRaw = firstDefined(
			signals?.battery,
			status?.battery_level,
			dev?.battery_level,
			cam?.battery_level,
		);

		let cfg = null;
		if ((batteryVoltageRaw == null || batteryLevelRaw == null) && camId != null && netId != null) {
			cfg = await _getCameraConfigCached(session, accountId, entry.apiType, netId, camId);
			const cfgEntity =
				firstDefined(
					cfg?.camera?.[0],
					cfg?.camera,
					cfg?.doorbell?.[0],
					cfg?.doorbell,
					cfg?.owl?.[0],
					cfg?.owl,
					cfg?.mini?.[0],
					cfg?.mini,
					cfg?.device?.[0],
					cfg?.device,
					cfg,
				) || {};
			const cfgSignals = firstDefined(cfgEntity?.signals, cfg?.signals) || {};
			batteryVoltageRaw = firstDefined(
				batteryVoltageRaw,
				cfg?.battery_voltage,
				cfg?.battery_volt,
				cfgEntity?.battery_voltage,
				cfgEntity?.battery_volt,
				cfgSignals?.battery_voltage,
				deepFindByKeys(cfg, ['battery_voltage', 'battery_volt']),
			);
			batteryLevelRaw = firstDefined(
				batteryLevelRaw,
				cfgSignals?.battery,
				cfg?.battery_level,
				cfgEntity?.battery_level,
				deepFindByKeys(cfg, ['battery_level', 'battery']),
			);
		}

		const battVolt = batteryVoltageRaw != null ? batteryToVolt(batteryVoltageRaw) : null;
		const battRaw =
			batteryVoltageRaw != null && Number.isFinite(Number(batteryVoltageRaw))
				? Number(batteryVoltageRaw)
				: batteryLevelRaw != null && Number.isFinite(Number(batteryLevelRaw))
					? Number(batteryLevelRaw)
					: null;

		let tempF = firstDefined(
			signals?.temp,
			status?.temperature,
			dev?.temperature,
			cam?.temperature,
			deepFindByKeys(cam, ['temp', 'temperature', 'temp_f', 'temperature_f']),
		);
		let tempC = firstDefined(
			signals?.temp_c,
			signals?.temperature_c,
			status?.temperature_c,
			dev?.temperature_c,
			cam?.temperature_c,
			deepFindByKeys(cam, ['temp_c', 'temperature_c', 'temp_celsius', 'temperature_celsius', 'celsius']),
		);
		if (tempF == null && tempC == null && camId != null && netId != null) {
			cfg = cfg || (await _getCameraConfigCached(session, accountId, entry.apiType, netId, camId));
			const cfgEntity =
				firstDefined(
					cfg?.camera?.[0],
					cfg?.camera,
					cfg?.doorbell?.[0],
					cfg?.doorbell,
					cfg?.owl?.[0],
					cfg?.owl,
					cfg?.mini?.[0],
					cfg?.mini,
					cfg?.device?.[0],
					cfg?.device,
					cfg,
				) || {};
			const cfgSignals = firstDefined(cfgEntity?.signals, cfg?.signals) || {};
			tempF = firstDefined(
				tempF,
				cfgSignals?.temp,
				cfgEntity?.temperature,
				cfg?.temperature,
				deepFindByKeys(cfg, ['temp', 'temperature', 'temp_f', 'temperature_f']),
			);
			tempC = firstDefined(
				tempC,
				cfgSignals?.temp_c,
				cfgSignals?.temperature_c,
				cfgEntity?.temperature_c,
				cfg?.temperature_c,
				deepFindByKeys(cfg, ['temp_c', 'temperature_c', 'temp_celsius', 'temperature_celsius', 'celsius']),
			);
		}
		if (tempF == null && tempC == null && camId != null && netId != null) {
			const sig = await _getCameraSignalsCached(session, accountId, entry.apiType, netId, camId);
			tempF = firstDefined(
				tempF,
				sig?.temp,
				sig?.temperature,
				deepFindByKeys(sig, ['temp', 'temperature', 'temp_f', 'temperature_f']),
			);
			tempC = firstDefined(
				tempC,
				sig?.temp_c,
				sig?.temperature_c,
				deepFindByKeys(sig, ['temp_c', 'temperature_c', 'temp_celsius', 'temperature_celsius', 'celsius']),
			);
			if (entry.apiType === 'doorbell') {
				dbg(
					`DOORBELL TEMP signals id=${camId} net=${netId} keys=[${Object.keys(sig || {}).join(',')}] temp=${sig?.temp} temp_c=${sig?.temp_c}`,
				);
			}
		}
		let tempFNum = tempF != null && Number.isFinite(Number(tempF)) ? Number(tempF) : null;
		if (tempFNum == null && tempC != null && Number.isFinite(Number(tempC))) {
			tempFNum = Math.round(((Number(tempC) * 9) / 5 + 32) * 10) / 10;
		}

		if (entry.apiType === 'doorbell' && (battRaw == null || tempFNum == null)) {
			dbg(`DOORBELL SENSOR fallback: id=${camId} net=${netId} battRaw=${battRaw} tempF=${tempFNum}`);
		}

		const wifiKeys = ['wifi_strength', 'lfr_strength', 'wifi_signal', 'signal_strength', 'rssi'];
		const wifiCandidates = [
			status?.wifi_strength,
			dev?.wifi_strength,
			cam?.wifi_strength,
			signals?.wifi_strength,
			signals?.lfr_strength,
			signals?.wifi_signal,
			signals?.signal_strength,
			signals?.rssi,
			status?.lfr_strength,
			status?.wifi_signal,
			status?.signal_strength,
			status?.rssi,
			dev?.lfr_strength,
			dev?.wifi_signal,
			dev?.signal_strength,
			dev?.rssi,
			cam?.lfr_strength,
			cam?.wifi_signal,
			cam?.signal_strength,
			cam?.rssi,
			cfg?.wifi_strength,
			cfg?.lfr_strength,
			cfg?.wifi_signal,
			cfg?.signal_strength,
			cfg?.rssi,
			deepFindByKeys(status, wifiKeys),
			deepFindByKeys(dev, wifiKeys),
			deepFindByKeys(cam, wifiKeys),
			deepFindByKeys(signals, wifiKeys),
			deepFindByKeys(cfg, wifiKeys),
		];

		let wifiStrength = null;
		let wifiZeroSeen = false;

		for (const raw of wifiCandidates) {
			if (raw === undefined || raw === null || raw === '') {
				continue;
			}
			const n = Number(raw);
			if (!Number.isFinite(n)) {
				continue;
			}
			if (n !== 0) {
				wifiStrength = n;
				break;
			}
			wifiZeroSeen = true;
		}

		if (wifiStrength === null && wifiZeroSeen) {
			wifiStrength = 0;
		}

		cameras.push({
			id: camId,
			name: dev.name || cam.name,
			serial: dev.serial || cam.serial || null,
			apiType: entry.apiType,
			network_id: netId,
			battery: battVolt,
			battery_raw: battRaw,
			battery_volt: battVolt,
			temperature: tempFNum != null ? Math.round((((tempFNum - 32) * 5) / 9) * 10) / 10 : null,
			temperature_f: tempFNum,
			wifi_strength: wifiStrength,
			motion_detect_enabled: firstDefined(status?.motion_alert, status?.enabled, dev?.enabled, cam?.enabled),
			armed: sync ? sync.armed : null,
			thumbnail: firstDefined(status?.thumbnail, dev?.thumbnail, cam?.thumbnail),
			updated: new Date().toISOString(),
		});
	}
	return { cameras, syncModules };
}

/**
 * Stößt einen neuen Snapshot/Thumbnail-Refresh an und lädt das resultierende
 * Bild herunter.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID der Kamera.
 * @param {string|number} cameraId - ID der Kamera/Doorbell/Owl.
 * @param {string} thumbnailUrl - Aktueller Thumbnail-Pfad als Fallback, falls kein neuer geliefert wird.
 * @param {string} outFile - Zielpfad, unter dem das Bild gespeichert werden soll.
 * @param {string} [apiType] - Gerätetyp: 'camera', 'doorbell', 'owl' bzw. 'mini'.
 * @returns {Promise<string>} Pfad der gespeicherten JPG-Datei.
 */
async function snapshot(session, networkId, cameraId, thumbnailUrl, outFile, apiType = 'camera') {
	const kind = String(apiType || 'camera').toLowerCase();
	const accountId = await _getAccountId(session);
	const candidates =
		kind === 'doorbell'
			? [
					`/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/thumbnail`,
					`/api/v1/accounts/${accountId}/networks/${networkId}/doorbell/${cameraId}/thumbnail`,
					`/network/${networkId}/doorbells/${cameraId}/thumbnail`,
					`/network/${networkId}/doorbell/${cameraId}/thumbnail`,
					`/network/${networkId}/camera/${cameraId}/thumbnail`,
				]
			: kind === 'owl' || kind === 'mini'
				? [
						`/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/thumbnail`,
						`/api/v1/accounts/${accountId}/networks/${networkId}/owl/${cameraId}/thumbnail`,
						`/network/${networkId}/owls/${cameraId}/thumbnail`,
						`/network/${networkId}/owl/${cameraId}/thumbnail`,
						`/network/${networkId}/camera/${cameraId}/thumbnail`,
					]
				: [
						`/network/${networkId}/camera/${cameraId}/thumbnail`,
						`/network/${networkId}/cameras/${cameraId}/thumbnail`,
						`/api/v1/accounts/${accountId}/networks/${networkId}/cameras/${cameraId}/thumbnail`,
					];

	let lastErr;
	let lastBusyErr;
	for (const waitMs of [0, 6000, 12000]) {
		if (waitMs) {
			await _sleep(waitMs);
		}
		lastErr = null;
		for (const p of candidates) {
			try {
				dbg(`snapshot TRY apiType=${kind} path=${p}`);
				await _restPost(p, session.accessToken, session.apiHost);
				lastErr = null;
				lastBusyErr = null;
				break;
			} catch (e) {
				if (_isSystemBusyError(e)) {
					lastBusyErr = e;
					lastErr = e;
					dbg(`snapshot BUSY apiType=${kind} path=${p}: ${e.message}`);
					break;
				}
				lastErr = e;
				dbg(`snapshot Fallback: apiType=${kind} path=${p} failed: ${e.message}`);
			}
		}
		if (!lastErr) {
			break;
		}
		if (!lastBusyErr || waitMs === 12000) {
			throw lastErr;
		}
	}
	if (lastErr) {
		throw lastErr;
	}

	await _sleep(2000);
	try {
		const hs = await _restGet(`/api/v3/accounts/${accountId}/homescreen`, session.accessToken, session.apiHost);
		const found = [...(hs?.cameras || []), ...(hs?.owls || []), ...(hs?.doorbells || [])].find(
			c => String((c.device || c).id) === String(cameraId),
		);
		if (found) {
			const u = (found.camera_status || found.status || {}).thumbnail || (found.device || found).thumbnail;
			if (u) {
				thumbnailUrl = u;
			}
		}
	} catch {
		// Homescreen-Refresh ist optional – Fallback ist die übergebene thumbnailUrl.
	}
	const url = /\.(jpg|jpeg)$/i.test(thumbnailUrl) ? thumbnailUrl : `${thumbnailUrl}.jpg`;
	const fullUrl = url.startsWith('http') ? url : `https://${session.apiHost}${url}`;
	const data = await _downloadBinary(fullUrl, session.accessToken);
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, data);
	return outFile;
}

/**
 * Wie {@link snapshot}, liefert das Bild jedoch direkt als Buffer (für Streams,
 * MJPEG-Server etc.) statt eine permanente Datei zu erzeugen.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID der Kamera.
 * @param {string|number} cameraId - Kamera-ID.
 * @param {string} thumbnailUrl - Aktueller Thumbnail-Pfad.
 * @param {string} [apiType] - Gerätetyp: 'camera', 'doorbell', 'owl' bzw. 'mini'.
 * @returns {Promise<Buffer>} Bilddaten als Buffer.
 */
async function snapshotBuffer(session, networkId, cameraId, thumbnailUrl, apiType = 'camera') {
	const outFile = path.join('/tmp', `blink_snapshot_${cameraId}.jpg`);
	await snapshot(session, networkId, cameraId, thumbnailUrl, outFile, apiType);
	return fs.readFileSync(outFile);
}

/**
 * Aktiviert oder deaktiviert die Bewegungserkennung für eine Kamera, Doorbell
 * oder Mini/Owl. Probiert mehrere bekannte Endpunkte als Fallback durch.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID der Kamera.
 * @param {string|number} cameraId - ID der Kamera/Doorbell/Owl.
 * @param {boolean} enable - true aktiviert, false deaktiviert die Bewegungserkennung.
 * @param {string} [apiType] - Gerätetyp: 'camera', 'doorbell' oder 'owl'.
 * @returns {Promise<object>} Antwort des erfolgreichen API-Aufrufs.
 */
async function setMotion(session, networkId, cameraId, enable, apiType = 'camera') {
	const action = enable ? 'enable' : 'disable';
	const enabled = !!enable;
	const kind = String(apiType || 'camera').toLowerCase();
	const accountId = await _getAccountId(session);

	const cameraCandidates = [
		{ path: `/network/${networkId}/camera/${cameraId}/${action}` },
		{ path: `/network/${networkId}/cameras/${cameraId}/${action}` },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/cameras/${cameraId}/${action}` },
		{ path: `/network/${networkId}/camera/${cameraId}/update`, body: { enabled } },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/cameras/${cameraId}/config`, body: { enabled } },
	];
	const doorbellCandidates = [
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/${action}` },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbell/${cameraId}/${action}` },
		{ path: `/network/${networkId}/doorbell/${cameraId}/${action}` },
		{ path: `/network/${networkId}/doorbells/${cameraId}/${action}` },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/config`, body: { enabled } },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbell/${cameraId}/config`, body: { enabled } },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/update`, body: { enabled } },
	];
	const owlCandidates = [
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/${action}` },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/owl/${cameraId}/${action}` },
		{ path: `/network/${networkId}/owl/${cameraId}/${action}` },
		{ path: `/network/${networkId}/owls/${cameraId}/${action}` },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/config`, body: { enabled } },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/owl/${cameraId}/config`, body: { enabled } },
		{ path: `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/update`, body: { enabled } },
	];

	const ordered =
		kind === 'doorbell'
			? [...doorbellCandidates, ...owlCandidates, ...cameraCandidates]
			: kind === 'owl'
				? [...owlCandidates, ...doorbellCandidates, ...cameraCandidates]
				: [...cameraCandidates, ...doorbellCandidates, ...owlCandidates];

	const seen = new Set();
	const candidates = ordered.filter(c => {
		const key = `${c.path}::${c.body ? JSON.stringify(c.body) : ''}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});

	let lastErr;
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		try {
			dbg(`setMotion TRY apiType=${kind} path=${c.path}${c.body ? ` body=${JSON.stringify(c.body)}` : ''}`);
			return await _restPost(c.path, session.accessToken, session.apiHost, c.body);
		} catch (e) {
			lastErr = e;
			const msg = String(e?.message || e || '');
			const retryable404 = e?.statusCode === 404 || /not found/i.test(msg) || /camera not found/i.test(msg);
			if (!retryable404 || i === candidates.length - 1) {
				throw e;
			}
			dbg(
				`setMotion Fallback: apiType=${kind} path=${c.path}${c.body ? ` body=${JSON.stringify(c.body)}` : ''} failed: ${msg}`,
			);
		}
	}
	throw lastErr;
}

function _normalizeLiveViewResponse(raw, session) {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Invalid LiveView response');
	}

	const sessionId =
		firstDefined(
			raw?.session_id,
			raw?.sessionId,
			raw?.id,
			raw?.command_id,
			raw?.commandId,
			raw?.liveview_id,
			raw?.liveviewId,
			raw?.transaction,
			raw?.player_transaction,
			deepFindByKeys(raw, [
				'session_id',
				'sessionId',
				'command_id',
				'commandId',
				'liveview_id',
				'liveviewId',
				'id',
				'transaction',
				'player_transaction',
			]),
		) || '';

	let sourceUrl =
		firstDefined(
			raw?.server,
			raw?.source_url,
			raw?.sourceUrl,
			raw?.stream_url,
			raw?.streamUrl,
			raw?.playback_url,
			raw?.playbackUrl,
			raw?.hls_url,
			raw?.hlsUrl,
			raw?.m3u8_url,
			raw?.m3u8Url,
			raw?.rtsp_url,
			raw?.rtspUrl,
			raw?.rtsps_url,
			raw?.rtspsUrl,
			raw?.webrtc_url,
			raw?.webrtcUrl,
			raw?.url,
			deepFindByKeys(raw, [
				'server',
				'source_url',
				'sourceUrl',
				'stream_url',
				'streamUrl',
				'playback_url',
				'playbackUrl',
				'hls_url',
				'hlsUrl',
				'm3u8_url',
				'm3u8Url',
				'rtsp_url',
				'rtspUrl',
				'rtsps_url',
				'rtspsUrl',
				'webrtc_url',
				'webrtcUrl',
				'url',
			]),
		) || '';

	if (typeof sourceUrl === 'string' && sourceUrl) {
		sourceUrl = normalizeMediaUrl(sourceUrl, session?.apiHost);
	}

	if (!sourceUrl) {
		throw new Error(`LiveView-Antwort ohne Stream-URL: ${JSON.stringify(raw).slice(0, 1000)}`);
	}

	let backend = 'blink_direct';
	if (/^rtsp:\/\//i.test(sourceUrl) || /^rtsps:\/\//i.test(sourceUrl)) {
		backend = 'rtsp_hls';
	}

	const ttlSec = Number(
		firstDefined(
			raw?.continue_interval,
			raw?.continueInterval,
			raw?.duration,
			deepFindByKeys(raw, ['continue_interval', 'continueInterval', 'duration']),
		) || 30,
	);
	const expiresAt =
		firstDefined(
			raw?.expires_at,
			raw?.expiresAt,
			raw?.expiration,
			raw?.valid_until,
			raw?.validUntil,
			deepFindByKeys(raw, ['expires_at', 'expiresAt', 'expiration', 'valid_until', 'validUntil']),
		) || new Date(Date.now() + (Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : 30) * 1000).toISOString();

	return {
		sessionId: String(sessionId || ''),
		backend,
		sourceUrl: String(sourceUrl),
		expiresAt: String(expiresAt),
		transaction: String(firstDefined(raw?.transaction, deepFindByKeys(raw, ['transaction'])) || ''),
		playerTransaction: String(
			firstDefined(
				raw?.player_transaction,
				raw?.playerTransaction,
				deepFindByKeys(raw, ['player_transaction', 'playerTransaction']),
			) || '',
		),
		duration: Number(ttlSec || 0),
		raw,
	};
}

function _liveViewBaseCandidates(accountId, networkId, cameraId, apiType = 'camera') {
	const kind = String(apiType || 'camera').toLowerCase();

	if (kind === 'doorbell') {
		return [
			`/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}`,
			`/api/v1/accounts/${accountId}/networks/${networkId}/doorbell/${cameraId}`,
			`/network/${networkId}/doorbells/${cameraId}`,
			`/network/${networkId}/doorbell/${cameraId}`,
		];
	}

	if (kind === 'owl' || kind === 'mini') {
		return [
			`/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}`,
			`/api/v1/accounts/${accountId}/networks/${networkId}/owl/${cameraId}`,
			`/network/${networkId}/owls/${cameraId}`,
			`/network/${networkId}/owl/${cameraId}`,
		];
	}

	return [
		`/api/v1/accounts/${accountId}/networks/${networkId}/cameras/${cameraId}`,
		`/api/v1/accounts/${accountId}/networks/${networkId}/camera/${cameraId}`,
		`/network/${networkId}/cameras/${cameraId}`,
		`/network/${networkId}/camera/${cameraId}`,
	];
}

function _uniqueCandidateObjects(list) {
	const seen = new Set();
	return list.filter(item => {
		const key = JSON.stringify(item);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function _liveViewStartCandidates(accountId, networkId, cameraId, apiType = 'camera') {
	const bases = _liveViewBaseCandidates(accountId, networkId, cameraId, apiType);
	const out = [];

	for (const base of bases) {
		out.push({ method: 'POST', path: `${base}/liveview`, body: {}, label: `${base}/liveview POST {}` });
		out.push({ method: 'POST', path: `${base}/liveview/start`, body: {}, label: `${base}/liveview/start POST {}` });
		out.push({ method: 'POST', path: `${base}/live_stream`, body: {}, label: `${base}/live_stream POST {}` });
		out.push({ method: 'POST', path: `${base}/live`, body: {}, label: `${base}/live POST {}` });

		out.push({
			method: 'POST',
			path: `${base}/liveview`,
			body: { command: 'start' },
			label: `${base}/liveview POST command=start`,
		});
		out.push({
			method: 'POST',
			path: `${base}/liveview/start`,
			body: { command: 'start' },
			label: `${base}/liveview/start POST command=start`,
		});
		out.push({
			method: 'POST',
			path: `${base}/live_stream`,
			body: { command: 'start' },
			label: `${base}/live_stream POST command=start`,
		});

		out.push({ method: 'GET', path: `${base}/liveview`, label: `${base}/liveview GET` });
		out.push({ method: 'GET', path: `${base}/liveview/start`, label: `${base}/liveview/start GET` });
		out.push({ method: 'GET', path: `${base}/live_stream`, label: `${base}/live_stream GET` });
		out.push({ method: 'GET', path: `${base}/live`, label: `${base}/live GET` });
	}

	return _uniqueCandidateObjects(out);
}

function _liveViewStatusCandidates(accountId, networkId, cameraId, apiType = 'camera', sessionId = '') {
	const bases = _liveViewBaseCandidates(accountId, networkId, cameraId, apiType);
	const out = [];

	for (const base of bases) {
		out.push({ method: 'GET', path: `${base}/liveview`, label: `${base}/liveview status GET` });
		out.push({ method: 'GET', path: `${base}/live`, label: `${base}/live status GET` });
		if (sessionId) {
			out.push({
				method: 'GET',
				path: `${base}/liveview/${sessionId}`,
				label: `${base}/liveview/${sessionId} GET`,
			});
			out.push({ method: 'GET', path: `${base}/live/${sessionId}`, label: `${base}/live/${sessionId} GET` });
		}
	}

	if (sessionId) {
		out.push({
			method: 'GET',
			path: `/api/v1/accounts/${accountId}/liveview/${sessionId}`,
			label: `account liveview/${sessionId} GET`,
		});
		out.push({
			method: 'GET',
			path: `/api/v1/accounts/${accountId}/liveviews/${sessionId}`,
			label: `account liveviews/${sessionId} GET`,
		});
		out.push({ method: 'GET', path: `/liveview/${sessionId}`, label: `liveview/${sessionId} GET` });
		out.push({ method: 'GET', path: `/liveviews/${sessionId}`, label: `liveviews/${sessionId} GET` });
	}

	return _uniqueCandidateObjects(out);
}

function _liveViewPlayerCandidates(accountId, networkId, cameraId, apiType = 'camera', raw = {}) {
	const bases = _liveViewBaseCandidates(accountId, networkId, cameraId, apiType);
	const sessionId =
		firstDefined(
			raw?.id,
			raw?.session_id,
			raw?.sessionId,
			raw?.command_id,
			raw?.commandId,
			raw?.liveview_id,
			raw?.liveviewId,
			raw?.transaction,
		) || '';
	const transaction = firstDefined(raw?.transaction, raw?.player_transaction, raw?.playerTransaction) || '';
	const playerTransaction = firstDefined(raw?.player_transaction, raw?.playerTransaction, raw?.transaction) || '';
	const server = firstDefined(raw?.server, raw?.stream_url, raw?.source_url, raw?.url) || '';

	const out = [];

	for (const base of bases) {
		// direkte Objekt-/Statuspfade
		if (sessionId) {
			out.push({
				method: 'GET',
				path: `${base}/liveview/${sessionId}`,
				label: `${base}/liveview/${sessionId} GET`,
			});
			out.push({ method: 'GET', path: `${base}/live/${sessionId}`, label: `${base}/live/${sessionId} GET` });
			out.push({
				method: 'GET',
				path: `${base}/commands/${sessionId}`,
				label: `${base}/commands/${sessionId} GET`,
			});
			out.push({
				method: 'GET',
				path: `${base}/command/${sessionId}`,
				label: `${base}/command/${sessionId} GET`,
			});
		}

		// vermutete Player-/Relay-Endpunkte
		out.push({
			method: 'POST',
			path: `${base}/liveview/player`,
			body: { transaction, player_transaction: playerTransaction },
			label: `${base}/liveview/player POST tx`,
		});
		out.push({
			method: 'POST',
			path: `${base}/liveview/session`,
			body: { transaction, player_transaction: playerTransaction },
			label: `${base}/liveview/session POST tx`,
		});
		out.push({
			method: 'POST',
			path: `${base}/liveview/relay`,
			body: { transaction, player_transaction: playerTransaction },
			label: `${base}/liveview/relay POST tx`,
		});
		out.push({
			method: 'POST',
			path: `${base}/liveview/stream`,
			body: { transaction, player_transaction: playerTransaction },
			label: `${base}/liveview/stream POST tx`,
		});
		out.push({
			method: 'POST',
			path: `${base}/liveview/start`,
			body: { transaction, player_transaction: playerTransaction },
			label: `${base}/liveview/start POST tx`,
		});

		out.push({
			method: 'GET',
			path: `${base}/liveview/player`,
			query: { transaction, player_transaction: playerTransaction },
			label: `${base}/liveview/player GET tx`,
		});
		out.push({
			method: 'GET',
			path: `${base}/liveview/session`,
			query: { transaction, player_transaction: playerTransaction },
			label: `${base}/liveview/session GET tx`,
		});
		out.push({
			method: 'GET',
			path: `${base}/liveview/relay`,
			query: { transaction, player_transaction: playerTransaction },
			label: `${base}/liveview/relay GET tx`,
		});
		out.push({
			method: 'GET',
			path: `${base}/liveview/stream`,
			query: { transaction, player_transaction: playerTransaction },
			label: `${base}/liveview/stream GET tx`,
		});

		if (sessionId) {
			out.push({
				method: 'GET',
				path: `${base}/liveview/${sessionId}/player`,
				label: `${base}/liveview/${sessionId}/player GET`,
			});
			out.push({
				method: 'GET',
				path: `${base}/liveview/${sessionId}/stream`,
				label: `${base}/liveview/${sessionId}/stream GET`,
			});
			out.push({
				method: 'POST',
				path: `${base}/liveview/${sessionId}/player`,
				body: { transaction, player_transaction: playerTransaction },
				label: `${base}/liveview/${sessionId}/player POST tx`,
			});
			out.push({
				method: 'POST',
				path: `${base}/liveview/${sessionId}/stream`,
				body: { transaction, player_transaction: playerTransaction },
				label: `${base}/liveview/${sessionId}/stream POST tx`,
			});
		}
	}

	// accountweite Kandidaten
	if (sessionId) {
		out.push({
			method: 'GET',
			path: `/api/v1/accounts/${accountId}/liveview/${sessionId}`,
			label: `account liveview/${sessionId} GET`,
		});
		out.push({
			method: 'GET',
			path: `/api/v1/accounts/${accountId}/liveviews/${sessionId}`,
			label: `account liveviews/${sessionId} GET`,
		});
		out.push({
			method: 'GET',
			path: `/api/v1/accounts/${accountId}/liveview/${sessionId}/player`,
			label: `account liveview/${sessionId}/player GET`,
		});
		out.push({
			method: 'GET',
			path: `/api/v1/accounts/${accountId}/liveview/${sessionId}/stream`,
			label: `account liveview/${sessionId}/stream GET`,
		});
	}

	if (transaction || playerTransaction) {
		out.push({
			method: 'GET',
			path: `/api/v1/accounts/${accountId}/liveview/player`,
			query: { transaction, player_transaction: playerTransaction },
			label: `account liveview/player GET tx`,
		});
		out.push({
			method: 'POST',
			path: `/api/v1/accounts/${accountId}/liveview/player`,
			body: { transaction, player_transaction: playerTransaction },
			label: `account liveview/player POST tx`,
		});
		out.push({
			method: 'GET',
			path: `/api/v1/accounts/${accountId}/liveview/session`,
			query: { transaction, player_transaction: playerTransaction },
			label: `account liveview/session GET tx`,
		});
		out.push({
			method: 'POST',
			path: `/api/v1/accounts/${accountId}/liveview/session`,
			body: { transaction, player_transaction: playerTransaction },
			label: `account liveview/session POST tx`,
		});
	}

	if (server) {
		out.push({ method: 'RAW_RTSPS', url: String(server), label: `raw server ${server}` });
	}

	return _uniqueCandidateObjects(out);
}

function _liveViewStopCandidates(accountId, networkId, cameraId, apiType = 'camera', liveSession = {}) {
	const sessionId = liveSession?.sessionId || liveSession?.id || '';
	const bases = _liveViewBaseCandidates(accountId, networkId, cameraId, apiType);
	const out = [];

	for (const base of bases) {
		if (sessionId) {
			out.push({
				method: 'POST',
				path: `${base}/liveview/${sessionId}/stop`,
				body: {},
				label: `${base}/liveview/${sessionId}/stop POST`,
			});
			out.push({
				method: 'POST',
				path: `${base}/live/${sessionId}/stop`,
				body: {},
				label: `${base}/live/${sessionId}/stop POST`,
			});
		}
		out.push({ method: 'POST', path: `${base}/liveview/stop`, body: {}, label: `${base}/liveview/stop POST` });
		out.push({ method: 'POST', path: `${base}/live/stop`, body: {}, label: `${base}/live/stop POST` });
	}

	if (sessionId) {
		out.push({
			method: 'POST',
			path: `/api/v1/accounts/${accountId}/liveview/${sessionId}/stop`,
			body: {},
			label: `account liveview/${sessionId}/stop POST`,
		});
		out.push({
			method: 'POST',
			path: `/api/v1/accounts/${accountId}/liveviews/${sessionId}/stop`,
			body: {},
			label: `account liveviews/${sessionId}/stop POST`,
		});
		out.push({
			method: 'POST',
			path: `/liveview/${sessionId}/stop`,
			body: {},
			label: `liveview/${sessionId}/stop POST`,
		});
		out.push({
			method: 'POST',
			path: `/liveviews/${sessionId}/stop`,
			body: {},
			label: `liveviews/${sessionId}/stop POST`,
		});
	}

	return _uniqueCandidateObjects(out);
}

async function _liveViewTryCandidate(session, candidate) {
	if (candidate.method === 'RAW_RTSPS') {
		return { server: candidate.url };
	}
	let path = candidate.path;
	if (candidate.query && typeof candidate.query === 'object') {
		const usp = new URLSearchParams();
		for (const [k, v] of Object.entries(candidate.query)) {
			if (v !== undefined && v !== null && String(v) !== '') {
				usp.set(k, String(v));
			}
		}
		const qs = usp.toString();
		if (qs) {
			path = `${path}${path.includes('?') ? '&' : '?'}${qs}`;
		}
	}
	if (candidate.method === 'GET') {
		return _restGet(path, session.accessToken, session.apiHost);
	}
	return _restPost(path, session.accessToken, session.apiHost, candidate.body || {});
}

/**
 * Startet eine LiveView-Session für eine Kamera.
 *
 * @param {object} session - Die aktive Blink-Session mit accessToken und apiHost.
 * @param {string|number} networkId - Die Netzwerk-ID des Geräts.
 * @param {string|number} cameraId - Die Kamera-ID.
 * @param {string} [apiType] - Der Kameratyp (z.B. 'camera', 'owl', 'doorbell').
 */
async function startLiveView(session, networkId, cameraId, apiType = 'camera') {
	const accountId = await _getAccountId(session);
	const candidates = _liveViewStartCandidates(accountId, networkId, cameraId, apiType);
	dbg(
		`LIVEVIEW START DEBUG account=${accountId} network=${networkId} camera=${cameraId} apiType=${apiType} candidates=${candidates.length}`,
	);

	let lastErr = null;

	for (const candidate of candidates) {
		try {
			dbg(`LIVEVIEW START TRY ${candidate.label}`);
			const raw = await _liveViewTryCandidate(session, candidate);
			dbg(`LIVEVIEW START RAW ${candidate.label} => ${JSON.stringify(raw).slice(0, 3000)}`);

			try {
				const normalized = _normalizeLiveViewResponse(raw, session);
				dbg(
					`LIVEVIEW START HIT ${candidate.label} backend=${normalized.backend} url=${normalized.sourceUrl} session=${normalized.sessionId}`,
				);

				const playerCandidates = _liveViewPlayerCandidates(accountId, networkId, cameraId, apiType, raw);
				if (playerCandidates.length) {
					for (const playerCandidate of playerCandidates) {
						try {
							dbg(`LIVEVIEW PLAYER TRY ${playerCandidate.label}`);
							const playerRaw = await _liveViewTryCandidate(session, playerCandidate);
							dbg(
								`LIVEVIEW PLAYER RAW ${playerCandidate.label} => ${JSON.stringify(playerRaw).slice(0, 3000)}`,
							);
							const playerNormalized = _normalizeLiveViewResponse(playerRaw, session);
							dbg(
								`LIVEVIEW PLAYER HIT ${playerCandidate.label} backend=${playerNormalized.backend} url=${playerNormalized.sourceUrl} session=${playerNormalized.sessionId}`,
							);
							return playerNormalized;
						} catch (playerErr) {
							dbg(`LIVEVIEW PLAYER FAIL ${playerCandidate.label}: ${playerErr?.message || playerErr}`);
						}
					}
					dbg(`LIVEVIEW PLAYER NO-HIT ${candidate.label} -> fallback to start result`);
				}

				return normalized;
			} catch (normalizeErr) {
				const sid =
					firstDefined(
						raw?.session_id,
						raw?.sessionId,
						raw?.id,
						raw?.command_id,
						raw?.commandId,
						raw?.liveview_id,
						raw?.liveviewId,
						deepFindByKeys(raw, [
							'session_id',
							'sessionId',
							'id',
							'command_id',
							'commandId',
							'liveview_id',
							'liveviewId',
						]),
					) || '';
				dbg(
					`LIVEVIEW START NO-URL ${candidate.label} session=${sid || '(none)'} reason=${normalizeErr.message}`,
				);

				const playerCandidates = _liveViewPlayerCandidates(accountId, networkId, cameraId, apiType, raw);
				for (const playerCandidate of playerCandidates) {
					try {
						dbg(`LIVEVIEW PLAYER TRY ${playerCandidate.label}`);
						const playerRaw = await _liveViewTryCandidate(session, playerCandidate);
						dbg(
							`LIVEVIEW PLAYER RAW ${playerCandidate.label} => ${JSON.stringify(playerRaw).slice(0, 3000)}`,
						);
						const normalized = _normalizeLiveViewResponse(playerRaw, session);
						dbg(
							`LIVEVIEW PLAYER HIT ${playerCandidate.label} backend=${normalized.backend} url=${normalized.sourceUrl} session=${normalized.sessionId}`,
						);
						return normalized;
					} catch (playerErr) {
						dbg(`LIVEVIEW PLAYER FAIL ${playerCandidate.label}: ${playerErr?.message || playerErr}`);
					}
				}

				if (sid) {
					const statusCandidates = _liveViewStatusCandidates(accountId, networkId, cameraId, apiType, sid);
					for (const waitMs of [500, 1500, 3000]) {
						await _sleep(waitMs);
						for (const statusCandidate of statusCandidates) {
							try {
								dbg(`LIVEVIEW STATUS TRY ${statusCandidate.label} wait=${waitMs}`);
								const statusRaw = await _liveViewTryCandidate(session, statusCandidate);
								dbg(
									`LIVEVIEW STATUS RAW ${statusCandidate.label} wait=${waitMs} => ${JSON.stringify(statusRaw).slice(0, 3000)}`,
								);
								const normalized = _normalizeLiveViewResponse(statusRaw, session);
								dbg(
									`LIVEVIEW STATUS HIT ${statusCandidate.label} backend=${normalized.backend} url=${normalized.sourceUrl} session=${normalized.sessionId}`,
								);
								return normalized;
							} catch (statusErr) {
								dbg(
									`LIVEVIEW STATUS FAIL ${statusCandidate.label} wait=${waitMs}: ${statusErr?.message || statusErr}`,
								);
							}
						}
					}
				}
			}
		} catch (e) {
			lastErr = e;
			dbg(`LIVEVIEW START FAIL ${candidate.label}: ${e?.message || e}`);
		}
	}

	throw lastErr || new Error('Kein LiveView-Endpoint erfolgreich');
}

/**
 * Beendet eine laufende LiveView-Session.
 *
 * @param {object} session - Die aktive Blink-Session mit accessToken und apiHost.
 * @param {object} [liveSession] - Die LiveView-Session-Daten (networkId, cameraId, apiType).
 */
async function stopLiveView(session, liveSession = {}) {
	const accountId = await _getAccountId(session);
	const networkId = liveSession?.networkId;
	const cameraId = liveSession?.cameraId;
	const apiType = liveSession?.apiType || 'camera';
	const candidates = _liveViewStopCandidates(accountId, networkId, cameraId, apiType, liveSession);

	dbg(
		`LIVEVIEW STOP DEBUG account=${accountId} session=${JSON.stringify(liveSession || {}).slice(0, 500)} candidates=${candidates.length}`,
	);

	let lastErr = null;
	for (const candidate of candidates) {
		try {
			dbg(`LIVEVIEW STOP TRY ${candidate.label}`);
			const raw = await _liveViewTryCandidate(session, candidate);
			dbg(`LIVEVIEW STOP RAW ${candidate.label} => ${JSON.stringify(raw).slice(0, 2000)}`);
			return { ok: true, raw };
		} catch (e) {
			lastErr = e;
			dbg(`LIVEVIEW STOP FAIL ${candidate.label}: ${e?.message || e}`);
		}
	}

	if (lastErr) {
		dbg(`LIVEVIEW STOP giving up: ${lastErr?.message || lastErr}`);
	}
	return { ok: true };
}

/**
 * Schärft (arm) bzw. entschärft (disarm) ein Blink-Network.
 *
 * @param {object} session - Gültige Session.
 * @param {string|number} networkId - Network-ID, das geschärft werden soll.
 * @param {boolean} armed - true ruft den arm-, false den disarm-Endpunkt auf.
 * @returns {Promise<object>} Antwort der Blink-API.
 */
async function setArmed(session, networkId, armed) {
	const accountId = await _getAccountId(session);
	return _restPost(
		`/api/v1/accounts/${accountId}/networks/${networkId}/state/${armed ? 'arm' : 'disarm'}`,
		session.accessToken,
		session.apiHost,
	);
}

/**
 * Wandelt Batterie-Rohwerte (entweder ganzzahlige Centivolt-Angaben wie 145
 * oder bereits Volt-Werte wie 1.45) auf zwei Nachkommastellen genau in Volt um.
 *
 * @param {number|string|null|undefined} raw - Rohwert aus der Blink-API.
 * @returns {?number} Spannung in Volt, oder null, wenn der Wert nicht numerisch ist.
 */
function batteryToVolt(raw) {
	if (raw == null) {
		return null;
	}
	const v = Number(raw);
	if (!Number.isFinite(v)) {
		return null;
	}
	return Math.abs(v) >= 10 ? Math.round((v / 100) * 100) / 100 : Math.round(v * 100) / 100;
}
function _sleep(ms) {
	return new Promise(r => setTimeout(r, ms));
}

module.exports = {
	getSession,
	login,
	clearSession,
	getDevices,
	snapshot,
	snapshotBuffer,
	setMotion,
	setArmed,
	getLatestVideoInfo,
	getLatestVideoSummary,
	downloadVideo,
	getLocalStorageClips,
	downloadLocalClip,
	getCloudClips,
	downloadCloudClip,
	getHistoryClips,
	batteryToVolt,
	DEBUG_LOG,
	setDebugEnabled,
	startLiveView,
	stopLiveView,
};
