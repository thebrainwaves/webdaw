// Local security helpers (WebCrypto). Honest scope:
// - PIN lock: a casual lock screen. The PIN is stored as a salted PBKDF2-SHA256 hash in localStorage.
//   It does NOT encrypt projects in browser storage; anyone with device/devtools access can read them.
// - Encrypted export: AES-256-GCM with a key derived from a password via PBKDF2-SHA256 (310k iterations).
const enc = new TextEncoder();
const PIN_KEY = 'webdaw.pin';
export const cryptoAvailable = () => !!(globalThis.crypto && crypto.subtle && crypto.getRandomValues);
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2Bits(secret, salt, iterations, bits = 256) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, bits));
}
export function pinIsSet() { try { return !!JSON.parse(localStorage.getItem(PIN_KEY) || 'null'); } catch (e) { return false; } }
export async function setPin(pin) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN must be 4–8 digits.');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iterations = 200000;
  const hash = await pbkdf2Bits(pin, salt, iterations);
  localStorage.setItem(PIN_KEY, JSON.stringify({ v: 1, salt: toB64(salt), iterations, hash: toB64(hash) }));
}
export function clearPin() { localStorage.removeItem(PIN_KEY); }
export async function verifyPin(pin) {
  const rec = JSON.parse(localStorage.getItem(PIN_KEY) || 'null'); if (!rec) return true;
  const hash = await pbkdf2Bits(String(pin), fromB64(rec.salt), rec.iterations);
  const ref = fromB64(rec.hash); if (ref.length !== hash.length) return false;
  let diff = 0; for (let i = 0; i < ref.length; i++) diff |= ref[i] ^ hash[i];
  return diff === 0;
}

// Encrypted container: "WDAWENC1" | salt(16) | iv(12) | AES-GCM ciphertext (+tag)
const MAGIC = enc.encode('WDAWENC1');
export const ENC_ITER = 310000;
export function isEncrypted(bytes) { return bytes.length > 36 && MAGIC.every((b, i) => bytes[i] === b); }
async function aesKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ENC_ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptBytes(bytes, password) {
  if (!password || password.length < 6) throw new Error('Use a password of at least 6 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(password, salt), bytes));
  const out = new Uint8Array(MAGIC.length + 28 + ct.length);
  out.set(MAGIC, 0); out.set(salt, 8); out.set(iv, 24); out.set(ct, 36);
  return out;
}
export async function decryptBytes(bytes, password) {
  if (!isEncrypted(bytes)) throw new Error('Not an encrypted WebDAW file');
  const salt = bytes.slice(8, 24), iv = bytes.slice(24, 36), ct = bytes.slice(36);
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(password, salt), ct)); }
  catch (e) { throw new Error('Wrong password or damaged file.'); }
}
