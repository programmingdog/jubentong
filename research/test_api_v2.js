'use strict';
/**
 * 对外接口 v2 端到端测试：
 * 鉴权 / 错误码 / 解析 / 缓存 / 签名下载 / 篡改与过期 / 白名单 / 并发队列
 */
const path = require('path');
const BASE = 'http://localhost:5173';
const KEY = 'test-key-aaaa';

const config = require(path.join(__dirname, '..', 'server', 'config'));
const { sign } = require(path.join(__dirname, '..', 'server', 'sign'));

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  ok ? (pass += 1) : (fail += 1);
}

async function parse(body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-API-Key'] = key;
  const r = await fetch(BASE + '/v1/parse', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

(async () => {
  console.log('=== 1. 鉴权 ===');
  let r = await parse({ url: 'https://v.douyin.com/JFz0TRU-LE0/' }, null);
  check('无 API Key -> 401 UNAUTHORIZED', r.status === 401 && r.json.code === 'UNAUTHORIZED', `got ${r.status}`);

  r = await parse({ url: 'https://v.douyin.com/JFz0TRU-LE0/' }, 'wrong-key');
  check('错误 Key -> 403 FORBIDDEN', r.status === 403 && r.json.code === 'FORBIDDEN', `got ${r.status}`);

  console.log('\n=== 2. 参数与错误码 ===');
  r = await parse({}, KEY);
  check('缺少 url -> 400 INVALID_REQUEST', r.status === 400 && r.json.code === 'INVALID_REQUEST');

  r = await parse({ url: '这是一段没有链接的文本' }, KEY);
  check('无链接文本 -> 400 LINK_NOT_FOUND', r.status === 400 && r.json.code === 'LINK_NOT_FOUND', r.json.code);

  console.log('\n=== 3. 正常解析 ===');
  const t0 = Date.now();
  r = await parse({ url: 'https://v.douyin.com/JFz0TRU-LE0/' }, KEY);
  const elapsed = Date.now() - t0;
  check('返回 200', r.status === 200 && r.json.ok === true, `${elapsed}ms`);
  if (!r.json.ok) {
    console.log('  响应:', JSON.stringify(r.json).slice(0, 300));
    process.exit(1);
  }

  const d = r.json.data;
  check('cached=false（首次）', r.json.cached === false);
  check('aweme_id 正确', d.aweme_id === '7614864032293885375', d.aweme_id);
  check('download_url 存在且是本服务签名链接', !!d.download_url && d.download_url.includes('/dl?'), '');
  check('direct_url 是抖音 CDN 直链', /douyinvod\.com|douyin\.com/.test(d.direct_url || ''));
  check('play_url 存在', !!d.play_url);
  check('有作者与时长', !!d.author.nickname && d.duration > 0, `${d.author.nickname} / ${d.duration}s`);
  check('expires_at 存在', !!d.expires_at);
  console.log(`     标题: ${d.title.slice(0, 40)}`);
  console.log(`     主地址: ${d.width}x${d.height} ${d.size ? (d.size / 1048576).toFixed(1) + 'MB' : ''}`);
  console.log(`     备选清晰度: ${d.alternatives.length} 个，图片: ${d.images.length} 张`);

  console.log('\n=== 4. 缓存 ===');
  const t1 = Date.now();
  const r2 = await parse({ url: 'https://v.douyin.com/JFz0TRU-LE0/' }, KEY);
  check('第二次请求 cached=true', r2.json.cached === true);
  check('缓存命中明显更快', Date.now() - t1 < elapsed, `${Date.now() - t1}ms vs ${elapsed}ms`);
  check('缓存结果的 download_url 仍有效', !!r2.json.data.download_url);

  console.log('\n=== 5. 签名下载链接 ===');
  const dlRes = await fetch(d.download_url, { headers: { Range: 'bytes=0-65535' } });
  const buf = Buffer.from(await dlRes.arrayBuffer());
  check('download_url 可下载', dlRes.ok || dlRes.status === 206, `status=${dlRes.status}`);
  check('返回 video/mp4', (dlRes.headers.get('content-type') || '').includes('video/mp4'));
  check('Range 生效（206）', dlRes.status === 206, `收到 ${buf.length} 字节`);
  check('文件头是 MP4', buf.slice(4, 8).toString() === 'ftyp', buf.slice(0, 12).toString('hex'));
  check('带 Content-Disposition 下载头', /attachment/.test(dlRes.headers.get('content-disposition') || ''));

  const playRes = await fetch(d.play_url, { headers: { Range: 'bytes=0-1023' } });
  check('play_url 不带下载头（inline）', !/attachment/.test(playRes.headers.get('content-disposition') || ''));

  console.log('\n=== 6. 签名安全 ===');
  const u = new URL(d.download_url);
  const tampered = new URL(d.download_url);
  tampered.searchParams.set('sig', 'x'.repeat(43));
  let bad = await fetch(tampered.toString());
  check('篡改签名 -> 403 BAD_SIGNATURE', bad.status === 403 && (await bad.json()).code === 'BAD_SIGNATURE', `got ${bad.status}`);

  // 用正确算法签一个已过期的时间戳
  const rawUrl = u.searchParams.get('url');
  const name = u.searchParams.get('name');
  const exp = Math.floor(Date.now() / 1000) - 60;
  const sigExpired = sign(config.dlSecret, { url: rawUrl, exp, name });
  const expired = `${BASE}/dl?url=${encodeURIComponent(rawUrl)}&name=${encodeURIComponent(name)}&exp=${exp}&sig=${sigExpired}`;
  const expRes = await fetch(expired);
  check('过期链接 -> 410 LINK_EXPIRED', expRes.status === 410, `got ${expRes.status}`);

  console.log('\n=== 7. 白名单（防 SSRF） ===');
  const evilUrl = 'http://169.254.169.254/latest/meta-data/'; // 云主机元数据
  const evilSig = sign(config.dlSecret, { url: evilUrl, exp: Math.floor(Date.now() / 1000) + 3600, name: 'x' });
  const evil = await fetch(`${BASE}/dl?url=${encodeURIComponent(evilUrl)}&name=x&exp=${Math.floor(Date.now() / 1000) + 3600}&sig=${evilSig}`);
  check('非白名单地址被拒绝', evil.status === 400 && (await evil.json()).code === 'FORBIDDEN_HOST', `got ${evil.status}`);

  console.log('\n=== 8. GET 便捷形式 ===');
  const g = await fetch(`${BASE}/v1/parse?url=${encodeURIComponent('https://www.douyin.com/video/7614864032293885375')}`, {
    headers: { 'X-API-Key': KEY },
  });
  const gj = await g.json();
  check('GET /v1/parse?url= 可用', g.status === 200 && gj.ok === true, gj.code || '');

  console.log('\n=== 9. 并发队列 ===');
  const links = [
    'https://www.douyin.com/video/7614864032293885375',
    'https://www.douyin.com/video/7658714723521475813',
    'https://v.douyin.com/L4FJNR3/',
  ];
  await fetch(`${BASE}/v1/cache/7614864032293885375`, { method: 'DELETE', headers: { 'X-API-Key': KEY } });
  const t2 = Date.now();
  const results = await Promise.all(links.map((u2) => parse({ url: u2 }, KEY)));
  const okCount = results.filter((x) => x.json.ok).length;
  check('3 个并发任务全部完成', okCount === 3, `成功 ${okCount}/3，耗时 ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  const st = await (await fetch(`${BASE}/v1/stats`, { headers: { 'X-API-Key': KEY } })).json();
  check('队列统计正常', st.ok && st.queue.done > 0, `done=${st.queue.done} failed=${st.queue.failed}`);

  console.log('\n=== 10. 文档页 ===');
  const docRes = await fetch(BASE + '/');
  const docHtml = await docRes.text();
  check('文档页 200', docRes.status === 200);
  check('文档页包含接口说明', docHtml.includes('/v1/parse') && docHtml.includes('download_url'));

  console.log(`\n──────── 通过 ${pass} / 失败 ${fail} ────────`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e.message);
  process.exit(1);
});
