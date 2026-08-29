'use strict';

/**
 * API Key 鉴权。
 * 三种传递方式都可以，方便不同调用方：
 *   X-API-Key: <key>
 *   Authorization: Bearer <key>
 *   ?api_key=<key>          （浏览器直接访问时用，不推荐生产使用）
 *
 * 健康检查与文档页不鉴权。
 */

const config = require('./config');

function extractKey(req) {
  const h = req.header('X-API-Key');
  if (h) return h.trim();

  const auth = req.header('Authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();

  if (req.query && typeof req.query.api_key === 'string') return req.query.api_key.trim();

  return null;
}

function middleware(req, res, next) {
  if (!config.requireAuth) {
    req.caller = 'anonymous';
    return next();
  }

  const key = extractKey(req);
  if (!key) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      message: '缺少 API Key，请在 X-API-Key 请求头中提供',
    });
  }

  const name = config.apiKeys.get(key);
  if (!name) {
    return res.status(403).json({
      ok: false,
      code: 'FORBIDDEN',
      message: 'API Key 无效',
    });
  }

  req.caller = name;
  return next();
}

module.exports = { middleware, extractKey };
