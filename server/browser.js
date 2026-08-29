'use strict';

/**
 * 浏览器层：复用一个 Playwright Chromium 实例。
 *
 * 为什么必须用浏览器：抖音的 detail 接口由前端 bdms SDK（安全 SDK）拦截并
 * 自动注入 a_bogus / X-Bogus 签名，纯 HTTP 请求无法拿到数据（会返回空或验证页）。
 * 与其逆向签名算法（易失效、维护成本高），不如让浏览器自己算签名，
 * 我们只负责拦截它发出的 XHR 响应。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 桌面端 UA —— 实测结论（重要）：
 * 移动端 UA 访问分享页时，安全 SDK（secsdk）在 headless 下加载不完整，
 * 即便生成了 a_bogus 也会返回「参数不合法」；
 * 而桌面端 UA 打开 www.douyin.com/video/{id} 能正常执行风控脚本，
 * detail 接口可稳定返回完整数据。因此主链路一律走 PC 模式。
 */
const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

let chromium = null;
let browser = null;
let launching = null;

/**
 * Playwright 缓存浏览器的默认目录，各平台不同。
 * Linux 上是 ~/.cache/ms-playwright，Windows 是 %LOCALAPPDATA%\ms-playwright。
 */
function defaultBrowserBase() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'ms-playwright');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'ms-playwright');
  }
  return path.join(home, '.cache', 'ms-playwright'); // linux 及其他
}

/** 在 chromium-NNN 或 chromium_headless_shell-NNN 目录下找可执行文件 */
function executableIn(dir) {
  const candidates = [
    // Windows
    ['chrome-win', 'chrome.exe'],
    ['chrome-win64', 'chrome.exe'],
    ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
    // Linux
    ['chrome-linux', 'chrome'],
    ['chrome-linux64', 'chrome'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    // macOS
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ];
  for (const parts of candidates) {
    const p = path.join(dir, ...parts);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 目录名里的版本号，用于倒序排列（新的优先） */
function revOf(name) {
  const m = name.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/**
 * 找一个可用的 Chromium 可执行文件。
 * 优先：环境变量 -> 完整版 chromium -> headless shell。
 * 这样即便没跑过 `playwright install`，只要机器上已有内核也能直接用。
 */
function findExecutable() {
  const env =
    process.env.DY_CHROMIUM_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_PATH ||
    process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;

  const base = defaultBrowserBase();
  try {
    if (!fs.existsSync(base)) return null;
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium'));

    // 先找完整版（功能最全），再找 headless shell（更省资源）
    const full = dirs.filter((d) => d.startsWith('chromium-')).sort((a, b) => revOf(b) - revOf(a));
    const shell = dirs
      .filter((d) => d.includes('headless_shell'))
      .sort((a, b) => revOf(b) - revOf(a));

    for (const d of [...full, ...shell]) {
      const exe = executableIn(path.join(base, d));
      if (exe) return exe;
    }
  } catch (_) {
    /* 忽略探测失败 */
  }
  return null;
}

/** 懒加载 playwright，避免未安装时整个服务起不来 */
async function loadChromium() {
  if (chromium) return chromium;
  try {
    // eslint-disable-next-line global-require
    const pw = require('playwright');
    chromium = pw.chromium;
    return chromium;
  } catch (e) {
    const isLinux = process.platform === 'linux';
    throw new Error(
      '未检测到 playwright。请先安装：npm install playwright，然后下载内核：' +
        (isLinux
          ? 'npx playwright install-deps chromium && npx playwright install chromium'
          : 'npx playwright install chromium')
    );
  }
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;

  launching = (async () => {
    const cr = await loadChromium();
    const executablePath = findExecutable();
    const launchOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=zh-CN',
      ],
    };
    if (executablePath) launchOpts.executablePath = executablePath;
    browser = await cr.launch(launchOpts);
    browser.on('disconnected', () => {
      browser = null;
    });
    return browser;
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

/**
 * 在一个全新的隐上下文里打开页面，并采集匹配的 XHR JSON 响应。
 *
 * @param {object} opts
 * @param {string} opts.url          要打开的页面
 * @param {(u:string)=>boolean} opts.want  判断某个请求 URL 是否需要采集
 * @param {number} opts.timeout      最长等待毫秒
 * @param {string[]} [opts.waitFor]  额外的等待信号：'networkidle'
 * @returns {Promise<{payloads: object[], status: number|null, finalUrl: string}>}
 */
async function collect({ url, want, timeout = 30000, waitFor = [], mode = 'pc' }) {
  const b = await getBrowser();
  const isPC = mode === 'pc';
  const context = await b.newContext(
    isPC
      ? {
          userAgent: PC_UA,
          viewport: { width: 1440, height: 900 },
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          // 真实浏览器会带的 Accept-Language，缺了容易被风控识别为脚本
          acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
          javaScriptEnabled: true,
        }
      : {
          userAgent: MOBILE_UA,
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          javaScriptEnabled: true,
        }
  );

  const payloads = [];
  let status = null;
  let finalUrl = url;

  try {
    const page = await context.newPage();

    // 隐藏 headless 痕迹，降低触发风控概率
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      try {
        // 常见 headless 特征
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
      } catch (_) {
        /* 忽略 */
      }
    });

    page.on('response', async (res) => {
      const u = res.url();
      if (!want(u)) return;
      try {
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (ct.includes('json')) {
          const json = await res.json();
          if (json) payloads.push({ url: u, status: res.status(), json });
        }
      } catch (_) {
        // 响应体已被消费或不是 JSON，忽略
      }
    });

    const resp = await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
    status = resp ? resp.status() : null;
    finalUrl = page.url();

    // 等到目标请求出现，或超时
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (payloads.length) break;
      await page.waitForTimeout(200);
    }
    // 再给一点时间让后续补充请求（如 bit_rate 多清晰度）落地
    await page.waitForTimeout(600);

    if (waitFor.includes('networkidle')) {
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch (_) {
        /* 忽略 */
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  return { payloads, status, finalUrl };
}

/**
 * 关闭浏览器。常驻服务不需要调用；
 * 但一次性脚本必须调用，否则 Playwright 的进程句柄会让 Node 无法退出。
 */
async function closeBrowser() {
  if (browser) {
    const b = browser;
    browser = null;
    try {
      await b.close();
    } catch (_) {
      /* 忽略 */
    }
  }
}

/** 供解析器复用的 UA */
const UA = PC_UA;

module.exports = { getBrowser, collect, closeBrowser, UA, PC_UA, MOBILE_UA };
