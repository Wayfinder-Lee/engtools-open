import { request } from '../services/api';

/**
 * m-upload 手机端接口。会话 JWT 放在请求体 session 字段（不放 Authorization 头，
 * 与桌面端 Bearer 登录态区分开）。二维码 token 由桌面端生成，进 URL ?t=。
 */

export interface MuTaskView {
  label: string;
  tool: string;
  photoCount: number;
  expiresAt: number;
  quota: number;
  maxPhotos: number;
}

/** claim / verify-session 共用的响应体（不含缩略图——二维码是投影公开物）。 */
export interface MuTaskPayload {
  session: string | null;
  task: MuTaskView;
  photoIds: { photoId: string; seq: number }[];
}

export interface MuClaimResult extends MuTaskPayload {
  session: string;
  expiresIn: number;
}

export interface MuUploadResult {
  seq: number;
  replaced: boolean;
  photoCount: number;
  quota: number;
  maxPhotos: number;
}

/** 扫码绑定设备；成功后拿到会话与已传照片对账清单。 */
export function apiMuClaim(token: string, deviceId: string): Promise<MuClaimResult> {
  return request<MuClaimResult>('/api/m/claim', { body: { token, deviceId } });
}

/** 断线恢复 / 对账。失败时 err.status 401=会话无效，409 + state=任务终态。 */
export function apiMuVerifySession(session: string): Promise<MuTaskPayload> {
  return request<MuTaskPayload>('/api/m/verify-session', { body: { session } });
}

/** 上传一张照片（dataUrl 为压缩后 JPEG）。 */
export function apiMuUpload(session: string, params: {
  photoId: string;
  dataUrl: string;
  w: number;
  h: number;
  size: number;
  quality?: { blur: number; bright: number };
  thumb?: string;
}): Promise<MuUploadResult> {
  return request<MuUploadResult>('/api/m/upload', {
    body: { session, ...params },
  });
}
