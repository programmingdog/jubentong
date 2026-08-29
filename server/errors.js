'use strict';

/**
 * 统一错误类型与错误码。
 * 对外接口一律用 code + HTTP status 表达，方便调用方程序化处理。
 */

const ERRORS = {
  INVALID_REQUEST: { status: 400, message: '请求参数有误' },
  UNAUTHORIZED: { status: 401, message: '缺少或无效的 API Key' },
  FORBIDDEN: { status: 403, message: '无权访问' },
  LINK_NOT_FOUND: { status: 400, message: '未在文本中找到抖音链接' },
  UNSUPPORTED_LINK: { status: 400, message: '链接类型不支持' },
  RESOLVE_FAILED: { status: 502, message: '短链还原失败' },
  NOT_FOUND: { status: 404, message: '视频不存在或无权访问' },
  PARSE_FAILED: { status: 502, message: '视频数据解析失败' },
  QUEUE_TIMEOUT: { status: 503, message: '服务器繁忙，请稍后重试' },
  TIMEOUT: { status: 504, message: '解析超时' },
  NO_BROWSER: { status: 500, message: '浏览器内核不可用' },
  INTERNAL: { status: 500, message: '服务内部错误' },
};

class ApiError extends Error {
  constructor(code, message, detail) {
    const preset = ERRORS[code] || ERRORS.INTERNAL;
    super(message || preset.message);
    this.name = 'ApiError';
    this.code = ERRORS[code] ? code : 'INTERNAL';
    this.status = preset.status;
    this.detail = detail || null;
  }

  toJSON() {
    const out = { ok: false, code: this.code, message: this.message };
    if (this.detail) out.detail = this.detail;
    return out;
  }
}

/** 把任意异常归一成 ApiError */
function wrap(e) {
  if (e instanceof ApiError) return e;
  const msg = (e && e.message) || String(e);

  // 浏览器未安装时，给出可操作的提示
  if (/playwright/i.test(msg) && /未检测到|not found|Executable doesn/i.test(msg)) {
    return new ApiError('NO_BROWSER', '浏览器内核不可用，请安装：npx playwright install chromium', msg);
  }
  if (/超时|timeout/i.test(msg)) {
    return new ApiError('TIMEOUT', msg);
  }
  return new ApiError('INTERNAL', msg);
}

module.exports = { ApiError, wrap, ERRORS };
