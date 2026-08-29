'use strict';

/**
 * 分享文本 -> 规范化的抖音资源标识
 *
 * 用户直接复制过来的往往不是干净 URL，而是一整段口令文本，例如：
 *   7.28 mwo:/ q@e.Xx 复制此链接，打开Dou音搜索，直接观看视频！ https://v.douyin.com/xxxxx/
 * 所以第一步是「从文本里把链接抠出来」，第二步才是短链还原。
 */

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 短链还原统一用桌面端 UA：服务端会据此跳到 www.douyin.com/video/{id}，
// 与后续主链路的 PC 页面保持一致。
const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// 各种抖音链接形态，按优先级排列
const PATTERNS = [
  // https://www.douyin.com/video/7373659809034206501?...
  { re: /https?:\/\/(?:www\.)?(?:douyin|iesdouyin)\.com\/(?:video|note|slides)\/(\d{6,})/i, type: 'aweme' },
  // https://www.douyin.com/discover?modal_id=7373...  或 ?aweme_id=
  { re: /https?:\/\/(?:www\.)?douyin\.com\/[^?]*\?(?:[^#]*&)?(?:modal_id|aweme_id)=(\d{6,})/i, type: 'aweme' },
  // https://www.iesdouyin.com/share/video/7373.../
  { re: /https?:\/\/(?:www\.)?iesdouyin\.com\/share\/(?:video|note|slides)\/(\d{6,})/i, type: 'aweme' },
  // https://www.iesdouyin.com/aweme/v1/web/...?aweme_id=
  { re: /https?:\/\/(?:www\.)?iesdouyin\.com\/[^?]*\?(?:[^#]*&)?(?:aweme_id|item_ids)=(\d{6,})/i, type: 'aweme' },
  // 短链 https://v.douyin.com/iRabcdef/
  { re: /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_\-]{4,}\/?/i, type: 'short' },
  // 短链 https://douyin.com/xxxx 变体 / 无 scheme
  { re: /(?:^|[\s(（【])v\.douyin\.com\/[A-Za-z0-9_\-]{4,}\/?/i, type: 'short' },
];

/**
 * 从任意分享文本中提取出链接与（若可得）aweme_id
 * @param {string} raw
 */
function extract(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('请输入抖音分享链接或口令文本');

  for (const { re, type } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    let url = m[0].trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^[\s(（【]+/, '');
    if (type === 'aweme') return { url, awemeId: m[1], isShort: false };
    return { url, awemeId: null, isShort: true };
  }

  // 兜底：整段文本里根本没有任何抖音域名
  if (/douyin\.com/i.test(text)) {
    throw new Error('识别到抖音链接但格式不支持，请复制完整的分享链接重试');
  }
  throw new Error('没有在文本中找到抖音链接，请确认粘贴的是抖音分享内容');
}

/**
 * 短链还原。
 * 优先用 HTTP 手动跟随重定向（快）；若服务端返回 HTML 页中转（无 Location），
 * 则从 HTML 里抠出跳转目标。
 *
 * @param {string} shortUrl
 * @returns {Promise<{finalUrl:string, awemeId:string|null, via:string}>}
 */
async function resolveShort(shortUrl) {
  let current = shortUrl;
  let via = 'http';

  for (let hop = 0; hop < 8; hop += 1) {
    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': UA_PC,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new Error(`短链请求失败：${e.message}`);
    }

    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      const next = new URL(location, current).toString();
      // 抖音短链常把目标塞在 URL 参数里，优先直接解析 aweme_id
      const direct = parseAwemeId(next) || parseAwemeId(location);
      if (direct) return { finalUrl: next, awemeId: direct, via };
      current = next;
      continue;
    }

    // 没有 Location：可能返回了一个带 JS 跳转的中转页
    if (res.status === 200) {
      const html = await res.text().catch(() => '');
      const fromHtml = pickUrlFromHtml(html);
      if (fromHtml) {
        const id = parseAwemeId(fromHtml);
        if (id) return { finalUrl: fromHtml, awemeId: id, via: via + '+html' };
        current = fromHtml;
        continue;
      }
      // 实在没跳转目标，但页面里可能有 aweme_id
      const inline = html.match(/["']?aweme_?id["']?\s*[:=]\s*["']?(\d{6,})/i)
        || html.match(/\/video\/(\d{6,})/);
      if (inline) return { finalUrl: current, awemeId: inline[1], via: via + '+scan' };
    }

    // 走到这里说明没能继续跳转，用当前 URL 尽力解析
    return { finalUrl: current, awemeId: parseAwemeId(current), via };
  }

  return { finalUrl: current, awemeId: parseAwemeId(current), via };
}

function pickUrlFromHtml(html) {
  const cands = [
    /window\.location\.href\s*=\s*["']([^"']+)["']/i,
    /window\.location\.replace\(\s*["']([^"']+)["']/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]*;\s*url=([^"']+)["']/i,
    /["'](https?:\/\/(?:www\.)?(?:douyin|iesdouyin)\.com\/[^"']+)["']/i,
  ];
  for (const re of cands) {
    const m = html.match(re);
    if (m) return m[1].replace(/&amp;/g, '&');
  }
  return null;
}

/** 从任意 URL / 字符串中抽取 aweme_id */
function parseAwemeId(input) {
  if (!input) return null;
  const s = String(input);
  const tries = [
    /\/video\/(\d{6,})/,
    /\/note\/(\d{6,})/,
    /\/slides\/(\d{6,})/,
    /\/share\/(?:video|note|slides)\/(\d{6,})/,
    /[?&](?:modal_id|aweme_id|item_ids|item_id)=(\d{6,})/,
  ];
  for (const re of tries) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

module.exports = { extract, resolveShort, parseAwemeId, UA_MOBILE, UA_PC };
