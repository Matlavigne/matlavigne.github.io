// Web Push sans dépendance : signature VAPID (RFC 8292) et chiffrement aes128gcm (RFC 8291 / RFC 8188),
// écrits avec WebCrypto pour tourner tel quel dans un Cloudflare Worker.

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

// HKDF en une seule passe (longueur demandée ≤ 32 octets)
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

/**
 * Chiffre un message pour un abonnement (RFC 8291, encodage aes128gcm).
 * Renvoie le corps binaire complet à poster au service de push.
 */
export async function encryptPayload(p256dhB64, authB64, plaintext, opts = {}) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh invalide");
  if (authSecret.length !== 16) throw new Error("auth invalide");

  const asKeys = opts.asKeyPair || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const body = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;
  const padded = concat(body, new Uint8Array([2])); // délimiteur du dernier (et seul) enregistrement
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // taille d'enregistrement 4096
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

let cachedSigningKey = null;
let cachedJwkText = null;

async function signingKey(privateJwkText) {
  if (cachedSigningKey && cachedJwkText === privateJwkText) return cachedSigningKey;
  const jwk = JSON.parse(privateJwkText);
  cachedSigningKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  cachedJwkText = privateJwkText;
  return cachedSigningKey;
}

/** En-tête Authorization VAPID pour un endpoint donné. */
export async function vapidAuthorization(endpoint, { publicKey, privateJwk, subject }) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp, sub: subject })));
  const unsigned = `${head}.${claims}`;
  const key = await signingKey(privateJwk);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${publicKey}`;
}

/**
 * Envoie une notification à un abonnement. Ne lève pas d'exception :
 * renvoie { status } (0 = erreur réseau).
 */
export async function sendPush(sub, message, vapid, { ttl = 43200, urgency = "normal", topic } = {}) {
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(message));
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: await vapidAuthorization(sub.endpoint, vapid),
    };
    if (topic) headers.Topic = topic;
    const res = await fetch(sub.endpoint, { method: "POST", headers, body });
    return { status: res.status };
  } catch (err) {
    return { status: 0, error: String(err && err.message || err) };
  }
}
