"use strict";

/**
 * Blink API Client – DEBUG-VERSION
 * Loggt jeden HTTP-Request/Response vollständig nach /tmp/blink_debug.log
 * Passwort wird maskiert, Cookie-Werte gekürzt dargestellt.
 */

const https  = require("https");
const zlib   = require("zlib");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");
const { URLSearchParams } = require("url");

const DEBUG_LOG = "/tmp/blink_debug.log";

function dbg(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(DEBUG_LOG, line); } catch {}
}

// ─── Konstanten ───────────────────────────────────────────────────────────────

const OAUTH_HOST   = "api.oauth.blink.com";
const OAUTH_ORIGIN = "https://api.oauth.blink.com";
const CLIENT_ID    = "ios";
const APP_BRAND    = "blink";
const APP_VERSION  = "50.1";
const SCOPE        = "client";
const REDIRECT_URI = "immedia-blink://applinks.blink.com/signin/callback";
const UA_HTML      = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
const UA_TOKEN     = "Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0";
const REST_HOST    = "rest-prod.immedia-semi.com";
const CACHE_DIR    = "/tmp/blink_session_cache";

function toBase64UrlNoPad(buf) {
    return buf.toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function newPkcePair() {
    const verifier  = toBase64UrlNoPad(crypto.randomBytes(32));
    const challenge = toBase64UrlNoPad(crypto.createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
}

function decodedBody(res, rawBuf) {
    const enc = (res.headers["content-encoding"] || "").toLowerCase();
    try {
        if (enc.includes("br"))      return zlib.brotliDecompressSync(rawBuf).toString("utf8");
        if (enc.includes("gzip"))    return zlib.gunzipSync(rawBuf).toString("utf8");
        if (enc.includes("deflate")) return zlib.inflateSync(rawBuf).toString("utf8");
    } catch (e) { dbg(`DECODE ERROR (${enc}): ${e.message}`); }
    return rawBuf.toString("utf8");
}

function maskBody(s) {
    return String(s)
        .replace(/(password=)[^&]+/gi, "$1***")
        .replace(/("password"\s*:\s*")[^"]+(")/gi, '$1***$2');
}

function rawReq(label, opts, bodyStr) {
    return new Promise((resolve, reject) => {
        const fullUrl = `https://${opts.hostname}${opts.path}`;
        dbg("");
        dbg(`========== ${label} ==========`);
        dbg(`${opts.method} ${fullUrl}`);
        dbg(`REQUEST HEADERS:`);
        for (const [k, v] of Object.entries(opts.headers || {})) {
            const show = k.toLowerCase() === "cookie"
                ? `<${String(v).length} bytes> keys=[${String(v).split(";").map(c => c.trim().split("=")[0]).join(",")}]`
                : String(v);
            dbg(`  ${k}: ${show}`);
        }
        if (bodyStr) {
            dbg(`REQUEST BODY (${Buffer.byteLength(bodyStr)} bytes):`);
            dbg(`  ${maskBody(bodyStr)}`);
        }

        const req = https.request(opts, res => {
            const chunks = [];
            res.on("data", d => chunks.push(d));
            res.on("end", () => {
                const raw  = Buffer.concat(chunks);
                const body = decodedBody(res, raw);
                dbg(`RESPONSE: HTTP ${res.statusCode} ${res.statusMessage || ""}`);
                dbg(`RESPONSE HEADERS:`);
                for (const [k, v] of Object.entries(res.headers)) {
                    dbg(`  ${k}: ${Array.isArray(v) ? v.join(" ||| ") : v}`);
                }
                dbg(`RESPONSE BODY (${body.length} chars, encoding=${res.headers["content-encoding"] || "none"}):`);
                dbg(body.length > 3000 ? body.slice(0, 3000) + "\n...[TRUNCATED at 3000 chars]" : body);
                resolve({ status: res.statusCode, headers: res.headers, body });
            });
        });
        req.on("error", e => { dbg(`REQUEST ERROR: ${e.message}`); reject(e); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

function mergeCookies(jar, headers) {
    for (const line of (headers["set-cookie"] || [])) {
        const seg = line.split(";")[0].trim();
        const i   = seg.indexOf("=");
        if (i < 0) continue;
        jar[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
    }
}
function cookieStr(jar) {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractCsrf(html) {
    const scriptMatch = html.match(/<script\s+id=["']oauth-args["']\s+type=["']application\/json["']>([\s\S]*?)<\/script>/i);
    if (scriptMatch) {
        try {
            const parsed = JSON.parse(scriptMatch[1]);
            if (parsed && typeof parsed["csrf-token"] === "string" && parsed["csrf-token"]) {
                dbg(`CSRF gefunden via script#oauth-args JSON`);
                return parsed["csrf-token"];
            }
        } catch (e) {
            dbg(`CSRF oauth-args JSON Parse-Fehler: ${e.message}`);
        }
    }
    dbg(`CSRF: script#oauth-args mit 'csrf-token' nicht gefunden`);
    return null;
}

function buildQS(obj) { return new URLSearchParams(obj).toString(); }
function tryJSON(t)    { try { return JSON.parse(t); } catch { return {}; } }

function cacheFile(email) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    return path.join(CACHE_DIR, crypto.createHash("sha256").update(email).digest("hex") + ".json");
}
function loadSession(email)    { try { return JSON.parse(fs.readFileSync(cacheFile(email), "utf8")); } catch { return null; } }
function saveSession(email, s) { try { fs.writeFileSync(cacheFile(email), JSON.stringify(s), "utf8"); } catch {} }
function clearSession(email)   { try { fs.unlinkSync(cacheFile(email)); } catch {} }

function hdrsGet(jar) {
    const h = {
        "User-Agent":      UA_HTML,
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection":      "keep-alive",
    };
    if (jar && Object.keys(jar).length > 0) h["Cookie"] = cookieStr(jar);
    return h;
}

function hdrsPost(jar, refererPath) {
    const referer = refererPath
        ? `${OAUTH_ORIGIN}${refererPath}`
        : `${OAUTH_ORIGIN}/oauth/v2/signin`;
    const h = {
        "User-Agent":      UA_HTML,
        "Content-Type":    "application/x-www-form-urlencoded",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Origin":          OAUTH_ORIGIN,
        "Referer":         referer,
        "Connection":      "keep-alive",
    };
    if (jar && Object.keys(jar).length > 0) h["Cookie"] = cookieStr(jar);
    return h;
}

function hdrsToken() {
    return {
        "User-Agent":      UA_TOKEN,
        "Content-Type":    "application/x-www-form-urlencoded",
        "Accept":          "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection":      "keep-alive",
    };
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function login(email, password, pin, hardwareId) {
    try {
        fs.writeFileSync(DEBUG_LOG,
            `======================================================\n` +
            `Blink OAuth Debug-Log\n` +
            `Start: ${new Date().toISOString()}\n` +
            `Email: ${email}\n` +
            `PIN angegeben: ${pin ? "ja" : "nein"}\n` +
            `hardwareId cached: ${hardwareId || "(neu generiert)"}\n` +
            `Node: ${process.version}\n` +
            `======================================================\n`);
    } catch {}

    if (!hardwareId) hardwareId = crypto.randomUUID().toUpperCase();
    dbg(`hardwareId final: ${hardwareId}`);

    const { verifier, challenge } = newPkcePair();
    dbg(`PKCE verifier length: ${verifier.length}`);
    dbg(`PKCE challenge: ${challenge}`);

    const jar = {};

    const authQS = buildQS({
        app_brand: APP_BRAND, app_version: APP_VERSION, client_id: CLIENT_ID,
        code_challenge: challenge, code_challenge_method: "S256",
        device_brand: "Apple", device_model: "iPhone16,1", device_os_version: "26.1",
        hardware_id: hardwareId, redirect_uri: REDIRECT_URI,
        response_type: "code", scope: SCOPE
    });

    const s1 = await rawReq("STEP 1: GET /oauth/v2/authorize", {
        hostname: OAUTH_HOST, path: `/oauth/v2/authorize?${authQS}`, method: "GET",
        headers: hdrsGet(null)
    });
    mergeCookies(jar, s1.headers);
    dbg(`Cookie-Jar nach STEP 1: [${Object.keys(jar).join(", ")}]`);

    let signinPath = s1.headers["location"];
    if (signinPath) {
        dbg(`STEP 1 Redirect zu: ${signinPath}`);
        if (signinPath.startsWith("http")) {
            const u = new URL(signinPath);
            signinPath = u.pathname + u.search;
            dbg(`Redirect-Pfad extrahiert: ${signinPath}`);
        }
    } else {
        dbg(`STEP 1 kein Redirect, nutze Fallback /oauth/v2/signin`);
        signinPath = "/oauth/v2/signin";
    }

    const s2 = await rawReq("STEP 2: GET " + signinPath, {
        hostname: OAUTH_HOST, path: signinPath, method: "GET",
        headers: hdrsGet(jar)
    });
    mergeCookies(jar, s2.headers);
    dbg(`Cookie-Jar nach STEP 2: [${Object.keys(jar).join(", ")}]`);

    let html = s2.body;
    let finalSigninPath = signinPath;

    if ((s2.status === 301 || s2.status === 302) && s2.headers["location"]) {
        let loc = s2.headers["location"];
        if (loc.startsWith("http")) {
            const u = new URL(loc);
            loc = u.pathname + u.search;
        }
        dbg(`STEP 2 weiterer Redirect zu: ${loc}`);
        finalSigninPath = loc;
        const s2b = await rawReq("STEP 2b: GET " + finalSigninPath, {
            hostname: OAUTH_HOST, path: finalSigninPath, method: "GET",
            headers: hdrsGet(jar)
        });
        mergeCookies(jar, s2b.headers);
        html = s2b.body;
    }

    const csrfToken = extractCsrf(html);
    const csrfField = "csrf-token";
    dbg(`CSRF aus HTML: ${csrfToken ? "gefunden (" + csrfToken.length + " Zeichen)" : "NICHT gefunden"}`);
    dbg(`CSRF-Feldname fix: ${csrfField}`);

    if (!csrfToken) {
        const snippet = html.slice(0, 1500).replace(/\s+/g, " ");
        dbg(`CSRF FEHLT! HTML-Anfang (1500 chars): ${snippet}`);
        throw new Error(`CSRF-Token nicht gefunden. Debug-Log: ${DEBUG_LOG}`);
    }
    dbg(`CSRF final: token[0..10]=${csrfToken.slice(0,10)}... field="${csrfField}"`);

    // STEP 3: POST form-encoded mit csrf-token im Body.
    const s3body = buildQS({
        username: email,
        password: password,
        [csrfField]: csrfToken,
    });
    const s3hdrs = hdrsPost(jar, finalSigninPath);
    s3hdrs["Accept"] = "*/*";
    s3hdrs["Content-Length"] = Buffer.byteLength(s3body);

    const s3 = await rawReq("STEP 3: POST " + finalSigninPath + " (form-encoded)", {
        hostname: OAUTH_HOST, path: finalSigninPath, method: "POST",
        headers: s3hdrs
    }, s3body);
    mergeCookies(jar, s3.headers);
    dbg(`Cookie-Jar nach STEP 3: [${Object.keys(jar).join(", ")}]`);

    let step3location = s3.headers["location"] || "";
    dbg(`STEP 3 Location: ${step3location}`);

    if (s3.status === 412) {
        if (pin) {
            const step3State = { jar, csrfToken, csrfField, signinPath: finalSigninPath, step3location };
            await _step3b(step3State, pin);
            step3location = step3State.step3location || step3location;
            dbg(`STEP 3b Location: ${step3location}`);
        } else {
            const err = new Error("2FA/PIN erforderlich. PIN in Konfiguration eintragen und neu starten.");
            err.code  = "NEED_2FA";
            err.state = { jar, csrfToken, csrfField, signinPath: finalSigninPath, hardwareId, verifier };
            throw err;
        }
    } else if (!(s3.status >= 300 && s3.status < 400 && step3location)) {
        throw new Error(
            `Blink Login fehlgeschlagen: HTTP ${s3.status} – Location="${step3location}" Body=${s3.body.slice(0, 300)}\n` +
            `Siehe Debug-Log: ${DEBUG_LOG}`);
    }

    return _step4_5({ jar, hardwareId, verifier, step3location }, email);
}

async function _step3b(state, pin) {
    const { jar, csrfToken, signinPath } = state;
    const body = buildQS({
        "2fa_code": pin,
        "csrf-token": csrfToken,
        "remember_me": "false",
    });
    const hdrs = hdrsPost(jar, signinPath || "/oauth/v2/signin");
    hdrs["Accept"] = "*/*";
    hdrs["Content-Length"] = Buffer.byteLength(body);

    const r = await rawReq("STEP 3b: POST /oauth/v2/2fa/verify (form-encoded)", {
        hostname: OAUTH_HOST, path: "/oauth/v2/2fa/verify", method: "POST",
        headers: hdrs
    }, body);
    mergeCookies(state.jar, r.headers);

    if (r.status >= 400) {
        throw new Error(`2FA fehlgeschlagen: HTTP ${r.status} – ${r.body.slice(0,200)}`);
    }
    if (r.headers["location"]) state.step3location = r.headers["location"];
}

async function _step4_5(state, email) {
    const { jar, hardwareId, verifier, step3location } = state;

    let authPath = step3location || "";
    if (authPath.startsWith("http")) {
        const u = new URL(authPath);
        if (u.hostname === OAUTH_HOST) {
            authPath = u.pathname + u.search;
        } else {
            const code = u.searchParams.get("code");
            if (code) return _exchangeCode({ jar, hardwareId, verifier, code }, email);
        }
    }

    if (!authPath) {
        dbg(`STEP 4: kein Redirect aus STEP 3/3b, versuche erneutes GET /oauth/v2/authorize`);
        const s4bare = await rawReq("STEP 4a: GET /oauth/v2/authorize (bare)", {
            hostname: OAUTH_HOST, path: "/oauth/v2/authorize", method: "GET",
            headers: hdrsGet(jar)
        });
        mergeCookies(jar, s4bare.headers);
        const loc4bare = s4bare.headers["location"] || "";
        dbg(`STEP 4a Location: ${loc4bare}`);

        let codeBare = null;
        try {
            const u = loc4bare.startsWith("http") ? new URL(loc4bare) : new URL(`https://x${loc4bare}`);
            codeBare = u.searchParams.get("code");
            if (!authPath && u.hostname === OAUTH_HOST) authPath = u.pathname + u.search;
        } catch {
            const m = loc4bare.match(/[?&]code=([^&]+)/);
            codeBare = m ? m[1] : null;
        }
        if (codeBare) return _exchangeCode({ jar, hardwareId, verifier, code: codeBare }, email);

        if (!authPath) {
            const challenge = toBase64UrlNoPad(crypto.createHash("sha256").update(verifier).digest());
            const authQS = buildQS({
                app_brand: APP_BRAND, app_version: APP_VERSION, client_id: CLIENT_ID,
                code_challenge: challenge, code_challenge_method: "S256",
                device_brand: "Apple", device_model: "iPhone16,1", device_os_version: "26.1",
                hardware_id: hardwareId, redirect_uri: REDIRECT_URI,
                response_type: "code", scope: SCOPE
            });
            const fullPath = `/oauth/v2/authorize?${authQS}`;
            dbg(`STEP 4b: bare authorize lieferte keinen Code, versuche vollständigen Authorize-URL erneut`);
            const s4full = await rawReq("STEP 4b: GET /oauth/v2/authorize?…", {
                hostname: OAUTH_HOST, path: fullPath, method: "GET",
                headers: hdrsGet(jar)
            });
            mergeCookies(jar, s4full.headers);
            const loc4full = s4full.headers["location"] || "";
            dbg(`STEP 4b Location: ${loc4full}`);

            let codeFull = null;
            try {
                const u = loc4full.startsWith("http") ? new URL(loc4full) : new URL(`https://x${loc4full}`);
                codeFull = u.searchParams.get("code");
                if (!authPath && u.hostname === OAUTH_HOST) authPath = u.pathname + u.search;
            } catch {
                const m = loc4full.match(/[?&]code=([^&]+)/);
                codeFull = m ? m[1] : null;
            }
            if (codeFull) return _exchangeCode({ jar, hardwareId, verifier, code: codeFull }, email);
        }
    }

    if (!authPath) throw new Error("OAuth Step4: Kein Redirect-Ziel aus STEP 3, 3b oder erneutem /authorize");

    const s4 = await rawReq("STEP 4: GET " + authPath, {
        hostname: OAUTH_HOST, path: authPath, method: "GET",
        headers: hdrsGet(jar)
    });
    mergeCookies(jar, s4.headers);

    const loc4 = s4.headers["location"] || "";
    dbg(`STEP 4 Location: ${loc4}`);

    let code;
    try {
        const u = loc4.startsWith("http") ? new URL(loc4) : new URL(`https://x${loc4}`);
        code = u.searchParams.get("code");
    } catch {
        const m = loc4.match(/[?&]code=([^&]+)/);
        code = m ? m[1] : null;
    }

    if (!code) throw new Error(`OAuth Step4: Kein auth_code. Status=${s4.status} Location="${loc4.slice(0,300)}"`);
    return _exchangeCode({ jar, hardwareId, verifier, code }, email);
}

async function _exchangeCode(state, email) {
    const { hardwareId, verifier, code } = state;
    const tokBody = buildQS({
        app_brand: APP_BRAND, client_id: CLIENT_ID,
        code, code_verifier: verifier,
        grant_type: "authorization_code", hardware_id: hardwareId,
        redirect_uri: REDIRECT_URI, scope: SCOPE
    });
    const hdrs = hdrsToken();
    hdrs["Content-Length"] = Buffer.byteLength(tokBody);

    const s5 = await rawReq("STEP 5: POST /oauth/token", {
        hostname: OAUTH_HOST, path: "/oauth/token", method: "POST",
        headers: hdrs
    }, tokBody);

    if (s5.status !== 200) throw new Error(`OAuth Token: HTTP ${s5.status} – ${s5.body.slice(0,200)}`);
    const tok = tryJSON(s5.body);
    if (!tok.access_token) throw new Error(`OAuth: kein access_token. Body: ${s5.body.slice(0,200)}`);

    const apiHost = await _resolveApiHost(tok.access_token);
    const session = {
        accessToken:  tok.access_token,
        refreshToken: tok.refresh_token || null,
        expiresAt:    Date.now() + ((tok.expires_in || 3600) - 60) * 1000,
        hardwareId, apiHost, email
    };
    saveSession(email, session);
    dbg(`LOGIN ERFOLGREICH. apiHost=${apiHost}`);
    return session;
}

async function _refreshToken(session) {
    if (!session.refreshToken) throw new Error("Kein refresh_token");
    const body = buildQS({
        app_brand: APP_BRAND, client_id: CLIENT_ID,
        grant_type: "refresh_token", refresh_token: session.refreshToken,
        hardware_id: session.hardwareId, scope: SCOPE
    });
    const hdrs = hdrsToken();
    hdrs["Content-Length"] = Buffer.byteLength(body);

    const r = await rawReq("Token-Refresh: POST /oauth/token", {
        hostname: OAUTH_HOST, path: "/oauth/token", method: "POST", headers: hdrs
    }, body);
    if (r.status !== 200) throw new Error(`Token-Refresh: HTTP ${r.status}`);
    const tok = tryJSON(r.body);
    if (!tok.access_token) throw new Error("Token-Refresh: kein access_token");

    session.accessToken = tok.access_token;
    if (tok.refresh_token) session.refreshToken = tok.refresh_token;
    session.expiresAt   = Date.now() + ((tok.expires_in || 3600) - 60) * 1000;
    saveSession(session.email, session);
    return session;
}

async function _resolveApiHost(accessToken) {
    try {
        const r = await _restGet("/api/v1/users/tier_info", accessToken, REST_HOST);
        if (r?.tier) return `rest-${r.tier}.immedia-semi.com`;
    } catch {}
    return REST_HOST;
}

async function getSession(email, password, pin = "") {
    let s = loadSession(email);
    if (s?.accessToken) {
        if (Date.now() < (s.expiresAt || 0)) return s;
        if (s.refreshToken) {
            try { return await _refreshToken(s); } catch { clearSession(email); }
        }
    }
    return login(email, password, pin, s?.hardwareId);
}

// ─── REST-API ─────────────────────────────────────────────────────────────────

function _apiHdrs(tok) {
    return {
        "Authorization": `Bearer ${tok}`,
        "Content-Type":  "application/json",
        "User-Agent":    UA_TOKEN,
        "Accept":        "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
    };
}

function _restGet(urlPath, tok, host) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname: host || REST_HOST, path: urlPath, method: "GET", headers: _apiHdrs(tok) },
            res => {
                const ch = [];
                res.on("data", d => ch.push(d));
                res.on("end", () => {
                    const t = decodedBody(res, Buffer.concat(ch));
                    if (res.statusCode >= 400) {
                        const e = new Error(`HTTP ${res.statusCode}: ${t.slice(0,300)}`);
                        e.statusCode = res.statusCode;
                        return reject(e);
                    }
                    try { resolve(JSON.parse(t)); } catch { resolve(t); }
                });
            }
        );
        req.on("error", reject);
        req.end();
    });
}

function _isSystemBusyError(err) {
    const msg = String(err?.message || err || "");
    return err?.statusCode === 409 && msg.includes('System is busy');
}

function _restPost(urlPath, tok, host, body) {
    const bs   = body ? JSON.stringify(body) : "";
    const hdrs = { ..._apiHdrs(tok), "Content-Length": Buffer.byteLength(bs) };
    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname: host || REST_HOST, path: urlPath, method: "POST", headers: hdrs },
            res => {
                const ch = [];
                res.on("data", d => ch.push(d));
                res.on("end", () => {
                    const t = decodedBody(res, Buffer.concat(ch));
                    if (res.statusCode >= 400) {
                        const e = new Error(`HTTP ${res.statusCode}: ${t.slice(0,300)}`);
                        e.statusCode = res.statusCode;
                        return reject(e);
                    }
                    try { resolve(JSON.parse(t)); } catch { resolve(t); }
                });
            }
        );
        req.on("error", reject);
        if (bs) req.write(bs);
        req.end();
    });
}

function _decodeBinaryResponse(res, rawBuf) {
    const enc = (res.headers["content-encoding"] || "").toLowerCase();
    try {
        if (enc.includes("br"))      return zlib.brotliDecompressSync(rawBuf);
        if (enc.includes("gzip"))    return zlib.gunzipSync(rawBuf);
        if (enc.includes("deflate")) return zlib.inflateSync(rawBuf);
    } catch (e) {
        dbg(`BINARY DECODE ERROR (${enc}): ${e.message}`);
    }
    return rawBuf;
}

async function _downloadBinary(url, tok) {
    return new Promise((resolve, reject) => {
        const { URL: NURL } = require("url");
        const u   = new NURL(url.startsWith("http") ? url : `https://${REST_HOST}${url}`);
        const req = https.request(
            { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers: _apiHdrs(tok) },
            res => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    const loc = res.headers.location;
                    if (!loc) return reject(new Error(`HTTP ${res.statusCode}: Redirect ohne Location`));
                    const nextUrl = /^https?:\/\//i.test(loc) ? loc : new NURL(loc, u).toString();
                    return _downloadBinary(nextUrl, tok).then(resolve).catch(reject);
                }
                const ch = [];
                res.on("data", d => ch.push(d));
                res.on("end", () => {
                    const body = _decodeBinaryResponse(res, Buffer.concat(ch));
                    if (res.statusCode >= 400) {
                        const msg = body.toString('utf8');
                        const e = new Error(`HTTP ${res.statusCode}: ${msg.slice(0,300)}`);
                        e.statusCode = res.statusCode;
                        return reject(e);
                    }
                    return resolve(body);
                });
            }
        );
        req.on("error", reject);
        req.end();
    });
}

async function _getAccountId(session) {
    if (session._accountId) return session._accountId;
    try {
        const ti = await _restGet("/api/v1/users/tier_info", session.accessToken, session.apiHost);
        if (ti?.account_id) { session._accountId = ti.account_id; return ti.account_id; }
    } catch {}
    const nets = await _restGet("/networks", session.accessToken, session.apiHost);
    const id   = nets?.networks?.[0]?.account_id || nets?.account_id;
    if (id) { session._accountId = id; return id; }
    throw new Error("Konnte account_id nicht ermitteln");
}

function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
}

function deepFindByKeys(obj, keys) {
    const wanted = new Set((keys || []).map(k => String(k).toLowerCase()));
    const seen = new Set();

    function visit(node) {
        if (!node || typeof node !== "object") return null;
        if (seen.has(node)) return null;
        seen.add(node);

        if (Array.isArray(node)) {
            for (const item of node) {
                const hit = visit(item);
                if (hit !== null && hit !== undefined && hit !== "") return hit;
            }
            return null;
        }

        for (const [k, v] of Object.entries(node)) {
            if (wanted.has(String(k).toLowerCase()) && v !== undefined && v !== null && v !== "") {
                return v;
            }
        }

        for (const v of Object.values(node)) {
            const hit = visit(v);
            if (hit !== null && hit !== undefined && hit !== "") return hit;
        }
        return null;
    }

    return visit(obj);
}

function _cameraConfigPath(accountId, apiType, networkId, cameraId) {
    if (!networkId || !cameraId) return null;
    switch (apiType) {
    case "owl":
        return `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/config`;
    case "doorbell":
        return `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/config`;
    default:
        return `/network/${networkId}/camera/${cameraId}/config`;
    }
}

async function _getCameraConfigCached(session, accountId, apiType, networkId, cameraId) {
    const path = _cameraConfigPath(accountId, apiType, networkId, cameraId);
    if (!path) return null;
    const now = Date.now();
    const key = `${apiType}:${networkId}:${cameraId}`;
    if (!session._cameraConfigCache) session._cameraConfigCache = new Map();
    const cached = session._cameraConfigCache.get(key);
    if (cached && (now - cached.ts) < 6 * 60 * 60 * 1000) {
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
    if (!networkId || !cameraId) return [];
    const generic = `/network/${networkId}/camera/${cameraId}/signals`;
    switch (String(apiType || "camera").toLowerCase()) {
    case "doorbell":
        return [
            `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/signals`,
            `/api/v1/accounts/${accountId}/networks/${networkId}/doorbell/${cameraId}/signals`,
            generic
        ];
    case "owl":
    case "mini":
        return [
            `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/signals`,
            `/api/v1/accounts/${accountId}/networks/${networkId}/owl/${cameraId}/signals`,
            generic
        ];
    default:
        return [generic];
    }
}

async function _getCameraSignalsCached(session, accountId, apiType, networkId, cameraId) {
    const paths = _cameraSignalsPaths(accountId, apiType, networkId, cameraId);
    if (!paths.length) return null;
    const now = Date.now();
    const key = `${apiType}:${networkId}:${cameraId}`;
    if (!session._cameraSignalsCache) session._cameraSignalsCache = new Map();
    const cached = session._cameraSignalsCache.get(key);
    if (cached && (now - cached.ts) < 15 * 60 * 1000) {
        return cached.data;
    }
    for (const path of paths) {
        try {
            const data = await _restGet(path, session.accessToken, session.apiHost);
            const hasUsefulData = !!(data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0);
            if (!hasUsefulData) {
                dbg(`signals fallback apiType=${apiType} path=${path} leer`);
                continue;
            }
            session._cameraSignalsCache.set(key, { ts: now, data });
            return data;
        } catch (e) {
            dbg(`signals fallback apiType=${apiType} path=${path} fehlgeschlagen: ${e.message}`);
        }
    }
    session._cameraSignalsCache.set(key, { ts: now, data: null });
    return null;
}

async function getDevices(session) {
    const accountId = await _getAccountId(session);
    const hs = await _restGet(`/api/v3/accounts/${accountId}/homescreen`,
        session.accessToken, session.apiHost);
    const cameras = [], syncModules = [];

    const syncList = Array.isArray(hs?.sync_modules) ? hs.sync_modules : [];
    const syncByNetworkId = new Map();
    const syncById = new Map();
    for (const item of syncList) {
        const rawSync = item?.sync_module || item || {};
        const networkId = firstDefined(rawSync?.network_id, item?.network_id, rawSync?.network, item?.network);
        const syncId = firstDefined(rawSync?.id, rawSync?.sync_module_id, item?.id, item?.sync_module_id);
        if (networkId != null) syncByNetworkId.set(String(networkId), rawSync);
        if (syncId != null) syncById.set(String(syncId), rawSync);
    }

    for (const net of (hs?.networks || [])) {
        const rawNet = net?.network || net || {};
        const netId = firstDefined(rawNet?.network_id, rawNet?.id, net?.network_id, net?.id);
        const linkedSync = firstDefined(
            net?.sync_module,
            rawNet?.sync_module,
            net?.sync_module_info,
            rawNet?.sync_module_info,
            net?.syncModule,
            rawNet?.syncModule,
            netId != null ? syncByNetworkId.get(String(netId)) : undefined,
            rawNet?.sync_module_id != null ? syncById.get(String(rawNet.sync_module_id)) : undefined,
            net?.sync_module_id != null ? syncById.get(String(net.sync_module_id)) : undefined
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
            deepFindByKeys(syncObj, ["serial", "serial_number", "device_serial", "sync_serial", "sync_module_serial", "unit_serial", "module_serial"])
        );
        if (syncSerial == null) {
            dbg(`SYNC SERIAL fehlt fuer network ${netId}; keys(rawNet)=[${Object.keys(rawNet).join(",")}] keys(syncObj)=[${Object.keys(syncObj || {}).join(",")}] topLevelSyncs=${syncList.length}`);
        }
        syncModules.push({
            id: netId,
            name: firstDefined(rawNet?.name, linkedSync?.name, net?.sync_module?.name, String(netId)),
            serial: syncSerial != null ? String(syncSerial) : null,
            armed: firstDefined(rawNet?.armed, linkedSync?.armed, net?.armed) != null ? Boolean(firstDefined(rawNet?.armed, linkedSync?.armed, net?.armed)) : null,
            network_id: netId,
            updated: new Date().toISOString()
        });
    }

    const allCams = [
        ...(hs?.cameras || []).map(cam => ({ cam, apiType: "camera" })),
        ...(hs?.owls || []).map(cam => ({ cam, apiType: "owl" })),
        ...(hs?.doorbells || []).map(cam => ({ cam, apiType: "doorbell" }))
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
            signals?.battery_voltage
        );
        let batteryLevelRaw = firstDefined(
            signals?.battery,
            status?.battery_level,
            dev?.battery_level,
            cam?.battery_level
        );

        let cfg = null;
        if ((batteryVoltageRaw == null || batteryLevelRaw == null) && camId != null && netId != null) {
            cfg = await _getCameraConfigCached(session, accountId, entry.apiType, netId, camId);
            const cfgEntity = firstDefined(
                cfg?.camera?.[0], cfg?.camera,
                cfg?.doorbell?.[0], cfg?.doorbell,
                cfg?.owl?.[0], cfg?.owl,
                cfg?.mini?.[0], cfg?.mini,
                cfg?.device?.[0], cfg?.device,
                cfg
            ) || {};
            const cfgSignals = firstDefined(cfgEntity?.signals, cfg?.signals) || {};
            batteryVoltageRaw = firstDefined(
                batteryVoltageRaw,
                cfg?.battery_voltage,
                cfg?.battery_volt,
                cfgEntity?.battery_voltage,
                cfgEntity?.battery_volt,
                cfgSignals?.battery_voltage,
                deepFindByKeys(cfg, ["battery_voltage", "battery_volt"])
            );
            batteryLevelRaw = firstDefined(
                batteryLevelRaw,
                cfgSignals?.battery,
                cfg?.battery_level,
                cfgEntity?.battery_level,
                deepFindByKeys(cfg, ["battery_level", "battery"])
            );
        }

        const battVolt = batteryVoltageRaw != null
            ? batteryToVolt(batteryVoltageRaw)
            : null;
        const battRaw = batteryVoltageRaw != null && Number.isFinite(Number(batteryVoltageRaw))
            ? Number(batteryVoltageRaw)
            : (batteryLevelRaw != null && Number.isFinite(Number(batteryLevelRaw)) ? Number(batteryLevelRaw) : null);

        let tempF = firstDefined(
            signals?.temp,
            status?.temperature,
            dev?.temperature,
            cam?.temperature,
            deepFindByKeys(cam, ["temp", "temperature", "temp_f", "temperature_f"])
        );
        let tempC = firstDefined(
            signals?.temp_c,
            signals?.temperature_c,
            status?.temperature_c,
            dev?.temperature_c,
            cam?.temperature_c,
            deepFindByKeys(cam, ["temp_c", "temperature_c", "temp_celsius", "temperature_celsius", "celsius"])
        );
        if ((tempF == null && tempC == null) && camId != null && netId != null) {
            cfg = cfg || await _getCameraConfigCached(session, accountId, entry.apiType, netId, camId);
            const cfgEntity = firstDefined(
                cfg?.camera?.[0], cfg?.camera,
                cfg?.doorbell?.[0], cfg?.doorbell,
                cfg?.owl?.[0], cfg?.owl,
                cfg?.mini?.[0], cfg?.mini,
                cfg?.device?.[0], cfg?.device,
                cfg
            ) || {};
            const cfgSignals = firstDefined(cfgEntity?.signals, cfg?.signals) || {};
            tempF = firstDefined(
                tempF,
                cfgSignals?.temp,
                cfgEntity?.temperature,
                cfg?.temperature,
                deepFindByKeys(cfg, ["temp", "temperature", "temp_f", "temperature_f"])
            );
            tempC = firstDefined(
                tempC,
                cfgSignals?.temp_c,
                cfgSignals?.temperature_c,
                cfgEntity?.temperature_c,
                cfg?.temperature_c,
                deepFindByKeys(cfg, ["temp_c", "temperature_c", "temp_celsius", "temperature_celsius", "celsius"])
            );
        }
        if ((tempF == null && tempC == null) && camId != null && netId != null) {
            const sig = await _getCameraSignalsCached(session, accountId, entry.apiType, netId, camId);
            tempF = firstDefined(
                tempF,
                sig?.temp,
                sig?.temperature,
                deepFindByKeys(sig, ["temp", "temperature", "temp_f", "temperature_f"])
            );
            tempC = firstDefined(
                tempC,
                sig?.temp_c,
                sig?.temperature_c,
                deepFindByKeys(sig, ["temp_c", "temperature_c", "temp_celsius", "temperature_celsius", "celsius"])
            );
            if (entry.apiType === "doorbell") {
                dbg(`DOORBELL TEMP signals id=${camId} net=${netId} keys=[${Object.keys(sig || {}).join(",")}] temp=${sig?.temp} temp_c=${sig?.temp_c}`);
            }
        }
        let tempFNum = tempF != null && Number.isFinite(Number(tempF)) ? Number(tempF) : null;
        if (tempFNum == null && tempC != null && Number.isFinite(Number(tempC))) {
            tempFNum = Math.round((Number(tempC) * 9 / 5 + 32) * 10) / 10;
        }

        if (entry.apiType === "doorbell" && (battRaw == null || tempFNum == null)) {
            dbg(`DOORBELL SENSOR fallback: id=${camId} net=${netId} battRaw=${battRaw} tempF=${tempFNum}`);
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
            temperature: tempFNum != null ? Math.round(((tempFNum-32)*5/9)*10)/10 : null,
            temperature_f: tempFNum,
            wifi_strength: firstDefined(status?.wifi_strength, dev?.wifi_strength, cam?.wifi_strength),
            motion_detect_enabled: firstDefined(status?.motion_alert, status?.enabled, dev?.enabled, cam?.enabled),
            armed: sync ? sync.armed : null,
            thumbnail: firstDefined(status?.thumbnail, dev?.thumbnail, cam?.thumbnail),
            updated: new Date().toISOString()
        });
    }
    return { cameras, syncModules };
}

async function snapshot(session, networkId, cameraId, thumbnailUrl, outFile, apiType = "camera") {
    const kind = String(apiType || "camera").toLowerCase();
    const accountId = await _getAccountId(session);
    const candidates = kind === "doorbell"
        ? [
            `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/thumbnail`,
            `/api/v1/accounts/${accountId}/networks/${networkId}/doorbell/${cameraId}/thumbnail`,
            `/network/${networkId}/doorbells/${cameraId}/thumbnail`,
            `/network/${networkId}/doorbell/${cameraId}/thumbnail`,
            `/network/${networkId}/camera/${cameraId}/thumbnail`
        ]
        : (kind === "owl" || kind === "mini")
            ? [
                `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/thumbnail`,
                `/api/v1/accounts/${accountId}/networks/${networkId}/owl/${cameraId}/thumbnail`,
                `/network/${networkId}/owls/${cameraId}/thumbnail`,
                `/network/${networkId}/owl/${cameraId}/thumbnail`,
                `/network/${networkId}/camera/${cameraId}/thumbnail`
            ]
            : [
                `/network/${networkId}/camera/${cameraId}/thumbnail`,
                `/network/${networkId}/cameras/${cameraId}/thumbnail`,
                `/api/v1/accounts/${accountId}/networks/${networkId}/cameras/${cameraId}/thumbnail`
            ];

    let lastErr;
    let lastBusyErr;
    for (const waitMs of [0, 6000, 12000]) {
        if (waitMs) await _sleep(waitMs);
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
                dbg(`snapshot Fallback: apiType=${kind} path=${p} fehlgeschlagen: ${e.message}`);
            }
        }
        if (!lastErr) break;
        if (!lastBusyErr || waitMs === 12000) throw lastErr;
    }
    if (lastErr) throw lastErr;

    await _sleep(2000);
    try {
        const hs = await _restGet(`/api/v3/accounts/${accountId}/homescreen`,
            session.accessToken, session.apiHost);
        const found = [...(hs?.cameras||[]),...(hs?.owls||[]),...(hs?.doorbells||[])]
            .find(c => String((c.device||c).id) === String(cameraId));
        if (found) {
            const u = (found.camera_status||found.status||{}).thumbnail
                   || (found.device||found).thumbnail;
            if (u) thumbnailUrl = u;
        }
    } catch {}
    const url = /\.(jpg|jpeg)$/i.test(thumbnailUrl) ? thumbnailUrl : thumbnailUrl + ".jpg";
    const fullUrl = url.startsWith("http") ? url : `https://${session.apiHost}${url}`;
    const data = await _downloadBinary(fullUrl, session.accessToken);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, data);
    return outFile;
}

async function setMotion(session, networkId, cameraId, enable, apiType = "camera") {
    const action = enable ? "enable" : "disable";
    const enabled = !!enable;
    const kind = String(apiType || "camera").toLowerCase();
    const accountId = await _getAccountId(session);

    const cameraCandidates = [
        { path: `/network/${networkId}/camera/${cameraId}/${action}` },
        { path: `/network/${networkId}/cameras/${cameraId}/${action}` },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/cameras/${cameraId}/${action}` },
        { path: `/network/${networkId}/camera/${cameraId}/update`, body: { enabled } },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/cameras/${cameraId}/config`, body: { enabled } }
    ];
    const doorbellCandidates = [
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/${action}` },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbell/${cameraId}/${action}` },
        { path: `/network/${networkId}/doorbell/${cameraId}/${action}` },
        { path: `/network/${networkId}/doorbells/${cameraId}/${action}` },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/config`, body: { enabled } },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbell/${cameraId}/config`, body: { enabled } },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/doorbells/${cameraId}/update`, body: { enabled } }
    ];
    const owlCandidates = [
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/${action}` },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/owl/${cameraId}/${action}` },
        { path: `/network/${networkId}/owl/${cameraId}/${action}` },
        { path: `/network/${networkId}/owls/${cameraId}/${action}` },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/config`, body: { enabled } },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/owl/${cameraId}/config`, body: { enabled } },
        { path: `/api/v1/accounts/${accountId}/networks/${networkId}/owls/${cameraId}/update`, body: { enabled } }
    ];

    const ordered = kind === "doorbell"
        ? [...doorbellCandidates, ...owlCandidates, ...cameraCandidates]
        : kind === "owl"
            ? [...owlCandidates, ...doorbellCandidates, ...cameraCandidates]
            : [...cameraCandidates, ...doorbellCandidates, ...owlCandidates];

    const seen = new Set();
    const candidates = ordered.filter(c => {
        const key = `${c.path}::${c.body ? JSON.stringify(c.body) : ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    let lastErr;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        try {
            dbg(`setMotion TRY apiType=${kind} path=${c.path}${c.body ? ` body=${JSON.stringify(c.body)}` : ""}`);
            return await _restPost(c.path, session.accessToken, session.apiHost, c.body);
        } catch (e) {
            lastErr = e;
            const msg = String(e?.message || e || "");
            const retryable404 = e?.statusCode === 404 || /not found/i.test(msg) || /camera not found/i.test(msg);
            if (!retryable404 || i === candidates.length - 1) throw e;
            dbg(`setMotion Fallback: apiType=${kind} path=${c.path}${c.body ? ` body=${JSON.stringify(c.body)}` : ""} fehlgeschlagen: ${msg}`);
        }
    }
    throw lastErr;
}


async function setArmed(session, networkId, armed) {
    const accountId = await _getAccountId(session);
    return _restPost(
        `/api/v1/accounts/${accountId}/networks/${networkId}/state/${armed?"arm":"disarm"}`,
        session.accessToken, session.apiHost
    );
}


function _summarizeVideoEntry(v) {
    if (!v || typeof v !== "object") return String(v);
    const pick = {};
    for (const k of ["id", "video_id", "created_at", "camera_id", "device_id", "network_id", "media", "clip", "address", "url", "deleted"]) {
        if (v[k] !== undefined) pick[k] = v[k];
    }
    return JSON.stringify(pick);
}

function _findCandidateVideos(list, cameraId, networkId) {
    const arr = Array.isArray(list) ? list.filter(v => !v?.deleted) : [];
    if (!arr.length) return [];
    const camId = String(cameraId);
    const netId = networkId == null ? null : String(networkId);

    const direct = arr.filter(v => String(firstDefined(v?.camera_id, v?.camera, v?.device_id, v?.device, v?.cameraId, v?.deviceId)) === camId);
    if (direct.length) return direct;

    if (netId != null) {
        const sameNetwork = arr.filter(v => String(firstDefined(v?.network_id, v?.network, v?.networkId)) === netId);
        if (sameNetwork.length === 1) return sameNetwork;
        const sameNetworkWithUrl = sameNetwork.filter(v => v?.media || v?.clip || v?.address || v?.url);
        if (sameNetworkWithUrl.length === 1) return sameNetworkWithUrl;
    }

    const withUrl = arr.filter(v => v?.media || v?.clip || v?.address || v?.url);
    if (withUrl.length === 1) return withUrl;

    return [];
}

async function getLatestVideoInfo(session, networkId, cameraId) {
    const accountId = await _getAccountId(session);
    let cameraScopedCount = 0;
    let mediaChangedCount = 0;

    try {
        const res = await _restGet(
            `/api/v1/accounts/${accountId}/networks/${networkId}/cameras/${cameraId}/videos`,
            session.accessToken, session.apiHost
        );
        const allVideos = (res?.videos || (Array.isArray(res) ? res : []))
            .filter(v => !v?.deleted);
        cameraScopedCount = allVideos.length;
        const matches = _findCandidateVideos(allVideos, cameraId, networkId);
        dbg(`VIDEO DEBUG camera=${cameraId} network=${networkId} endpoint=camera/videos total=${allVideos.length} matches=${matches.length}`);
        if (allVideos.length) dbg(`VIDEO DEBUG camera/videos sample=${allVideos.slice(0, 3).map(_summarizeVideoEntry).join(' | ')}`);
        const source = matches.length ? matches : allVideos;
        if (source.length) {
            source.sort((a, b) => new Date(b.created_at||0) - new Date(a.created_at||0));
            const hit = source.find(v => v?.media || v?.clip || v?.address || v?.url) || source[0];
            if (hit) return hit;
        }
    } catch (e) {
        dbg(`VIDEO DEBUG camera=${cameraId} network=${networkId} endpoint=camera/videos error=${e?.message || e}`);
    }

    const since = encodeURIComponent('2015-04-19T23:11:20+0000');
    for (let page = 1; page <= 3; page++) {
        try {
            const res = await _restGet(
                `/api/v1/accounts/${accountId}/media/changed?since=${since}&page=${page}`,
                session.accessToken, session.apiHost
            );
            const media = (res?.media || []).filter(v => !v?.deleted);
            mediaChangedCount += media.length;
            const matches = _findCandidateVideos(media, cameraId, networkId);
            dbg(`VIDEO DEBUG camera=${cameraId} network=${networkId} endpoint=media/changed page=${page} total=${media.length} matches=${matches.length}`);
            if (media.length) dbg(`VIDEO DEBUG media/changed sample=${media.slice(0, 3).map(_summarizeVideoEntry).join(' | ')}`);
            if (matches.length) {
                matches.sort((a, b) => new Date(b.created_at||0) - new Date(a.created_at||0));
                const hit = matches.find(v => v?.media || v?.clip || v?.address || v?.url) || matches[0];
                if (hit) return hit;
            }
            if (!media.length) break;
        } catch (e) {
            dbg(`VIDEO DEBUG camera=${cameraId} network=${networkId} endpoint=media/changed page=${page} error=${e?.message || e}`);
        }
    }

    const err = new Error(`Kein Video vorhanden (camera/videos=${cameraScopedCount}, media/changed=${mediaChangedCount})`);
    err.code = 'NO_VIDEO';
    throw err;
}

function normalizeMediaUrl(videoUrl, apiHost) {
    if (!videoUrl) return null;
    const raw = String(videoUrl).trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://${apiHost}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

async function downloadVideo(session, networkId, cameraId, outFile, latestVideo = null) {
    const latest = latestVideo || await getLatestVideoInfo(session, networkId, cameraId);

    let videoUrl = latest?.media || latest?.clip || latest?.address || latest?.url;
    if (!videoUrl) throw new Error("Keine Video-URL");

    let fullUrl = normalizeMediaUrl(videoUrl, session.apiHost);
    let data;
    let lastErr = null;

    const tryUrls = [fullUrl];
    const fallbackUrl = latest?.address || latest?.url || latest?.media || latest?.clip;
    const altUrl = normalizeMediaUrl(fallbackUrl, session.apiHost);
    if (altUrl && !tryUrls.includes(altUrl)) tryUrls.push(altUrl);

    for (const url of tryUrls) {
        try {
            data = await _downloadBinary(url, session.accessToken);
            fullUrl = url;
            break;
        } catch (e) {
            lastErr = e;
        }
    }

    if (!data) throw lastErr || new Error("Video-Download fehlgeschlagen");

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

function batteryToVolt(raw) {
    if (raw == null) return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    return Math.abs(v) >= 10 ? Math.round((v/100)*100)/100 : Math.round(v*100)/100;
}
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
    getSession, login, clearSession,
    getDevices, snapshot, setMotion, setArmed, getLatestVideoInfo, downloadVideo, batteryToVolt,
    DEBUG_LOG
};
