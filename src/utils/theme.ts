import type { ThemePreference } from '../types';

export type ResolvedTheme = 'light' | 'dark';

/**
 * 把偏好解析成实际主题：显式值直取，system 跟随 matchMedia。
 * ⚠️ index.html head 内联脚本内联了同样的解析逻辑（先于首帧防白闪），
 * 改这里必须同步改那边。
 */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 写 <html data-theme> + color-scheme + 移动端浏览器地址栏 theme-color */
export function applyTheme(resolved: ResolvedTheme): void {
  const dark = resolved === 'dark';
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#262624' : '#f5f4ee');
}
