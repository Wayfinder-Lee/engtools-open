import type { ApiConfig, Stage, ThemePreference } from '../types';

// ─── API 配置持久化 ──────────────────────────────────

const API_CONFIG_KEY = 'vocab_builder_api_config';

const DEFAULT_CONFIG: ApiConfig = {
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  apiKey: '',
};

export function loadApiConfig(): ApiConfig {
  try {
    const raw = localStorage.getItem(API_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ApiConfig>;
      return {
        endpoint: parsed.endpoint || DEFAULT_CONFIG.endpoint,
        apiKey: parsed.apiKey || DEFAULT_CONFIG.apiKey,
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function saveApiConfig(config: ApiConfig): void {
  localStorage.setItem(API_CONFIG_KEY, JSON.stringify(config));
}

export function clearApiConfig(): void {
  localStorage.removeItem(API_CONFIG_KEY);
}

// ─── 学段持久化 ──────────────────────────────────

const STAGE_KEY = 'vocab_builder_stage';

export function loadStage(): Stage {
  return localStorage.getItem(STAGE_KEY) === 'junior' ? 'junior' : 'senior';
}

export function saveStage(stage: Stage): void {
  localStorage.setItem(STAGE_KEY, stage);
}

// ─── 主题偏好持久化（index.html head 内联脚本读同一个 key，取值逻辑保持一致） ──────────

const THEME_KEY = 'vocab_builder_theme';

export function loadThemePreference(): ThemePreference {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function saveThemePreference(pref: ThemePreference): void {
  localStorage.setItem(THEME_KEY, pref);
}
