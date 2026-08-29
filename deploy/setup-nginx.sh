#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 给解析服务绑定对外域名（Nginx 反向代理）
#
# 用法：
#   bash deploy/setup-nginx.sh api.example.com
#   bash deploy/setup-nginx.sh api.example.com --no-reload   # 只生成配置不重载
#
# 前置条件：
#   1. 域名已解析到本服务器公网 IP（用 nslookup 域名 验证）
#   2. 宝塔里已创建该站点并申请过 Let's Encrypt 证书
#   3. 服务器安全组 / 防火墙已放行 80、443
#
# 注意：如果域名还没解析到本机，Let's Encrypt 会签发失败，
#       证书文件不存在时本脚本会直接停下并给出指引，不会写出坏配置。
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${1:-}"
NO_RELOAD="${2:-}"

if [ -z "${DOMAIN}" ]; then
  echo "用法: bash $0 <域名> [--no-reload]"
  echo "示例: bash $0 api.example.com"
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { echo "  $*"; }
warn() { echo "  [!] $*"; }
die()  { echo "  [x] $*" >&2; exit 1; }

# ---------- 定位 Nginx ----------
if [ -d /www/server/panel/vhost/nginx ]; then
  PANEL=baota
  VHOST_DIR=/www/server/panel/vhost/nginx
  CERT_DIR=/www/server/panel/vhost/cert
  WEBROOT="/www/wwwroot/${DOMAIN}"
  NGINX_BIN=/www/server/nginx/sbin/nginx
  [ -x "${NGINX_BIN}" ] || NGINX_BIN="$(command -v nginx || true)"
elif [ -d /etc/nginx/conf.d ]; then
  PANEL=generic
  VHOST_DIR=/etc/nginx/conf.d
  CERT_DIR=/etc/letsencrypt/live
  WEBROOT="/var/www/${DOMAIN}"
  NGINX_BIN="$(command -v nginx || true)"
else
  die "没找到 Nginx 配置目录，本脚本支持宝塔（/www/server/panel）和标准 nginx（/etc/nginx/conf.d）"
fi

[ -n "${NGINX_BIN}" ] || die "没找到 nginx 可执行文件"

log "环境: ${PANEL}"
log "配置目录: ${VHOST_DIR}"

# ---------- 检查证书 ----------
CERT="${CERT_DIR}/${DOMAIN}/fullchain.pem"
KEY="${CERT_DIR}/${DOMAIN}/privkey.pem"

if [ ! -f "${CERT}" ] || [ ! -f "${KEY}" ]; then
  echo ""
  warn "证书文件不存在："
  warn "  ${CERT}"
  warn "  ${KEY}"
  echo ""
  echo "  请先在宝塔里：网站 → ${DOMAIN} → SSL → Let's Encrypt → 申请"
  echo "  （申请前需确认域名已解析到本机公网 IP，且 80 端口可访问）"
  echo ""
  echo "  域名解析可以先验证："
  echo "    nslookup ${DOMAIN}"
  echo "    curl ifconfig.me        # 对比是否为本机公网 IP"
  echo ""
  exit 1
fi
log "证书已就绪: ${CERT}"

# ---------- 生成配置 ----------
CONF="${VHOST_DIR}/${DOMAIN}.conf"
TEMPLATE="${APP_DIR}/deploy/nginx-douyin-parser.conf"

[ -f "${TEMPLATE}" ] || die "缺少模板文件: ${TEMPLATE}"

if [ -f "${CONF}" ]; then
  BACKUP="${CONF}.bak.$(date +%Y%m%d%H%M%S)"
  cp "${CONF}" "${BACKUP}"
  warn "已存在同名配置，原文件备份为: ${BACKUP}"
fi

# 宝塔面板的模板里 webroot 是 /www/wwwroot/__DOMAIN__，
# 若该目录不存在（比如站点根目录是别的名字），退回一个真实存在的目录
if [ ! -d "${WEBROOT}" ]; then
  for cand in "${APP_DIR}/public" /www/wwwroot/default /var/www/html; do
    if [ -d "${cand}" ]; then WEBROOT="${cand}"; break; fi
  done
fi

# 先把占位符替换成域名，再把 acme 验证目录改成真实存在的路径
sed -e "s|__DOMAIN__|${DOMAIN}|g" "${TEMPLATE}" > "${CONF}"
sed -i "s|root /www/wwwroot/${DOMAIN};|root ${WEBROOT};|g" "${CONF}"

log "已生成配置: ${CONF}"

# ---------- 语法检查 ----------
if ! "${NGINX_BIN}" -t 2>&1 | tail -5; then
  echo ""
  die "Nginx 配置检查未通过，已保留新配置但**没有**重载。"
fi
log "Nginx 配置检查通过"

# ---------- 重载 ----------
if [ "${NO_RELOAD}" = "--no-reload" ]; then
  log "按参数要求跳过重载。生效时手动执行: ${NGINX_BIN} -s reload"
else
  "${NGINX_BIN}" -s reload && log "Nginx 已重载"
fi

# ---------- 提示收尾 ----------
echo ""
echo "--------------------------------------------"
echo " 反代已配置: https://${DOMAIN} -> 127.0.0.1:5173"
echo ""
echo " 还有一步：让服务知道自己的对外地址，否则返回的"
echo " download_url 会带内网地址，外部打不开。执行："
echo ""
echo "   cd ${APP_DIR}"
echo "   grep -q '^PUBLIC_BASE_URL=' .env \\"
echo "     && sed -i 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://${DOMAIN}|' .env \\"
echo "     || echo 'PUBLIC_BASE_URL=https://${DOMAIN}' >> .env"
echo "   grep -q '^HOST=' .env \\"
echo "     && sed -i 's|^HOST=.*|HOST=127.0.0.1|' .env \\"
echo "     || echo 'HOST=127.0.0.1' >> .env"
echo "   systemctl restart douyin-parser"
echo ""
echo " 验证："
echo "   curl https://${DOMAIN}/healthz"
echo "--------------------------------------------"
