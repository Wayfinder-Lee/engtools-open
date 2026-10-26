import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ThemePreference } from '../types';
import { loadThemePreference, saveThemePreference } from '../utils/storage';
import { applyTheme, resolveTheme, systemPrefersDark } from '../utils/theme';
import './ThemeToggle.css';

const OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  {
    value: 'light',
    label: '浅色',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: '深色',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
      </svg>
    ),
  },
  {
    value: 'system',
    label: '跟随系统',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M12 4h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7Z" fill="currentColor" stroke="none" opacity=".35" />
        <path d="M12 17v4M8.5 21h7" />
      </svg>
    ),
  },
];

/** 亮色 / 深色 / 跟随系统 三态分段控件（视觉语言与 header 的学段切换一致） */
export default function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>(loadThemePreference);

  // system 模式下系统切换亮暗要实时跟随；显式模式忽略 matchMedia
  useEffect(() => {
    applyTheme(resolveTheme(pref, systemPrefersDark()));
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(resolveTheme('system', mq.matches));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const select = useCallback((p: ThemePreference) => {
    setPref(p);
    saveThemePreference(p);
  }, []);

  return (
    <div className="theme-switch" role="group" aria-label="主题切换">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          className={`theme-btn ${pref === opt.value ? 'active' : ''}`}
          onClick={() => select(opt.value)}
          title={opt.label}
          aria-label={opt.label}
          aria-pressed={pref === opt.value}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  );
}
