'use strict';

/**
 * 集中配置。所有可调参数都支持环境变量覆盖，方便部署时不用改代码。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.data');

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

/**
 * 下载链接的 HMAC 密钥。
 * 优先取环境变量；否则持久化到 .data/dl_secret，
 * 这样服务重启后之前签发的链接依然有效。
 */
function loadSecret() {
  const env = process.env.DL_SECRET;
  if (env && env.length >= 8) return env;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, 'dl_secret');
    if (fs.existsSync(file)) {
      const s = fs.readFileSync(file, 'utf-8').trim();
      if (s.length >= 8) return s;
    }
    const gen = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, gen, 'utf-8');
    return gen;
  } catch (_) {
    // 读不了盘就退化成进程内随机：重启后旧链接失效，但不影响主流程
    return crypto.randomBytes(32).toString('hex');
  }
}

/**
 * 解析 API Key。支持两种写法：
 *   API_KEYS=abc123,def456
 *   API_KEYS=partnerA:abc123,partnerB:def456   （带调用方名称，便于日志区分）
 */
function parseKeys(raw) {
  const map = new Map(); // key -> name
  if (!raw) return map;
  for (const part of String(raw).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const idx = p.indexOf(':');
    if (idx > 0) {
      map.set(p.slice(idx + 1).trim(), p.slice(0, idx).trim());
    } else {
      map.set(p, p.slice(0, 8));
    }
  }
  return map;
}

const apiKeys = parseKeys(process.env.API_KEYS);

const config = {
  port: num(process.env.PORT, 5173),

  // 鉴权：配了 API_KEYS 就自动开启，也可用 REQUIRE_AUTH=0 显式关闭
  apiKeys,
  requireAuth: bool(process.env.REQUIRE_AUTH, apiKeys.size > 0),

  // 缓存
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 30 * 60 * 1000),
  cacheMax: num(process.env.CACHE_MAX, 500),

  // 并发：浏览器是稀缺资源，必须限制同时解析的任务数
  maxConcurrency: num(process.env.MAX_CONCURRENCY, 2),
  parseTimeoutMs: num(process.env.PARSE_TIMEOUT_MS, 45000),
  queueTimeoutMs: num(process.env.QUEUE_TIMEOUT_MS, 90000),

  // 签名下载链接
  dlSecret: loadSecret(),
  dlTtlMs: num(process.env.DL_TTL_MS, 6 * 3600 * 1000),

  // 生成绝对地址用。反代场景建议显式配置，否则从请求头推断
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  trustProxy: bool(process.env.TRUST_PROXY, true),

  root: ROOT,
  dataDir: DATA_DIR,
};

module.exports = config;
