import crypto from 'node:crypto';

// Pure validation helpers copied from the companion adapter's validation.js so this
// package stays independent; behaviour is pinned by shared regression tests.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STORE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
export function text(value, label, max = 8000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 必须是 1–${max} 字符的文本`);
  return value.trim();
}
export function uuid(value) { if (!UUID.test(value ?? '')) throw new Error('记忆 ID 必须是完整 UUID'); return value.toLowerCase(); }
export function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function noSecret(value) {
  const key = process.env.DEEPSEEK_API_KEY;
  if ((key && value.includes(key)) || /\bsk-[a-zA-Z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[a-zA-Z0-9_.-]{24,}/.test(value)) throw new Error('疑似密钥或凭据，拒绝复制到记录');
}
export function aborted(signal) { signal?.throwIfAborted(); }
