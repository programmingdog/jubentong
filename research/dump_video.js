'use strict';
/** 打印 aweme_detail.video 的原始结构，用于确定无水印地址的正确来源 */
const path = require('path');
const fs = require('fs');
const { collect, closeBrowser } = require(path.join(__dirname, '..', 'server', 'browser'));
const { findDetail } = require(path.join(__dirname, '..', 'server', 'extractor'));

const ID = process.argv[2] || '7666397642670402297';

(async () => {
  const { payloads } = await collect({
    url: `https://www.douyin.com/video/${ID}`,
    want: (u) => u.includes('/aweme/v1/web/aweme/detail/'),
    timeout: 45000,
    mode: 'pc',
  });

  let detail = null;
  for (const p of payloads) {
    const d = findDetail(p.json);
    if (d && d.aweme_id) { detail = d; break; }
  }
  if (!detail) { console.log('无 detail'); await closeBrowser(); return; }

  const v = detail.video || {};
  console.log('=== video 顶层字段 ===');
  console.log(Object.keys(v).join(', '));

  console.log('\n=== play_addr ===');
  console.log(JSON.stringify(v.play_addr, null, 1).slice(0, 2500));

  console.log('\n=== download_addr ===');
  console.log(JSON.stringify(v.download_addr || null, null, 1).slice(0, 1200));

  console.log('\n=== 其他 addr 类字段 ===');
  for (const k of Object.keys(v)) {
    if (/addr|url|play/i.test(k) && k !== 'play_addr' && k !== 'download_addr') {
      console.log(`--- ${k} ---`);
      console.log(JSON.stringify(v[k], null, 1).slice(0, 800));
    }
  }

  console.log('\n=== bit_rate[0] ===');
  if (Array.isArray(v.bit_rate) && v.bit_rate.length) {
    console.log('bit_rate 数量:', v.bit_rate.length);
    console.log(JSON.stringify(v.bit_rate[0], null, 1).slice(0, 1600));
  }

  fs.writeFileSync(
    path.join(__dirname, 'raw_video.json'),
    JSON.stringify(v, null, 2),
    'utf-8'
  );
  console.log('\n原始 video 对象 -> research/raw_video.json');
  await closeBrowser();
})().catch(async (e) => {
  console.error('FAIL:', e.message);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
