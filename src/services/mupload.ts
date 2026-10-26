import { request, type ApiError } from './api';
import { getToken } from '../utils/session';

/**
 * 扫码拍照上传 · 桌面端接口（Bearer 登录态）。手机端在 src/m/api.ts（会话放 body）。
 * 任务协议带 tool 字段预留；v1 只有 'handwriting'（个性化学案）。
 */

/** 统一带登录态；未登录时 request 走 401 → 面板提示。 */
function auth(): { token: string } {
  return { token: getToken() || '' };
}

export interface MuDesktopTask {
  taskId: string;
  label: string;
  tool: string;
  createdAt: number;
  expiresAt: number;
  closed: boolean;
  photoCount: number;
}

export interface MuPhotoMeta {
  photoId: string;
  seq: number;
  uploadedAt: number;
  complete: boolean;
  chunkCount: number;
  size: number;
  w: number;
  h: number;
  blur: number;
  bright: number;
  imported: boolean;
  /** 增量协议：仅新到行携带（一次性进内存缓存） */
  thumb?: string;
}

export interface MuCreateResult {
  taskId: string;
  token: string;
  expiresIn: number;
  task: MuDesktopTask;
  quota: number;
}

export interface MuPollResult {
  state: 'active' | 'expired' | 'closed';
  task?: MuDesktopTask;
  photos?: MuPhotoMeta[];
}

export interface MuTokenResult {
  token: string;
  expiresIn: number;
}

/** 建任务。已有进行中任务 → 抛 409（err.data = { existingTaskId, photoCount, unimportedCount }）。 */
export function createMuTask(label: string, force = false): Promise<MuCreateResult> {
  return request<MuCreateResult>('/api/m/tasks', { body: { label, force }, ...auth() });
}

/** 增量轮询：photos 全量元数据，thumb 只随 seq>since 的行下发。 */
export function getMuTask(tid: string, since: number): Promise<MuPollResult> {
  return request<MuPollResult>(`/api/m/task?tid=${encodeURIComponent(tid)}&since=${since}`, { method: 'GET', ...auth() });
}

/** 非破坏性重发二维码（同一 tokenSeq；15 分钟倒计时归零后续期用）。 */
export function getMuToken(tid: string): Promise<MuTokenResult> {
  return request<MuTokenResult>('/api/m/token', { body: { tid }, ...auth() });
}

/** 取整图 dataURL（识别用；暂存于服务端 24h 内）。 */
export function getMuPhotoData(tid: string, photoId: string): Promise<{ photoId: string; dataUrl: string }> {
  return request<{ photoId: string; dataUrl: string }>('/api/m/photo-data', { body: { tid, photoId }, ...auth() });
}

export function deleteMuPhoto(tid: string, photoId: string): Promise<{ ok: true; photoCount: number }> {
  return request<{ ok: true; photoCount: number }>('/api/m/photo-delete', { body: { tid, photoId }, ...auth() });
}

/** 识别成功打标（防重复导入重复扣费）。 */
export function markMuPhotosImported(tid: string, photoIds: string[]): Promise<{ ok: true; imported: number }> {
  return request<{ ok: true; imported: number }>('/api/m/photos-imported', { body: { tid, photoIds }, ...auth() });
}

/** 完成并清理：closed=true + 照片即焚。有未导入照片 → 409（err.data.unimportedCount）。 */
export function closeMuTask(tid: string, force = false): Promise<{ ok: true; deleted: number }> {
  return request<{ ok: true; deleted: number }>('/api/m/close', { body: { tid, force }, ...auth() });
}

/** 409 响应体（建任务冲突 / close 有未识别）。 */
export function muConflictData(err: unknown): { existingTaskId?: string; photoCount?: number; unimportedCount?: number } {
  return (err as ApiError)?.data || {};
}
