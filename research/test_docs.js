'use strict';
/** 验证文档页的在线调试功能：填 Key -> 点调用 -> 渲染结果 */
const path = require('path');
const { getBrowser, closeBrowser } = require(path.join(__dirname, '..', 'server', 'browser'));

(async () => {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 150));
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e.message).slice(0, 150)));

  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  console.log('标题:', await page.title());

  // 鉴权状态徽标
  await page.waitForTimeout(600);
  console.log('鉴权徽标:', await page.textContent('#auth-badge'));

  await page.fill('#in-key', 'test-key-aaaa');
  await page.fill('#in-url', 'https://v.douyin.com/5xyqSvRvCD8/');
  await page.click('#btn-run');
  console.log('已调用，等待结果…');

  await page.waitForSelector('#out:not(.hidden)', { timeout: 90000 }).catch(() => {
    console.log('!! 结果区未出现');
  });

  const out = await page.evaluate(() => {
    const el = document.getElementById('out');
    return {
      visible: el && !el.classList.contains('hidden'),
      isError: el ? el.classList.contains('error') : null,
      text: el ? el.innerText.replace(/\n+/g, ' | ').slice(0, 400) : '',
      links: el ? [...el.querySelectorAll('a')].map((a) => a.textContent.trim()) : [],
      status: document.getElementById('status')?.textContent,
    };
  });

  console.log('\n=== 调试结果 ===');
  console.log('状态栏:', out.status);
  console.log('是否错误:', out.isError);
  console.log('按钮:', out.links.join(' / '));
  console.log('内容:', out.text);

  console.log('\n=== 控制台错误 ===');
  console.log(errors.length ? errors.join('\n') : '(无)');

  await ctx.close();
  await closeBrowser();
  process.exit(out.visible && !out.isError && errors.length === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('FAIL:', e.message);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
