'use strict';
/** 打开抖音发现页，拦截接口响应，抓一个真实可访问的 aweme_id 用于端到端测试 */
const path = require('path');
const { getBrowser, UA } = require(path.join(__dirname, '..', 'server', 'browser'));

(async () => {
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: UA,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  const page = await ctx.newPage();
  const found = new Map(); // id -> {desc, url}

  page.on('response', async (res) => {
    const u = res.url();
    if (!/aweme\/v[12]\//.test(u) && !/web\/api/.test(u)) return;
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      const j = await res.json();
      walk(j);
    } catch (_) { /* ignore */ }
  });

  function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.aweme_id && (o.desc || o.video || o.image_list)) {
      const id = String(o.aweme_id);
      if (!found.has(id)) {
        found.set(id, { desc: (o.desc || '').slice(0, 40), hasVideo: !!(o.video && o.video.play_addr) });
      }
    }
    if (Array.isArray(o)) { o.slice(0, 30).forEach(walk); return; }
    for (const k of Object.keys(o)) {
      if (k === 'raw') continue;
      walk(o[k]);
    }
  }

  const targets = [
    'https://www.douyin.com/discover',
    'https://www.douyin.com/hot',
    'https://www.iesdouyin.com/',
  ];

  for (const t of targets) {
    console.log('\n>>> 打开', t);
    try {
      await page.goto(t, { timeout: 40000, waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.log('  goto 失败:', e.message.split('\n')[0]);
    }
    // 滚动一下触发懒加载
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);
    console.log('  当前 URL:', page.url());
    console.log('  已捕获 ID 数:', found.size);
    if (found.size >= 3) break;
  }

  console.log('\n===== 捕获到的视频 ID =====');
  let n = 0;
  for (const [id, info] of found) {
    console.log(`${id}  video=${info.hasVideo}  desc=${JSON.stringify(info.desc)}`);
    if (++n >= 10) break;
  }
  if (!found.size) console.log('(无)');

  await ctx.close();
  await b.close();
})();
