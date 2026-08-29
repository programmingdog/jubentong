'use strict';

/**
 * 下载链接签名。
 *
 * 代理端点 /dl 需要把真实地址放在查询串里，如果不签名，任何人都能拿我们的
 * 服务器当任意 URL 的代理（即便有域名白名单，仍然可能被滥用）。
 * 这里用 HMAC-SHA256 给地址+有效期+文件名签名，做到「无状态且不可篡改」。
 */

const crypto = require('crypto');

function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * 为下载地址生成签名
 * @param {string} secret
 * @param {{url:string, exp:number, name:string}} data
 */
function sign(secret, { url, exp, name }) {
  return hmac(secret, `${url}|${exp}|${name}`);
}

/**
 * 校验签名，同时检查是否已过期。
 * 用 timingSafeEqual 避免时序侧信道。
 */
function verify(secret, { url, exp, name, sig }) {
  if (!url || !exp || !sig) return { ok: false, reason: 'MISSING' };

  if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now() / 1000) {
    return { ok: false, reason: 'EXPIRED' };
  }

  const expect = sign(secret, { url, exp, name: name || '' });
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expect);
  if (a.length !== b.length) return { ok: false, reason: 'BAD_SIGNATURE' };

  return crypto.timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: 'BAD_SIGNATURE' };
}

module.exports = { sign, verify, hmac };
