// 密码哈希：PBKDF2-SHA256（WebCrypto）。新哈希 100000 次（Workers 上限，不可再高），
// 自描述格式 pbkdf2_sha256$100000$<hex>；盐仍在 salt 列。旧行是纯 hex、20000 次，登录成功后升级。
const ITER = 100000;
const LEGACY_ITER = 20000;
const enc = new TextEncoder();

export const LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_USER_FAIL_MAX = 5;
export const LOGIN_IP_FAIL_MAX = 20;

// 不存在的用户也走一次同等成本的 PBKDF2，避免用耗时区分用户名
export const DUMMY_LOGIN = {
  salt: '0123456789abcdef0123456789abcdef',
  hash: 'pbkdf2_sha256$100000$' + 'ab'.repeat(32),
};

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  const s = String(hex || '');
  if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function timingSafeEqualStr(a, b) {
  const aa = String(a);
  const bb = String(b);
  const n = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < n; i++) {
    const ca = i < aa.length ? aa.charCodeAt(i) : 0;
    const cb = i < bb.length ? bb.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export function parseHash(stored) {
  const s = String(stored || '');
  const m = /^pbkdf2_sha256\$(\d+)\$([0-9a-fA-F]+)$/.exec(s);
  if (m) return { iterations: Number(m[1]), hex: m[2].toLowerCase(), legacy: false };
  if (/^[0-9a-fA-F]{64}$/.test(s)) return { iterations: LEGACY_ITER, hex: s.toLowerCase(), legacy: true };
  return null;
}

export function needsRehash(stored) {
  const p = parseHash(stored);
  if (!p) return true;
  return p.legacy || p.iterations !== ITER;
}

async function pbkdf2Hex(password, saltHex, iterations) {
  const rounds = Math.min(ITER, iterations | 0);
  if (rounds < 1) throw new Error('bad iterations');
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: rounds }, key, 256);
  return toHex(bits);
}

export async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const saltOut = saltHex || toHex(salt);
  const hex = await pbkdf2Hex(password, saltOut, ITER);
  return { hash: `pbkdf2_sha256$${ITER}$${hex}`, salt: saltOut };
}

export async function verifyPassword(password, hash, saltHex) {
  const parsed = parseHash(hash);
  if (!parsed || !saltHex) return false;
  // 超过 Workers 上限的迭代次数直接拒绝，绝不向 WebCrypto 传入更大的值
  if (parsed.iterations > ITER || parsed.iterations < 1) return false;
  let hex = '';
  try { hex = await pbkdf2Hex(password, saltHex, parsed.iterations); } catch { return false; }
  return timingSafeEqualStr(hex, parsed.hex);
}

export function newToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(24)));
}

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_\u4e00-\u9fa5]{3,20}$/.test(username)) return '用户名需为 3-20 位字母、数字、下划线或中文';
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) return '密码长度需为 6-64 位';
  return null;
}

/**
 * 登录锁定判定（纯函数）。窗口内用户名失败 ≥5 或 IP 失败 ≥20 即锁定；窗口过期则不再锁。
 * 调用方在校验密码之前用「已经记下的次数」判断，因此正确密码也无法绕过未过期的锁。
 */
export function loginLockDecision({ userFails = 0, userFirstAt = 0, ipFails = 0, ipFirstAt = 0, now = Date.now(), windowMs = LOGIN_LOCK_WINDOW_MS } = {}) {
  const fresh = (count, firstAt, max) => count >= max && firstAt > 0 && (now - firstAt) < windowMs;
  const userLocked = fresh(userFails, userFirstAt, LOGIN_USER_FAIL_MAX);
  const ipLocked = fresh(ipFails, ipFirstAt, LOGIN_IP_FAIL_MAX);
  if (userLocked && ipLocked) return { locked: true, by: 'both' };
  if (userLocked) return { locked: true, by: 'user' };
  if (ipLocked) return { locked: true, by: 'ip' };
  return { locked: false, by: null };
}
