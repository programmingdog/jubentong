'use strict';

/**
 * 排障脚本：不依赖业务代码，单独用无头 Chromium 打开一个抖音视频页，
 * 把所有 douyin 相关响应（状态 / 类型 / URL）打出来，帮你判断：
 *   - 是「接口返回了数据但解析没匹配上」（代码问题）
 *   - 还是「抖音回了验证页 / 风控 / 接口已变更」（环境或风控问题）
 *
 * 用法（服务器上，内核在 /opt/playwright-browsers）：
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
 *     node research/diag_capture.js "https://v.douyin.com/xxxx/"
 */

const { getBrowser, PC_UA } = require('../server/browser');
const { isDetailRequest } = require('../server/parser');

(async () => {
  const target = process.argv[2] || 'https://v.douyin.com/HcnLI8mNdxI/';

  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: PC_UA,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    javaScriptEnabled: true,
  });

  const page = await ctx.newPage();
  const seen = [];

  page.on('response', async (res) => {
    const u = res.url();
    if (!/douyin|bytecdn|douyinstatic/.test(u)) return;
    const ct = res.headers()['content-type'] || '';
    const short = u.length > 110 ? u.slice(0, 110) + '…' : u;
    // eslint-disable-next-line no-console
    console.log(String(res.status()).padStart(3), (ct.split(';')[0] || '').padEnd(15), short);
    seen.push(u);
  });

  // eslint-disable-next-line no-console
  console.log('>> goto', target);
  const resp = await page.goto(target, { timeout: 45000, waitUntil: 'domcontentloaded' });
  // eslint-disable-next-line no-console
  console.log('>> goto status', resp && resp.status(), 'finalUrl', page.url());

  // 等 detail 接口 + 后续补充请求落地
  await page.waitForTimeout(9000);

  const detailHit = seen.filter(isDetailRequest);
  // eslint-disable-next-line no-console
  console.log('>> detail 接口命中数:', detailHit.length, detailHit.map((u) => u.slice(0, 60)));

  await ctx.close();
  process.exit(0);
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('ERR', e.stack || e.message);
  process.exit(1);
});
