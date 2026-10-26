import { SITE } from '../data/site';

/**
 * 最小埋点（W1）：只上报「事件名 + 短标签」，用于转化漏斗验收
 * （落地曝光 → 注册 → 兑换 → 首生成 → 首导出）与错误分布。
 *
 * 铁律：任何用户内容（题目、试卷原文、学案、学生姓名、邮箱）绝不进事件字段；
 * JS 错误只上报错误类型名，不上报 message（message 可能携带 LLM 回包片段）。
 *
 * 通道：百度统计（与百度站长同账号体系）。SITE.baiduTongjiId 为空时全部空操作，
 * 开发模式打印到 console 便于核对埋点位置。
 */

declare global {
  interface Window {
    _hmt?: unknown[][];
  }
}

let scriptInjected = false;

function ensureScript() {
  if (scriptInjected || !SITE.baiduTongjiId) return;
  scriptInjected = true;
  window._hmt = window._hmt || [];
  const s = document.createElement('script');
  s.src = `https://hm.baidu.com/hm.js?${SITE.baiduTongjiId}`;
  s.async = true;
  document.head.appendChild(s);
}

/** 上报一个事件。label 只允许枚举值/短代号（如 'vocab'、'login'）。 */
export function track(event: string, label?: string) {
  if (import.meta.env.DEV) {
    console.debug('[track]', event, label ?? '');
    return;
  }
  if (!SITE.baiduTongjiId) return;
  ensureScript();
  try {
    window._hmt?.push(['_trackEvent', 'engtools', event, label ?? '']);
  } catch {
    // 统计失败不影响主流程
  }
}

let installed = false;

/** 全局 JS 错误轻量上报：只取错误类型名，不取 message（防用户内容泄漏）。 */
export function installErrorReport() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => {
    track('js_error', e.error?.name || e.constructor?.name || 'Error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    track('promise_rejection', e.reason?.name || 'Unknown');
  });
}
