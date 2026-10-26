import type { Session } from '../types';

/**
 * 登录会话持久化（localStorage）。
 * 存后端签发的 JWT + 用户邮箱 + 当前额度快照 + 邮箱验证状态。
 * 另含游客模式标记（M6：免注册体验，按 IP 计额度）。
 */

const SESSION_KEY = 'vb_session';
const GUEST_KEY = 'vb_guest_mode';
const GUEST_QUOTA_KEY = 'vb_guest_quota';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.token || !parsed.email) return null;
    return {
      token: parsed.token,
      email: parsed.email,
      quota: typeof parsed.quota === 'number' ? parsed.quota : 0,
      // 旧会话（免验证注册上线前注册的账号）缺省视为已验证
      emailVerified: parsed.emailVerified !== false,
    };
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

/** 供 llm.ts 读取当前 JWT（未登录返回 null）。 */
export function getToken(): string | null {
  return loadSession()?.token ?? null;
}

/** 更新本地存储里的额度快照（登录态不变）；emailVerified 顺带同步 /api/me 的返回。 */
export function updateStoredQuota(quota: number, emailVerified?: boolean): void {
  const s = loadSession();
  if (s) saveSession({ ...s, quota, emailVerified: emailVerified ?? s.emailVerified });
}

// ─── 游客模式（M6）──────────────────────────────────

/** 当前是否处于游客模式（免注册体验，LLM 请求走服务端按 IP 计额度）。 */
export function isGuestMode(): boolean {
  try {
    return localStorage.getItem(GUEST_KEY) === '1';
  } catch {
    return false;
  }
}

export function setGuestMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(GUEST_KEY, '1');
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    // ignore
  }
}

/** 退出游客模式并回到落地页（注册引导用）。 */
export function exitGuestMode(): void {
  setGuestMode(false);
  window.location.reload();
}

/** 游客余额快照（顶栏 chip 用，可能滞后于服务端）。 */
export function loadGuestQuota(): number | null {
  try {
    const raw = localStorage.getItem(GUEST_QUOTA_KEY);
    return raw == null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function saveGuestQuota(quota: number): void {
  try {
    localStorage.setItem(GUEST_QUOTA_KEY, String(quota));
  } catch {
    // ignore
  }
}
