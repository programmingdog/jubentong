'use strict';

/**
 * 抖音分享链接解析服务
 *
 * 对外接口：
 *   GET  /healthz              健康检查（不鉴权）
 *   GET  /                     接口文档与在线调试（不鉴权）
 *   POST /v1/parse             解析分享链接（需 API Key）
 *   GET  /v1/parse?url=...     同上，便捷形式
 *   GET  /dl?url&name&exp&sig  签名下载代理（凭签名，不需要 API Key）
 */

const path = require('path');
const express = require('express');
const { Readable } = require('stream');

const config = require('./config');
const { TtlCache } = require('./cache');
const { TaskQueue } = require('./queue');
const { ParseService } = require('./service');
const { middleware: auth } = require('./auth');
const { verify } = require('./sign');
const { ApiError, wrap } = require('./errors');
const { UA_MOBILE } = require('./link');

const app = express();
const ROOT = path.join(__dirname, '..');

if (config.trustProxy) app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

/* ------------------------------------------------------------------ */
/* 依赖装配                                                            */
/* ------------------------------------------------------------------ */

const cache = new TtlCache({ ttlMs: config.cacheTtlMs, max: config.cacheMax, name: 'parse' });
const queue = new TaskQueue({
  concurrency: config.maxConcurrency,
  timeoutMs: config.queueTimeoutMs,
});
const service = new ParseService({
  cache,
  queue,
  secret: config.dlSecret,
  parseTimeoutMs: config.parseTimeoutMs,
  dlTtlMs: config.dlTtlMs,
  maxConcurrency: config.maxConcurrency,
});

/* ------------------------------------------------------------------ */
/* 地址白名单：下载代理只放行字节系 CDN，避免被当作 SSRF 跳板           */
/* ------------------------------------------------------------------ */

const ALLOWED_HOST_SUFFIX = [
  'douyin.com',
  'iesdouyin.com',
  'douyinvod.com',
  'douyinpic.com',
  'byteimg.com',
  'bytecdn.com',
  'bytescm.com',
  'bytegoofy.com',
  'snssdk.com',
  'amemv.com',
  'zjbyte.com',
  'tiktokv.com',
  'ixigua.com',
  'ixiguavod.com',
  'api.douyin.wa',
];

function isAllowedUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIX.some((s) => host === s || host.endsWith('.' + s));
}

/* ------------------------------------------------------------------ */
/* 接口                                                                */
/* ------------------------------------------------------------------ */

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    service: 'douyin-link-parser',
    ts: Date.now(),
    auth: config.requireAuth ? 'enabled' : 'disabled',
    stats: service.stats(),
  });
});

/** 解析：POST /v1/parse  body: { url | text } */
app.post('/v1/parse', auth, async (req, res, next) => {
  try {
    const input = req.body && (req.body.url || req.body.text);
    if (!input || !String(input).trim()) {
      throw new ApiError('INVALID_REQUEST', '请在 body 中提供 url 字段');
    }
    const result = await service.parse(String(input), {
      base: ParseService.baseUrlFrom(req, config.publicBaseUrl),
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/** 解析：GET /v1/parse?url=... */
app.get('/v1/parse', auth, async (req, res, next) => {
  try {
    const input = req.query.url || req.query.text;
    if (!input || !String(input).trim()) {
      throw new ApiError('INVALID_REQUEST', '请提供 url 查询参数');
    }
    const result = await service.parse(String(input), {
      base: ParseService.baseUrlFrom(req, config.publicBaseUrl),
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/**
 * 下载代理。
 * 不校验 API Key —— 链接本身带 HMAC 签名，签名正确即视为授权。
 * 这样调用方拿到 download_url 后可以直接下载，无需再带凭证。
 */
app.get('/dl', async (req, res, next) => {
  const { url, name, exp, sig, inline } = req.query;

  const check = verify(config.dlSecret, { url, exp, name, sig });
  if (!check.ok) {
    return res.status(check.reason === 'EXPIRED' ? 410 : 403).json({
      ok: false,
      code: check.reason === 'EXPIRED' ? 'LINK_EXPIRED' : 'BAD_SIGNATURE',
      message: check.reason === 'EXPIRED'
        ? '下载链接已过期，请重新调用解析接口获取'
        : '下载链接签名无效，请重新调用解析接口获取',
    });
  }

  if (!isAllowedUrl(url)) {
    return res.status(400).json({ ok: false, code: 'FORBIDDEN_HOST', message: '地址不在允许范围内' });
  }

  let upstream;
  try {
    const headers = {
      'User-Agent': UA_MOBILE,
      Referer: 'https://www.douyin.com/',
      Accept: '*/*',
    };
    // 转发 Range，否则视频无法拖动进度条
    if (req.headers.range) headers.Range = req.headers.range;

    upstream = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, code: 'UPSTREAM_ERROR', message: `上游请求失败：${e.message}` });
  }

  if (!upstream.ok && upstream.status !== 206) {
    return res.status(502).json({ ok: false, code: 'UPSTREAM_ERROR', message: `上游返回 ${upstream.status}` });
  }

  const file = String(name || 'douyin');
  const encoded = encodeURIComponent(file);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
  if (String(inline) !== '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) {
    res.status(206);
    res.setHeader('Content-Range', contentRange);
  }

  if (req.method === 'HEAD') return res.end();

  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
});

/** 服务运行状态（鉴权，便于排查） */
app.get('/v1/stats', auth, (req, res) => {
  res.json({ ok: true, ts: Date.now(), ...service.stats() });
});

/** 手动清除某个视频的缓存（鉴权） */
app.delete('/v1/cache/:id', auth, (req, res) => {
  const removed = cache.delete(`aweme:${req.params.id}`);
  res.json({ ok: true, removed });
});

/* ------------------------------------------------------------------ */
/* 静态文档与兜底                                                      */
/* ------------------------------------------------------------------ */

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.use((req, res) => {
  res.status(404).json({ ok: false, code: 'NOT_FOUND', message: `接口不存在：${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const e = wrap(err);
  if (e.status >= 500) {
    // eslint-disable-next-line no-console
    console.error(`[ERROR] ${req.method} ${req.path} caller=${req.caller || '-'}`, e.message, e.detail || '');
  }
  res.status(e.status).json(e.toJSON());
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log('──────────────────────────────────────────────');
  console.log(' 抖音分享链接解析服务已启动');
  console.log(` 地址     : http://localhost:${config.port}`);
  console.log(` 文档     : http://localhost:${config.port}/`);
  console.log(` 鉴权     : ${config.requireAuth ? `开启（${config.apiKeys.size} 个 Key）` : '关闭'}`);
  console.log(` 缓存     : ${Math.round(config.cacheTtlMs / 60000)} 分钟`);
  console.log(` 并发     : ${config.maxConcurrency}`);
  console.log('──────────────────────────────────────────────');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`\n收到 ${signal}，正在关闭…`);
  server.close(() => {
    cache.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, service, cache, queue };
