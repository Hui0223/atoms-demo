// 密码哈希：PBKDF2-SHA256（WebCrypto 原生实现，不占用 JS CPU）
const ITER = 20000;
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));

export async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt) };
}

export async function verifyPassword(password, hash, saltHex) {
  const { hash: h } = await hashPassword(password, saltHex);
  if (h.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export function newToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(24)));
}

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_\u4e00-\u9fa5]{3,20}$/.test(username)) return '用户名需为 3-20 位字母、数字、下划线或中文';
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) return '密码长度需为 6-64 位';
  return null;
}
