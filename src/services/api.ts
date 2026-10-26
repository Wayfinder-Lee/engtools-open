import type { Session } from '../types';
import { getToken } from '../utils/session';

/** 后端基址（公网地址），来自构建环境变量 VITE_API_BASE。 */
export const API_BASE = import.meta.env.VITE_API_BASE || '';

export interface ApiError extends Error {
  status?: number;
  /** 服务端错误响应体（如 { error, state, kind }），调用方按 state/kind 分流。 */
  data?: any;
}

/** 通用 JSON 请求助手。 */
export async function request<T>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const { method = 'POST', body, token } = options;
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('网络错误，无法连接服务器，请稍后重试');
  }

  const text = await resp.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!resp.ok) {
    const err: ApiError = new Error(data.error || `请求失败 (${resp.status})`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

/**
 * 二进制响应请求（听力 TTS）：成功（content-type 为 audio/*）返回 Blob，
 * 失败解析 JSON 错误信息后抛出。
 */
export async function requestAudio(path: string, body: unknown, token: string): Promise<Blob> {
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('网络错误，无法连接服务器，请稍后重试');
  }
  const contentType = resp.headers.get('content-type') || '';
  if (resp.ok && contentType.startsWith('audio/')) return resp.blob();
  let message = `服务器错误（HTTP ${resp.status}）`;
  try {
    const data = await resp.json();
    if (data && typeof data.error === 'string') message = data.error;
  } catch { /* 非 JSON 错误体，保留 HTTP 状态提示 */ }
  throw new Error(message);
}

/** 注册：免验证直接建号（游客级额度），带 verifyCode 走旧验证流程（兼容）。 */
export async function apiRegister(email: string, password: string, verifyCode?: string): Promise<Session> {
  return request<Session>('/api/auth/register', { body: verifyCode ? { email, password, verifyCode } : { email, password } });
}

/** 登录：成功返回登录会话。 */
export async function apiLogin(email: string, password: string): Promise<Session> {
  return request<Session>('/api/auth/login', { body: { email, password } });
}

/** 查询当前用户额度与邮箱验证状态。 */
export async function apiMe(token: string): Promise<{ email: string; quota: number; emailVerified?: boolean }> {
  return request<{ email: string; quota: number; emailVerified?: boolean }>('/api/me', { method: 'GET', token });
}

/** M6：提交邮箱验证码，验证后补发正式赠送额度。 */
export async function apiVerifyEmail(token: string, verifyCode: string): Promise<{ ok: boolean; quota: number; alreadyVerified?: boolean }> {
  return request<{ ok: boolean; quota: number; alreadyVerified?: boolean }>('/api/auth/verify', { body: { verifyCode }, token });
}

/** M6：游客额度查询（服务端按调用方 IP 计）。 */
export async function apiGuestMe(): Promise<{ quota: number; total: number }> {
  return request<{ quota: number; total: number }>('/api/guest/me', { method: 'GET' });
}

/** 发送邮箱验证码。purpose='register'|'reset'。返回 { ok, sent, devCode? }（devCode 仅本地模式返回）。 */
export async function apiSendVerifyCode(email: string, purpose?: string): Promise<{ ok: boolean; sent: boolean; devCode?: string }> {
  return request<{ ok: boolean; sent: boolean; devCode?: string }>('/api/auth/send-verify-code', { body: { email, purpose } });
}

/** 重置密码：email + 验证码 + 新密码。 */
export async function apiResetPassword(email: string, verifyCode: string, newPassword: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/auth/reset-password', { body: { email, verifyCode, newPassword } });
}

/** 支付 1 credit 解除今日自定义单词限制。 */
export async function apiUnlockWordLimit(token: string): Promise<{ ok: boolean; quota: number }> {
  return request<{ ok: boolean; quota: number }>('/api/unlock-word-limit', { token });
}

/** 兑换码充值，返回本次充值面值与充值后的余额。 */
export async function apiRedeem(token: string, code: string): Promise<{ credits: number; quota: number }> {
  return request<{ credits: number; quota: number }>('/api/redeem', { body: { code }, token });
}

/** 注销账号（PIPL 用户权利）：删除服务端账号记录。 */
export async function apiDeleteAccount(token: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/account', { method: 'DELETE', token });
}

/** 「我的账户」：修改密码（验当前密码）。 */
export async function apiChangePassword(token: string, oldPassword: string, newPassword: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/account/password', { body: { oldPassword, newPassword }, token });
}

// ─── 使用统计（看板 / 额度明细） ───────────────────

/** 使用流水一行（服务端 usage_log 投影）。 */
export interface UsageRow {
  sk: string;
  kind: 'llm' | 'redeem' | 'grant' | 'unlock' | 'stat';
  op: string;
  cost: number;
  gain: number;
  count?: number | null;
  meta?: string;
  createdAt: number;
}

/** 看板聚合（服务端按上海日/月分桶）。 */
export interface UsageSummary {
  quota: number;
  totalSpent: number;
  totalGained: number;
  monthSpent: number;
  ops: Record<string, number>;
  statTotals: Record<string, number>;
  daily: Record<string, number>;
  partial: boolean;
}

/** 看板聚合：额度总览 + 各 op 次数 + 近 400 天按上海日的消费分布。 */
export async function apiUsageSummary(token: string): Promise<UsageSummary> {
  return request<UsageSummary>('/api/usage/summary', { method: 'GET', token });
}

/** 额度明细分页（时间降序）。type='charge' 只看充值/赠送，'spend' 只看使用。 */
export async function apiUsageLogs(
  token: string,
  opts: { limit?: number; cursor?: string; type?: 'all' | 'charge' | 'spend' } = {},
): Promise<{ rows: UsageRow[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.cursor) q.set('cursor', opts.cursor);
  if (opts.type && opts.type !== 'all') q.set('type', opts.type);
  const qs = q.toString();
  return request(`/api/usage${qs ? `?${qs}` : ''}`, { method: 'GET', token });
}

/**
 * 客户端数量上报（fire-and-forget）：把服务端计费流水中数不出的真实数量
 * （提取单词数、排版份数）报给服务端落 stat 行。无 token（自带 key 用户）直接
 * no-op；任何失败静默吞掉，绝不影响生成主流程。
 */
export function apiReportUsage(op: string, count: number): void {
  const token = getToken();
  if (!token) return;
  void request('/api/usage/report', { body: { op, count }, token }).catch(() => { /* 静默 */ });
}
