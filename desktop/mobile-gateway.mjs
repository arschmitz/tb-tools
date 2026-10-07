import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_BODY = 10 * 1024 * 1024;
const SESSION_AGE = 90 * 24 * 60 * 60 * 1000;
const mobileHead = `<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="theme-color" content="#173f70">
<meta name="apple-mobile-web-app-capable" content="yes">`;

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function equal(first, second) {
  const a = Buffer.from(String(first));
  const b = Buffer.from(String(second));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function bodyText(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request is too large."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, data, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(data));
}

const pairPage = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pair Commands</title>
<style>body{font:1rem system-ui;margin:0;padding:2rem;max-width:30rem}input,button{font:inherit;padding:.8rem;width:100%;box-sizing:border-box;margin:.5rem 0}button{background:#1f5f9f;color:white;border:0;border-radius:.4rem}p{line-height:1.5}</style></head>
<body><h1>Pair Commands</h1><p>Open Pair phone in the desktop app, then enter its one-time code.</p><form><label>Pairing code<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button>Pair this phone</button></form><p role="alert" id="error"></p>
<script>document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const code=new FormData(event.target).get('code');const response=await fetch('/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});const result=await response.json();if(response.ok)location.replace('/');else document.querySelector('#error').textContent=result.error||'Pairing failed.'})</script></body></html>`;

export function createMobileGateway({
  targetUrl, desktopToken, html,
  host = "127.0.0.1", port = 0,
  stateFile = path.join(os.homedir(), ".tb-tools", "mobile-sessions.json"),
  secureCookie = true,
  now = () => Date.now(),
} = {}) {
  if (!targetUrl || !desktopToken || !html) throw new Error("Mobile gateway needs the desktop console.");
  let sessions = {};
  let pairing = null;
  let attempts = 0;
  let server;

  async function save() {
    await mkdir(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(sessions)}\n`, { mode: 0o600 });
    await rename(temporary, stateFile);
  }

  function sessionFor(request) {
    const cookie = /(?:^|;\s*)commands_session=([^;]+)/.exec(request.headers.cookie || "")?.[1];
    const session = cookie && sessions[hash(cookie)];
    return session?.expires > now() ? session : null;
  }

  function checkOrigin(request) {
    const origin = request.headers.origin;
    const hostName = request.headers["x-forwarded-host"] || request.headers.host;
    let valid = false;
    try {
      const parsed = new URL(origin);
      valid = parsed.host === hostName && parsed.origin === origin &&
        (!secureCookie || parsed.protocol === "https:");
    } catch { /* No valid browser Origin. */ }
    if (!valid || request.headers["sec-fetch-site"] === "cross-site") {
      throw Object.assign(new Error("The request must come from this console."), { status: 403 });
    }
  }

  async function proxy(request, response, url, session) {
    const target = new URL(url.pathname + url.search, targetUrl);
    const method = request.method;
    let body;
    if (url.pathname.startsWith("/api/")) {
      if (method === "GET") {
        if (url.searchParams.has("token") && !equal(url.searchParams.get("token"), session.token)) {
          throw Object.assign(new Error("Invalid session token."), { status: 403 });
        }
        target.searchParams.set("token", desktopToken);
      } else {
        checkOrigin(request);
        const input = JSON.parse(await bodyText(request));
        if (!equal(input.token, session.token)) {
          throw Object.assign(new Error("Invalid session token."), { status: 403 });
        }
        input.token = desktopToken;
        if (url.pathname === "/api/close") input.clientId = `phone-${session.id}`;
        body = JSON.stringify(input);
      }
    } else if (method !== "GET") {
      throw Object.assign(new Error("Method not allowed."), { status: 405 });
    }
    const upstream = await fetch(target, { method, body,
      headers: body ? { "content-type": "application/json" } : {},
      signal: AbortSignal.timeout(120_000) });
    const headers = { "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      "cache-control": "no-store", "x-content-type-options": "nosniff" };
    response.writeHead(upstream.status, headers);
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  }

  async function handle(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname === "/pair" && request.method === "POST") {
        checkOrigin(request);
        const input = JSON.parse(await bodyText(request));
        attempts++;
        if (!pairing || pairing.expires <= now() || attempts > 10 || !equal(input.code, pairing.code)) {
          throw Object.assign(new Error("The pairing code is invalid or expired."), { status: 403 });
        }
        pairing = null;
        attempts = 0;
        const cookie = randomBytes(32).toString("base64url");
        const id = randomBytes(8).toString("hex");
        sessions[hash(cookie)] = { id, token: randomBytes(32).toString("base64url"),
          created: now(), expires: now() + SESSION_AGE };
        await save();
        json(response, 200, { ok: true }, { "set-cookie":
          `commands_session=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_AGE / 1000}${secureCookie ? "; Secure" : ""}` });
        return;
      }
      const session = sessionFor(request);
      if (!session) {
        if (url.pathname === "/" && request.method === "GET") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(pairPage);
        } else json(response, 401, { ok: false, error: "Pair this phone first." });
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (request.method !== "GET") throw Object.assign(new Error("Method not allowed."), { status: 405 });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-src 'none'" });
        response.end(html.replaceAll(desktopToken, session.token).replace("</head>", `${mobileHead}</head>`));
        return;
      }
      if (url.pathname === "/manifest.webmanifest") {
        response.writeHead(200, { "content-type": "application/manifest+json",
          "cache-control": "no-store" });
        response.end(JSON.stringify({ name: "Thunderbird Commands", short_name: "Commands",
          start_url: "/", display: "standalone", background_color: "#ffffff",
          theme_color: "#173f70", icons: [
            { src: "/icon.png", sizes: "192x192", type: "image/png" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          ] }));
        return;
      }
      if (["/icon.png", "/icon-512.png"].includes(url.pathname)) {
        const file = new URL(url.pathname === "/icon.png" ? "./icon.png" : "./icon-512.png", import.meta.url);
        response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
        response.end(await readFile(file));
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/")) {
        await proxy(request, response, url, session);
        return;
      }
      json(response, 404, { ok: false, error: "Not found." });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      json(response, error.status || 500, { ok: false, error: error.message });
    }
  }

  return {
    async start() {
      try { sessions = JSON.parse(await readFile(stateFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      server = createServer((request, response) => { void handle(request, response); });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return { url: `http://${host}:${server.address().port}/`, server };
    },
    issuePairCode() {
      pairing = { code: String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, "0"),
        expires: now() + 10 * 60_000 };
      attempts = 0;
      return { code: pairing.code, expires: pairing.expires };
    },
    async revokeAll() { sessions = {}; await save(); },
    status() { return { pairedDevices: Object.values(sessions).filter(entry => entry.expires > now()).length }; },
    close() { return new Promise(resolve => server?.close(resolve) || resolve()); },
  };
}
