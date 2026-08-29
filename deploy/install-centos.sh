#!/usr/bin/env bash
#
# 抖音分享链接解析服务 —— CentOS / RHEL / Rocky / Alma 部署脚本
#
# 用法（需 root）：
#   curl -fsSL <本脚本地址> | bash
#   或： bash install-centos.sh
#
set -euo pipefail

APP_NAME="douyin-parser"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
NODE_MAJOR="${NODE_MAJOR:-20}"
# 浏览器内核放共享位置：服务以普通用户运行，不能依赖 root 的 ~/.cache
BROWSERS_PATH="${BROWSERS_PATH:-/opt/playwright-browsers}"
export PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_PATH}"

log()  { echo -e "\033[32m[INFO]\033[0m $*"; }
warn() { echo -e "\033[33m[WARN]\033[0m $*"; }
err()  { echo -e "\033[31m[ERR ]\033[0m $*"; }

[ "$(id -u)" -eq 0 ] || { err "请用 root 执行（安装系统依赖需要权限）"; exit 1; }

# ---------- 1. 识别发行版 ----------
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VER="${VERSION_ID:-unknown}"
else
  err "无法识别发行版（缺少 /etc/os-release）"; exit 1
fi

log "发行版: ${PRETTY_NAME:-${OS_ID} ${OS_VER}}"

case "${OS_ID}" in
  centos|rhel|rocky|almalinux|ol|fedora) ;;
  *) warn "本脚本面向 RHEL 系发行版，当前为 ${OS_ID}，继续但可能不匹配";;
esac

# ---------- 2. 版本检查 ----------
MAJOR_VER="${OS_VER%%.*}"
if [ "${OS_ID}" = "centos" ] && [ "${MAJOR_VER}" = "7" ]; then
  warn "=============================================================="
  warn " 检测到 CentOS 7 —— 不推荐"
  warn " CentOS 7 已于 2024-06-30 停止维护（EOL），且 glibc 2.17 /"
  warn " libstdc++ GLIBCXX_3.4.19 过低，新版 Chromium 无法直接运行。"
  warn " 建议改用 Rocky Linux 8/9、AlmaLinux 8/9 或 CentOS Stream 9。"
  warn ""
  warn " 若必须留在 CentOS 7，可选方案："
  warn "   1) 降级 playwright 到较旧版本（功能与安全更新滞后）"
  warn "   2) 安装 devtoolset 并注入 LD_LIBRARY_PATH（有污染风险）"
  warn "   3) 改用 Docker 镜像（推荐）"
  warn "=============================================================="
  read -r -p "仍然继续？[y/N] " yn
  case "${yn}" in
    [yY]*) warn "继续安装，但 Chromium 很可能启动失败";;
    *) err "已取消"; exit 1;;
  esac
fi

# ---------- 3. 包管理器与基础工具 ----------
if command -v dnf >/dev/null 2>&1; then
  PKG=dnf
elif command -v yum >/dev/null 2>&1; then
  PKG=yum
else
  err "找不到 dnf 或 yum"; exit 1
fi
log "包管理器: ${PKG}"

${PKG} install -y -q curl wget tar gzip unzip which >/dev/null 2>&1 || true

# ---------- 4. Node.js ----------
install_node() {
  log "安装 Node.js ${NODE_MAJOR}.x …"
  if command -v dnf >/dev/null 2>&1; then
    dnf module reset -y nodejs >/dev/null 2>&1 || true
    dnf module enable -y "nodejs:${NODE_MAJOR}" >/dev/null 2>&1 || true
    if dnf install -y nodejs >/dev/null 2>&1; then return 0; fi
  fi
  # 回退到 NodeSource
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  ${PKG} install -y nodejs >/dev/null 2>&1
}

if command -v node >/dev/null 2>&1; then
  CUR_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${CUR_MAJOR}" -ge 18 ] 2>/dev/null; then
    log "Node.js 已安装: $(node -v)"
  else
    warn "Node.js 版本过低 ($(node -v))，重新安装"
    install_node
  fi
else
  install_node
fi
command -v node >/dev/null 2>&1 || { err "Node.js 安装失败，请手动安装"; exit 1; }
log "Node: $(node -v)  npm: $(npm -v)"

# ---------- 5. 项目文件 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "${APP_DIR}/package.json" ]; then
  log "部署到 ${APP_DIR} …"
  mkdir -p "${APP_DIR}"
  if [ -f "${SCRIPT_DIR}/package.json" ] && [ "${SCRIPT_DIR}" != "${APP_DIR}" ]; then
    cp -r "${SCRIPT_DIR}/." "${APP_DIR}/"
  else
    err "${APP_DIR} 下没有 package.json，请先上传项目代码"; exit 1
  fi
else
  log "使用已存在的项目目录 ${APP_DIR}"
fi

# 代码位置与安装目标不一致时明确提示，避免装出两份代码
if [ "${SCRIPT_DIR}" != "${APP_DIR}" ] && [ "${APP_DIR}" = "/opt/${APP_NAME}" ]; then
  warn "代码在 ${SCRIPT_DIR}，但默认会安装到 ${APP_DIR}"
  warn "若想直接就地安装，请改用：APP_DIR=${SCRIPT_DIR} bash $0"
fi

cd "${APP_DIR}"

# 运行时数据目录必须预先创建。
# 原因：service 里配了 ProtectSystem=strict + ReadWritePaths=<APP_DIR>/.data，
# 而 .data 本来是 Node 首次运行时才建的 —— systemd 在启动进程之前就要建立
# mount namespace，目录不存在会直接失败：status=226/NAMESPACE
mkdir -p "${APP_DIR}/.data"
log "已创建运行时数据目录: ${APP_DIR}/.data"

# ---------- 6. npm 依赖 ----------
log "安装 npm 依赖 …"
npm config set registry https://registry.npmmirror.com >/dev/null 2>&1 || true
npm install --omit=dev 2>&1 | tail -3

# ---------- 7. Chromium 系统依赖 ----------
log "安装 Chromium 系统依赖（可能需要几分钟）…"
export PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.npmmirror.com/binaries/playwright}"

# 优先用 Playwright 自带的依赖安装器（会按发行版适配）
if ! npx playwright install-deps chromium 2>&1 | tail -5; then
  warn "install-deps 失败，回退到手动安装常用依赖"
  ${PKG} install -y \
    atk at-spi2-atk cups-libs libdrm libXcomposite libXdamage libXfixes \
    libXrandr libxkbcommon mesa-libgbm pango cairo alsa-lib \
    nss nspr dbus-glib freetype fontconfig liberation-fonts 2>&1 | tail -5 || true
fi

# ---------- 8. 下载 Chromium 内核 ----------
log "下载 Chromium 内核到 ${BROWSERS_PATH} …"
mkdir -p "${BROWSERS_PATH}"
npx playwright install chromium 2>&1 | tail -5
chmod -R a+rX "${BROWSERS_PATH}"

# ---------- 9. 环境配置 ----------
if [ ! -f "${APP_DIR}/.env" ]; then
  if [ -f "${APP_DIR}/.env.example" ]; then
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
    # 生成一个随机 Key
    RND="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
    sed -i "s|^API_KEYS=.*|API_KEYS=default:${RND}|" "${APP_DIR}/.env"
    sed -i "s|^DL_SECRET=.*|DL_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)|" "${APP_DIR}/.env"
    # 浏览器内核路径写入 .env，保证手动启动时也能找到
    grep -q '^PLAYWRIGHT_BROWSERS_PATH=' "${APP_DIR}/.env" \
      && sed -i "s|^PLAYWRIGHT_BROWSERS_PATH=.*|PLAYWRIGHT_BROWSERS_PATH=${BROWSERS_PATH}|" "${APP_DIR}/.env" \
      || echo "PLAYWRIGHT_BROWSERS_PATH=${BROWSERS_PATH}" >> "${APP_DIR}/.env"
    chmod 600 "${APP_DIR}/.env"
    log "已生成 .env，默认 API Key: ${RND}"
  fi
else
  log ".env 已存在，跳过生成"
  grep -q '^PLAYWRIGHT_BROWSERS_PATH=' "${APP_DIR}/.env" \
    || echo "PLAYWRIGHT_BROWSERS_PATH=${BROWSERS_PATH}" >> "${APP_DIR}/.env"
fi

# ---------- 10. 防火墙 ----------
if command -v firewall-cmd >/dev/null 2>&1; then
  PORT="$(grep -E '^PORT=' "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo 5173)"
  if systemctl is-active --quiet firewalld; then
    log "开放防火墙端口 ${PORT}"
    firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi
fi

# ---------- 11. SELinux 提示 ----------
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  warn "SELinux 处于 Enforcing 模式，可能阻止 Chromium 启动。"
  warn "若服务报浏览器启动失败，可尝试："
  warn "   setsebool -P httpd_can_network_connect 1"
  warn "   或查看 /var/log/audit/audit.log 中的 avc 拒绝记录"
fi

# ---------- 12. systemd ----------
if command -v systemctl >/dev/null 2>&1; then
  log "安装 systemd 服务 …"
  id -u "${APP_NAME}" >/dev/null 2>&1 || useradd -r -s /sbin/nologin "${APP_NAME}" || true
  chown -R "${APP_NAME}:${APP_NAME}" "${APP_DIR}" || true

  # 关键：目录属主已改成 APP_NAME，而自动部署通常以 SERVER_USER（多为 root）
  # 身份执行 git pull。属主与执行者不一致时 git 会直接拒绝：
  #   fatal: detected dubious ownership in repository
  # 用 --system 配置对全部用户生效，避免后续自动部署在此处失败。
  git config --system --add safe.directory "${APP_DIR}" 2>/dev/null || true
  log "已放行 git 目录所有权检查: ${APP_DIR}"

  sed -e "s|__APP_DIR__|${APP_DIR}|g" \
      -e "s|__USER__|${APP_NAME}|g" \
      -e "s|__NODE__|$(command -v node)|g" \
      -e "s|__BROWSERS_PATH__|${BROWSERS_PATH}|g" \
      "${APP_DIR}/deploy/${APP_NAME}.service" > "/etc/systemd/system/${APP_NAME}.service"

  systemctl daemon-reload
  systemctl enable "${APP_NAME}" >/dev/null 2>&1
  systemctl restart "${APP_NAME}"
  sleep 3
  systemctl --no-pager status "${APP_NAME}" | head -12 || true
fi

log "=============================================="
log "部署完成。验证："
log "  curl http://127.0.0.1:$(grep -E '^PORT=' "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo 5173)/healthz"
log "  journalctl -u ${APP_NAME} -f      # 查看日志"
log ""
log "若要用域名对外提供服务（需先完成域名解析 + 申请 SSL 证书）："
log "  bash ${APP_DIR}/deploy/setup-nginx.sh api.你的域名.com"
log ""
log "套上 Nginx 之后，建议在 .env 里加两行并重启服务，"
log "让公网无法绕过 Nginx 直连本机端口、且返回的下载链接是域名："
log "  HOST=127.0.0.1"
log "  PUBLIC_BASE_URL=https://api.你的域名.com"
log "=============================================="
