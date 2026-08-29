'use strict';

/**
 * 解析服务编排：缓存 -> 短链还原 -> 队列 -> 浏览器解析 -> 生成签名下载链接。
 */

const { extract, resolveShort, parseAwemeId } = require('./link');
const { fetchDetail } = require('./parser');
const { sign } = require('./sign');
const { ApiError } = require('./errors');

function safeName(s) {
  const t = String(s || '')
    // 路径分隔符替换为下划线
    .replace(/[\\/]/g, '_')
    // 其余文件名非法字符直接删除。昵称常带 <> 这类装饰符号，
    // 删掉比替换成下划线干净（<镜心> -> 镜心，而不是 _镜心_）
    .replace(/[:*?"<>|\r\n\t]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[_\s]+|[_\s]+$/g, '')
    .trim()
    .slice(0, 60);
  return t || 'douyin';
}

class ParseService {
  /**
   * @param {object} deps
   * @param {import('./cache').TtlCache} deps.cache
   * @param {import('./queue').TaskQueue} deps.queue
   */
  constructor({ cache, queue, secret, parseTimeoutMs, dlTtlMs, maxConcurrency }) {
    this.cache = cache;
    this.queue = queue;
    this.secret = secret;
    this.parseTimeoutMs = parseTimeoutMs;
    this.dlTtlMs = dlTtlMs;
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * 生成带签名的下载地址。
   * 为什么不直接把原始地址丢给调用方：抖音 CDN 有 Referer 防盗链，
   * 第三方直连常常 403；且签名能防止本服务的下载端点被当作任意 URL 代理滥用。
   *
   * @param {string} rawUrl 抖音原始地址
   * @param {string} name   下载文件名
   * @param {string} base   本服务的对外基址
   * @param {boolean} inline 是否用于在线播放
   */
  buildDownloadUrl(rawUrl, name, base, inline = false) {
    if (!rawUrl) return null;
    const exp = Math.floor((Date.now() + this.dlTtlMs) / 1000);
    const file = safeName(name);
    const sig = sign(this.secret, { url: rawUrl, exp, name: file });
    const q = new URLSearchParams({
      url: rawUrl,
      name: file,
      exp: String(exp),
      sig,
    });
    if (inline) q.set('inline', '1');
    return `${base}/dl?${q.toString()}`;
  }

  /** 从请求推断本服务的对外基址（考虑反向代理） */
  static baseUrlFrom(req, configured = '') {
    if (configured) return configured;
    const proto =
      (req.get('X-Forwarded-Proto') || '').split(',')[0].trim() || req.protocol || 'http';
    const host = req.get('X-Forwarded-Host') || req.get('Host') || `localhost`;
    return `${proto}://${host}`;
  }

  /**
   * 解析入口
   * @param {string} text 分享文本或链接
   * @param {object} [opts]
   * @param {string} [opts.base] 对外基址
   * @param {boolean} [opts.raw] 是否附带原始数据
   * @returns {Promise<object>}
   */
  async parse(text, opts = {}) {
    const started = Date.now();
    const base = opts.base || 'http://localhost';

    // 1) 从文本中抠出链接
    let link;
    try {
      link = extract(text);
    } catch (e) {
      throw new ApiError(
        /没有在文本中找到|未找到/.test(e.message) ? 'LINK_NOT_FOUND' : 'INVALID_REQUEST',
        e.message
      );
    }

    // 2) 短链还原出 aweme_id
    const steps = [`从分享文本中提取链接：${link.url}`];
    let awemeId = link.awemeId;
    let resolvedUrl = link.url;

    if (awemeId) {
      steps.push(`直接提取到视频 ID：${awemeId}`);
    } else if (link.isShort) {
      try {
        const r = await resolveShort(link.url);
        awemeId = r.awemeId;
        resolvedUrl = r.finalUrl;
        steps.push(`短链还原（${r.via}）-> ${awemeId || '未取到 ID'}`);
      } catch (e) {
        throw new ApiError('RESOLVE_FAILED', `短链还原失败：${e.message}`);
      }
    }

    if (!awemeId) {
      throw new ApiError(
        'UNSUPPORTED_LINK',
        '无法从该链接提取视频 ID。暂不支持直播间、用户主页、合集等类型，也可能是链接已失效'
      );
    }

    // 3) 查缓存
    const cacheKey = `aweme:${awemeId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return this._decorate(cached, { base, cached: true, elapsed: Date.now() - started });
    }

    // 4) 排队解析（浏览器是稀缺资源，必须限流）
    let detail;
    try {
      detail = await this.queue.run(() =>
        fetchDetail(awemeId, { timeout: this.parseTimeoutMs, resolvedUrl, steps })
      );
    } catch (e) {
      if (e && e.code === 'QUEUE_TIMEOUT') {
        throw new ApiError('QUEUE_TIMEOUT', e.message);
      }
      throw e;
    }

    this.cache.set(cacheKey, detail);
    return this._decorate(detail, { base, cached: false, elapsed: Date.now() - started });
  }

  /** 把内部结果整理成对外的响应结构 */
  _decorate(r, { base, cached, elapsed }) {
    const primary = r.media.primary;
    const isVideo = r.type === 'video' && primary;

    const nameBase = [r.author.nickname, r.title].filter(Boolean).join(' - ');
    const filename = `${safeName(nameBase || r.awemeId)}.${isVideo ? 'mp4' : 'jpeg'}`;

    const mainUrl = isVideo ? primary.url : r.media.images[0] ? r.media.images[0].url : null;

    const data = {
      type: r.type,
      aweme_id: r.awemeId,
      title: r.title,
      author: r.author,
      duration: r.duration,
      cover: r.cover,
      stats: r.stats,
      tags: r.tags,
      music: r.music,
      create_time: r.createTimeText,

      // —— 调用方主要用这三个字段 ——
      /** 下载地址：走本服务转发，绕过防盗链，拿来就能下 */
      download_url: this.buildDownloadUrl(mainUrl, filename, base, false),
      /** 抖音原始直链：可直接用，但可能受防盗链与有效期影响 */
      direct_url: mainUrl,
      /** 在线播放地址（流式，支持 Range） */
      play_url: isVideo ? this.buildDownloadUrl(mainUrl, filename, base, true) : null,

      filename,
      width: primary ? primary.width : null,
      height: primary ? primary.height : null,
      size: primary ? primary.size : null,
      expires_at: new Date(Date.now() + this.dlTtlMs).toISOString(),

      alternatives: (r.media.alternatives || []).map((a) => ({
        label: a.label,
        width: a.width,
        height: a.height,
        size: a.size,
        download_url: this.buildDownloadUrl(a.url, `${safeName(nameBase || r.awemeId)}_${a.label}.mp4`, base),
        direct_url: a.url,
      })),

      images: (r.media.images || []).map((im) => ({
        label: im.label,
        download_url: this.buildDownloadUrl(im.url, `${safeName(nameBase || r.awemeId)}_${im.index + 1}.jpeg`, base),
        direct_url: im.url,
      })),
    };

    return {
      ok: true,
      cached,
      elapsed_ms: elapsed,
      data,
      meta: cached ? undefined : { steps: r.meta.steps },
    };
  }

  stats() {
    return {
      cache: this.cache.stats(),
      queue: this.queue.stats(),
    };
  }
}

module.exports = { ParseService, safeName };
