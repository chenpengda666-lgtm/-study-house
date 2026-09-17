// Minimal HMAC-signed session tokens. No database, no accounts.
// The token binds an anonymous actor id to a nickname so that uploads and
// messages stay attributable for moderation, while entry stays frictionless.

const encoder = new TextEncoder();

function b64urlEncode(bytes) {
  let bin = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(secret, payload) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return b64urlEncode(sig);
}

export const SESSION_DAYS = 30;

export async function issueSession(secret, actorId, nick, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + SESSION_DAYS * 86400;
  const payload = `${actorId}.${b64urlEncode(encoder.encode(nick))}.${exp}`;
  const sig = await sign(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifySession(secret, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [actorId, nickB64, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < nowSec) return null;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(actorId)) return null;
  const expected = await sign(secret, `${actorId}.${nickB64}.${expRaw}`);
  // Constant-time-ish compare; lengths are always equal for valid signatures.
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  let nick = "";
  try {
    nick = new TextDecoder().decode(b64urlDecode(nickB64)).slice(0, 24);
  } catch {
    return null;
  }
  return { actorId, nick };
}

export function randomId(bytes = 12) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

// Cloudflare sets cf-connecting-ip at the edge and it cannot be spoofed by
// the client, so it is the only trustworthy source for rate limit keys.
//
// x-real-ip is deliberately NOT accepted as a fallback. It is client-controlled
// and trivially forged, and a spoofable rate-limit key is worse than a broken
// one: it looks like protection while providing none. If cf-connecting-ip is
// ever absent, all such requests collapse onto "unknown", which fails closed.
export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

export function sanitizeNick(raw) {
  const nick = String(raw ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
  return nick.slice(0, 24) || `路人${Math.floor(Math.random() * 9000 + 1000)}`;
}
