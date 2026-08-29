#!/usr/bin/env bash
#
# 生产环境增量更新：拉代码 -> 按需装依赖 -> 平滑重启 -> 健康检查
#
# 由 GitHub Actions 通过 SSH 调用，也可以手动执行：
#   bash deploy/update.sh
#
# 重要：本脚本不会触碰 .env 与 .data/。
#   .env           含 API Keys，每个环境独立
#   .data/dl_secret  下载链接签名密钥，换了会导致已签发的链接全部失效
# 这两个都不在 git 跟踪范围内，git pull 不会覆盖它们。
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/douyin-parser}"
SERVICE="${SERVICE_NAME:-douyin-parser}"
BRANCH="${BRANCH:-main}"
HEALTH_PORT="${PORT:-$(grep -E '^PORT=' "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo 5173)}"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "[$(date '+%H:%M:%S')] 失败: $*" >&2; exit 1; }

[ -d "${APP_DIR}/.git" ] || fail "${APP_DIR} 不是 git 仓库，请先执行 deploy/install-centos.sh"
cd "${APP_DIR}"

# ---------- 记录当前版本，便于回滚 ----------
BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "当前版本: ${BEFORE}"

# ---------- 拉取代码 ----------
log "拉取 ${BRANCH} 最新代码 …"
git fetch --quiet origin "${BRANCH}" || fail "git fetch 失败（检查网络与仓库权限）"
git checkout --quiet "${BRANCH}" 2>/dev/null || true
git pull --ff-only --quiet origin "${BRANCH}" || fail "git pull 失败（本地可能有未提交的改动）"

AFTER="$(git rev-parse --short HEAD)"
if [ "${BEFORE}" = "${AFTER}" ]; then
  log "代码无变化，仍为 ${AFTER}"
else
  log "已更新: ${BEFORE} -> ${AFTER}"
fi

# ---------- 依赖：仅在 lock 文件变化时才装 ----------
if [ -f package-lock.json ]; then
  if ! git diff --quiet "${BEFORE}" "${AFTER}" -- package-lock.json 2>/dev/null || \
     [ ! -d node_modules ]; then
    log "依赖有变化，执行 npm install …"
    npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
  else
    log "依赖无变化，跳过 npm install"
  fi
fi

# ---------- 语法自检：有问题就别重启，保持旧版本运行 ----------
log "语法自检 …"
for f in server/*.js; do
  node --check "${f}" || fail "${f} 语法错误，中止部署（服务仍运行旧版本）"
done
log "语法检查通过"

# ---------- 浏览器内核检查 ----------
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -f "${APP_DIR}/.env" ]; then
  set -a; . "${APP_DIR}/.env"; set +a
fi

# ---------- 重启 ----------
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^${SERVICE}.service"; then
  log "重启服务 ${SERVICE} …"
  systemctl restart "${SERVICE}" || fail "重启失败"
  sleep 3
  if systemctl is-active --quiet "${SERVICE}"; then
    log "服务运行正常"
  else
    fail "服务未处于运行状态，请检查：journalctl -u ${SERVICE} -n 50"
  fi
else
  log "未检测到 systemd 服务，跳过重启（请手动重启进程）"
fi

# ---------- 健康检查 ----------
log "健康检查 http://127.0.0.1:${HEALTH_PORT}/healthz …"
for i in 1 2 3 4 5; do
  if curl -fsS -m 5 "http://127.0.0.1:${HEALTH_PORT}/healthz" >/dev/null 2>&1; then
    log "健康检查通过，部署完成 (${AFTER})"
    exit 0
  fi
  sleep 2
done

fail "健康检查未通过。回滚命令：git reset --hard ${BEFORE} && systemctl restart ${SERVICE}"
