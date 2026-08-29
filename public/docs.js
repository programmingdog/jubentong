'use strict';

/* 文档页的在线调试功能：直接调用本机 /v1/parse 并展示结果 */

const $ = (id) => document.getElementById(id);
const KEY_STORE = 'dy_parser_apikey';

/** 检测服务鉴权状态，据此提示用户是否需要填 Key */
async function detectAuth() {
  const badge = $('auth-badge');
  const tip = $('auth-tip');
  try {
    const r = await fetch('/healthz');
    const j = await r.json();
    if (j.auth === 'enabled') {
      badge.className = 'badge badge-on';
      badge.textContent = '鉴权已开启';
      tip.textContent = '（服务要求鉴权，必填）';
    } else {
      badge.className = 'badge badge-off';
      badge.textContent = '鉴权已关闭';
      tip.textContent = '（服务当前无需鉴权，可留空）';
    }
  } catch (_) {
    badge.className = 'badge badge-idle';
    badge.textContent = '服务未连接';
  }
}

function fmtSize(n) {
  if (!n) return '-';
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function fmtDuration(sec) {
  if (!sec) return '-';
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

async function run() {
  const url = $('in-url').value.trim();
  const key = $('in-key').value.trim();
  const out = $('out');
  const btn = $('btn-run');

  if (!url) {
    out.className = 'out error';
    out.textContent = '请先填写抖音分享链接';
    out.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = '解析中…';
  $('status').textContent = '首次解析需启动浏览器，请稍候';
  out.classList.add('hidden');

  const t0 = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['X-API-Key'] = key;
    if (key) localStorage.setItem(KEY_STORE, key);

    const res = await fetch('/v1/parse', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url }),
    });
    const j = await res.json();

    if (!j.ok) {
      out.className = 'out error';
      out.innerHTML = `<b>${esc(j.code || 'ERROR')}</b> — ${esc(j.message)}`;
      out.classList.remove('hidden');
      $('status').textContent = '';
      return;
    }

    const d = j.data;
    const alts = (d.alternatives || [])
      .map(
        (a) =>
          `<a class="dl-btn alt" href="${esc(a.download_url)}" target="_blank" rel="noreferrer">${esc(a.label)} ${a.height ? a.height + 'P' : ''}</a>`
      )
      .join('');

    out.className = 'out';
    out.innerHTML = `
      <dl class="kv">
        <dt>标题</dt><dd>${esc(d.title || '（无）')}</dd>
        <dt>作者</dt><dd>${esc(d.author && d.author.nickname)}</dd>
        <dt>时长</dt><dd>${fmtDuration(d.duration)}${d.width ? ` · ${d.width}×${d.height}` : ''}${d.size ? ` · ${fmtSize(d.size)}` : ''}</dd>
        <dt>类型</dt><dd>${esc(d.type)}${j.cached ? ' · <b>来自缓存</b>' : ''} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s</dd>
        <dt>主地址</dt><dd>
          <a class="dl-btn" href="${esc(d.download_url)}" target="_blank" rel="noreferrer">下载</a>
          ${d.play_url ? `<a class="dl-btn alt" href="${esc(d.play_url)}" target="_blank" rel="noreferrer">在线播放</a>` : ''}
          ${d.direct_url ? `<a href="${esc(d.direct_url)}" target="_blank" rel="noreferrer">原始直链</a>` : ''}
        </dd>
        ${alts ? `<dt>其他清晰度</dt><dd>${alts}</dd>` : ''}
        <dt>链接过期</dt><dd>${esc(d.expires_at)}</dd>
      </dl>`;
    out.classList.remove('hidden');
    $('status').textContent = '解析成功';
  } catch (e) {
    out.className = 'out error';
    out.textContent = '请求失败：' + e.message;
    out.classList.remove('hidden');
    $('status').textContent = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '调用解析接口';
  }
}

$('btn-run').onclick = run;
$('btn-fill').onclick = () => {
  $('in-url').value = 'https://v.douyin.com/JFz0TRU-LE0/';
  $('in-url').focus();
};
$('in-url').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
});

// 记住上次填过的 Key
const saved = localStorage.getItem(KEY_STORE);
if (saved) $('in-key').value = saved;

detectAuth();
