'use strict';

/**
 * 解析主流程：aweme_id -> 浏览器打开视频页 -> 拦截 detail 接口 -> 清洗。
 *
 * 为什么必须用浏览器：抖音详情接口由前端安全 SDK 拦截并注入 a_bogus 签名，
 * 页面也不再输出 SSR 数据。纯 HTTP 拿不到数据，而逆向签名易失效。
 * 让浏览器自己算签名、我们只拦截响应，接口变更时无需改代码。
 *
 * 注意：必须用桌面端 UA 打开 www.douyin.com/video/{id}。
 * 移动端 UA 在 headless 下安全 SDK 加载不完整，即便有签名也会返回「参数不合法」。
 */

const { collect } = require('./browser');
const { normalize, findDetail } = require('./extractor');
const { ApiError } = require('./errors');

function isDetailRequest(url) {
  return (
    url.includes('/aweme/v1/web/aweme/detail/') ||
    url.includes('/aweme/v2/web/aweme/detail/') ||
    url.includes('/web/api/v2/aweme/iteminfo')
  );
}

/**
 * 用浏览器抓取指定视频的详情
 * @param {string} awemeId
 * @param {{timeout?:number, resolvedUrl?:string, keepRaw?:boolean}} [opts]
 */
async function fetchDetail(awemeId, opts = {}) {
  const timeout = opts.timeout || 45000;
  const pageUrl = `https://www.douyin.com/video/${awemeId}`;

  const { payloads } = await collect({
    url: pageUrl,
    want: isDetailRequest,
    timeout,
    mode: 'pc',
  });

  let detail = null;
  let source = null;
  for (const p of payloads) {
    const d = findDetail(p.json);
    if (d && (d.aweme_id || d.video || d.image_list)) {
      detail = d;
      source = p.url;
      break;
    }
  }

  if (!detail) {
    // 接口没返回视频数据，通常是作品不存在/私密/已删除，或命中风控
    throw new ApiError(
      'NOT_FOUND',
      '未能获取到视频数据。可能是作品已删除、设为私密、需要登录，或触发了风控（可稍后重试）'
    );
  }

  const steps = [...(opts.steps || []), `浏览器捕获详情接口 -> ${source}`];

  const result = normalize(
    { aweme_detail: detail },
    { awemeId, source, resolvedUrl: opts.resolvedUrl, steps, keepRaw: opts.keepRaw }
  );

  if (!result) throw new ApiError('PARSE_FAILED', '视频数据结构解析失败');
  return result;
}

module.exports = { fetchDetail, isDetailRequest };
