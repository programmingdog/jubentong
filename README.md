# 抖音分享链接解析服务

传入抖音分享链接（或整段口令文本），返回视频的**真实下载地址**。

```
POST /v1/parse   {"url": "https://v.douyin.com/JFz0TRU-LE0/"}
                          │
                          ▼
                  { "download_url": "http://host/dl?url=...&exp=...&sig=...",
                    "direct_url":   "https://v26-web.douyinvod.com/...",
                    "play_url":     "http://host/dl?...&inline=1",
                    "title": "...", "author": {...}, "duration": 116, ... }
```

## 快速开始

```bash
npm install
npm start                 # 无鉴权模式，直接跑
# 或
cp .env.example .env      # 改配置
npm run dev               # 带 .env 启动
```

打开 <http://localhost:5173> 可看到接口文档与在线调试页。

### 浏览器内核

解析依赖 Playwright 的 Chromium。程序会**自动探测**本机 `ms-playwright` 缓存里
已安装的版本，找到就复用；找不到才需要装：

```bash
npx playwright install chromium
```

也可直接指定：`DY_CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm start`

## 部署到 Linux 服务器

### 支持情况

服务的 Node 部分没有平台限制，**真正的约束来自 Chromium**——它需要较新的
glibc 与一系列图形运行时库：

| 系统 | 支持 | 说明 |
| --- | --- | --- |
| Rocky / AlmaLinux 8、9 | ✅ 推荐 | glibc 2.28+，装完依赖即可运行 |
| CentOS Stream 8 / 9 | ✅ | 同上 |
| RHEL 8 / 9 | ✅ | 同上 |
| Ubuntu 20.04 / 22.04 / 24.04 | ✅ | Playwright 官方支持最好 |
| **CentOS 7** | ⚠️ 不建议 | glibc 仅 2.17、`GLIBCXX` 最高 3.4.19，新版 Chromium 直接启动失败；且已于 2024-06-30 停止维护 |

> 如果只能在 CentOS 7 上跑，建议直接用 Docker（见下），而不是手工补依赖——
> 手工方案要装 devtoolset 并注入 `LD_LIBRARY_PATH`，容易影响同机其他服务。

### 一键部署（RHEL 系）

```bash
# 上传项目代码到服务器后，root 执行：
bash deploy/install-centos.sh
```

脚本会依次完成：识别发行版 → 检查版本（CentOS 7 会告警）→ 安装 Node 18+ →
安装 npm 依赖 → 安装 Chromium 系统库 → 下载内核 → 生成 `.env`（含随机 API Key）
→ 配置防火墙 → 安装并启动 systemd 服务。

### 手动部署

```bash
# 1. 系统依赖（RHEL 8+/Rocky/Alma）
dnf install -y atk at-spi2-atk cups-libs libdrm libXcomposite libXdamage \
  libXfixes libXrandr libxkbcommon mesa-libgbm pango cairo alsa-lib \
  nss nspr dbus-glib freetype fontconfig

# 或用 Playwright 自带的安装器（会按发行版适配）
npx playwright install-deps chromium

# 2. 下载内核。注意：服务以普通用户运行时读不到 root 的 ~/.cache，
#    所以要放到共享路径并在环境变量里指定
export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
npx playwright install chromium
chmod -R a+rX /opt/playwright-browsers

# 3. 配置并启动
cp .env.example .env   # 修改 API_KEYS 等
npm install --omit=dev
node server/index.js
```

国内服务器下载慢可设置镜像：

```bash
export PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
npm config set registry https://registry.npmmirror.com
```

### systemd

`deploy/douyin-parser.service` 是现成的单元文件，安装脚本会自动渲染并启用。
常用命令：

```bash
systemctl status  douyin-parser
journalctl -u douyin-parser -f
systemctl restart douyin-parser
```

### Docker（CentOS 7 的推荐方案）

```dockerfile
FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 5173
CMD ["node", "server/index.js"]
```

### Linux 上常见故障

| 现象 | 原因与处理 |
| --- | --- |
| `error while loading shared libraries` / `GLIBCXX_3.4.20 not found` | 系统太老（多为 CentOS 7）。升级系统或改用 Docker |
| 浏览器启动后立即退出 | SELinux 拦截。查 `/var/log/audit/audit.log` 的 avc 记录，或临时 `setenforce 0` 验证 |
| 容器里崩溃 | 确认已加 `--no-sandbox`（代码默认已加）；`/dev/shm` 太小时保持 `--disable-dev-shm-usage` |
| 找不到浏览器 | 检查 `PLAYWRIGHT_BROWSERS_PATH` 是否与下载时一致，以及运行用户是否有读权限 |
| 内存占用高 | 调低 `MAX_CONCURRENCY`，或在 service 里收紧 `MemoryMax` |

## 自动化部署（GitHub Actions）

推送代码到 GitHub 后自动同步到生产服务器。**前提：服务器有公网 IP，
GitHub 能通过 SSH 连上去**（内网服务器见本节末尾）。

### 流程

```
本地 git push → GitHub → Actions 触发 → 语法自检 → SSH 连服务器
                                                  → deploy/update.sh
                                                  → git pull → 按需 npm install
                                                  → 重启 → 健康检查
```

健康检查失败会中止并给出回滚命令；语法错误在重启前就会被拦下，
**不会让服务停在中途**。

### 1. 服务器先做一次首次部署

```bash
bash deploy/install-centos.sh
```

脚本会把项目放到 `/opt/douyin-parser` 并配好 systemd 与 `.env`。

### 2. 生成部署专用 SSH 密钥

```bash
# 在服务器上生成（专用于部署，不要用个人密钥）
ssh-keygen -t ed25519 -C "github-deploy" -f ~/.ssh/github_deploy -N ""

# 公钥加入授权列表
cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys

# 私钥打印出来，下一步填到 GitHub
cat ~/.ssh/github_deploy
```

### 3. 在 GitHub 配置 Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `SSH_PRIVATE_KEY` | ✅ | 上一步的私钥全文（含 `-----BEGIN` / `-----END` 行） |
| `SERVER_HOST` | ✅ | 服务器 IP 或域名 |
| `SERVER_USER` | ✅ | SSH 用户名（如 `root` 或 `douyin`） |
| `SERVER_PORT` | | SSH 端口，默认 22 |
| `APP_DIR` | | 项目路径，默认 `/opt/douyin-parser` |

### 4. 触发部署

推送到 `main` 分支即自动部署（改 README 之类不触发，工作流做了路径过滤）。
也可以在 GitHub 的 **Actions** 页面手动点 **Run workflow**。

### 安全要点

- **`.env` 和 `.data/` 已在 `.gitignore` 中，不会上传、也不会被部署覆盖。**
  其中 `.data/dl_secret` 是下载链接的签名密钥，一旦变动，已签发的
  `download_url` 会全部失效——所以每个环境都要保留自己的那份。
- 建议用专门的部署密钥，并在服务器上限制它只能执行部署脚本
  （`authorized_keys` 里加 `command="..."` 前缀）。
- 工作流只用 GitHub 官方 action，未引入第三方 action，减少供应链风险。

### 服务器在内网怎么办

GitHub Actions 连不进来时，改成**服务器主动拉取**：

1. 在服务器跑一个 webhook 接收端（[adnanh/webhook](https://github.com/adnanh/webhook)，
   或自己用 Node/Python 起一个），收到请求后执行 `deploy/update.sh`。
2. GitHub 侧用 **Repository Webhook**（Settings → Webhooks）指向它，
   并校验 `X-Hub-Signature-256`，防止被伪造请求触发。
3. 另一种做法是用 **GitHub Actions 自托管 runner**，让服务器主动连 GitHub，
   不需要公网入口。

## 配置

全部通过环境变量设置（见 `.env.example`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 5173 | 服务端口 |
| `API_KEYS` | 空 | API Key，配了就自动开启鉴权。支持 `名称:key` 形式 |
| `REQUIRE_AUTH` | 随 API_KEYS | 设为 `0` 可强制关闭鉴权 |
| `CACHE_TTL_MS` | 1800000 | 解析结果缓存时长（30 分钟） |
| `MAX_CONCURRENCY` | 2 | 同时进行的解析任务数 |
| `PARSE_TIMEOUT_MS` | 45000 | 单个任务超时 |
| `QUEUE_TIMEOUT_MS` | 90000 | 排队超时，超过返回 503 |
| `DL_TTL_MS` | 21600000 | `download_url` 有效期（6 小时） |
| `DL_SECRET` | 自动生成 | 下载链接签名密钥。**多实例部署必须统一设置** |
| `PUBLIC_BASE_URL` | 自动推断 | 生成 `download_url` 用的对外基址 |

## 接口

### POST /v1/parse

同时提供 `GET /v1/parse?url=...` 便捷形式。

请求头：`Content-Type: application/json`、`X-API-Key: <key>`

```json
{ "url": "https://v.douyin.com/JFz0TRU-LE0/" }
```

`url` 可以是整段口令文本，服务会自动从中提取链接。

响应：

```json
{
  "ok": true,
  "cached": false,
  "elapsed_ms": 4210,
  "data": {
    "type": "video",
    "aweme_id": "7614864032293885375",
    "title": "邵哥给妈妈女神节的限定款",
    "author": {
      "nickname": "邵哥是个崇明土著",
      "sec_uid": "MS4wLjABAAAA...",
      "uid": "2269812910488919",
      "avatar": "https://...",
      "verify": ""
    },
    "duration": 116,
    "cover": "https://p3-pc-sign.douyinpic.com/...",
    "stats": { "digg": 100, "comment": 16, "collect": 9, "share": 2, "play": null },
    "tags": ["三八女神节", "创意插花"],
    "music": { "title": "@邵哥...创作的原声", "author": "邵哥...", "playUrl": "..." },
    "create_time": "2026-07-25 09:12:33",

    "download_url": "http://host/dl?url=...&name=...&exp=...&sig=...",
    "direct_url": "https://v26-web.douyinvod.com/...",
    "play_url": "http://host/dl?url=...&inline=1",

    "filename": "邵哥是个崇明土著 - 邵哥给妈妈女神节的限定款.mp4",
    "width": 720, "height": 1280, "size": 30620000,
    "expires_at": "2026-08-29T12:00:00.000Z",

    "alternatives": [
      { "label": "normal_720_0", "width": 720, "height": 1280,
        "size": 21941645, "download_url": "...", "direct_url": "..." }
    ],
    "images": []
  }
}
```

### 返回字段说明

| 字段 | 说明 |
| --- | --- |
| `download_url` | **推荐**。走本服务转发，绕过抖音 Referer 防盗链，拿到即可下载，支持 Range |
| `direct_url` | 抖音原始 CDN 直链。可直接使用，但可能受防盗链影响，且有有效期 |
| `play_url` | 在线播放地址（流式，支持拖动进度条） |
| `alternatives` | 其他清晰度候选，结构与主地址一致 |
| `images` | 图集作品的每张原图（`type` 为 `images` 时有值） |
| `expires_at` | `download_url` 过期时间。过期后重新调用解析即可 |
| `cached` | 本次结果是否来自缓存 |

### GET /dl

下载代理。`download_url` 已带 HMAC 签名，**直接请求即可，无需再带 API Key**。
支持 Range 请求，可用于边下边播。

### GET /healthz

健康检查，不需要鉴权，返回服务状态与缓存/队列统计。

### GET /v1/stats、DELETE /v1/cache/:id

运行状态与手动清除缓存，需要鉴权。

## 错误码

所有错误统一为 `{"ok":false,"code":"...","message":"..."}`：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 请求参数有误 |
| 400 | `LINK_NOT_FOUND` | 文本中没有找到抖音链接 |
| 400 | `UNSUPPORTED_LINK` | 链接类型不支持（直播间、主页等） |
| 401 | `UNAUTHORIZED` | 缺少或无效的 API Key |
| 404 | `NOT_FOUND` | 作品已删除、私密或命中风控 |
| 410 | `LINK_EXPIRED` | 下载链接过期，重新解析即可 |
| 502 | `UPSTREAM_ERROR` | 抖音上游异常 |
| 503 | `QUEUE_TIMEOUT` | 并发已满，排队超时 |
| 504 | `TIMEOUT` | 解析超时 |

## 调用示例

```bash
curl -X POST http://localhost:5173/v1/parse \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"url":"https://v.douyin.com/JFz0TRU-LE0/"}'
```

```js
const res = await fetch('http://localhost:5173/v1/parse', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
  body: JSON.stringify({ url: shareText }),
});
const { data } = await res.json();
// data.download_url 拿来就能下载
```

```python
import requests
r = requests.post('http://localhost:5173/v1/parse',
                  headers={'X-API-Key': KEY}, json={'url': share_text})
print(r.json()['data']['download_url'])
```

## 实现原理

### 为什么需要浏览器

抖音详情接口由前端 `bdms` 安全 SDK 拦截并注入 `a_bogus` 签名，页面也不再输出
SSR 数据（`window._SSR_DATA` 为空）。纯 HTTP 请求拿不到数据。

与其逆向签名算法（成本高、随版本失效），不如**让浏览器自己算签名，我们只拦截
它发出的 XHR 响应**——接口变更时无需改代码。

### 解析链路

```
分享文本 → 正则提取链接 → 短链 302 还原出 aweme_id
     → 查缓存（命中直接返回，约 150ms）
     → 未命中则进入并发队列
     → 浏览器打开 www.douyin.com/video/{id}（桌面端 UA）
     → 拦截 /aweme/v1/web/aweme/detail/ 的 JSON
     → 清洗出最高画质地址 → 签发带 HMAC 签名的下载链接
```

关键细节：**必须用桌面端 UA**。移动端 UA 在 headless 下安全 SDK 加载不完整
（`window.secsdk` 为 false），即便生成了签名也会返回「参数不合法」。

### 关于 download_url 的签名

`/dl` 需要把真实地址放在查询串里。如果不签名，任何人都能拿本服务当任意 URL 的
代理。所以这里用 HMAC-SHA256 对 `地址 + 有效期 + 文件名` 签名，做到
**无状态且不可篡改**；同时叠加域名白名单（只放行字节系 CDN）防御 SSRF。

多实例部署时，各实例必须用同一个 `DL_SECRET`，否则签发的链接互不通用。

## 目录结构

```
server/
  index.js      Express 服务与路由
  service.js    编排：缓存 → 队列 → 解析 → 签发链接
  parser.js     浏览器拦截抓取
  extractor.js  detail JSON → 结构化结果
  link.js       分享文本提取、短链还原
  browser.js    Playwright 浏览器池与响应拦截
  config.js     环境变量配置
  auth.js       API Key 鉴权
  cache.js      TTL 缓存
  queue.js      并发队列
  sign.js       HMAC 签名
  errors.js     统一错误码
public/         接口文档与在线调试页
research/       开发用探测脚本
```

## 已知限制

- 只支持单个视频 / 图文作品，**不支持**直播间、用户主页、合集
- 已删除、私密或需登录的作品无法解析
- 触发抖音风控时会失败，稍后重试通常即可
- `direct_url` 有有效期（约数小时），`download_url` 默认 6 小时
- 浏览器是稀缺资源，`MAX_CONCURRENCY` 不宜设得太高

## 声明

仅供学习交流。请尊重视频作者版权，下载内容勿用于商业用途。
