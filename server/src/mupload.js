'use strict';

/**
 * 扫码拍照上传（m-upload）的路由层。
 *
 * 桌面端（Bearer = 登录 JWT）：
 *   POST /api/m/tasks            建任务（已有未结束任务 → 409，确认后 force）
 *   GET  /api/m/task?tid=&since= 增量轮询：元数据全量 + 缩略图只带 seq>since
 *   POST /api/m/token            非破坏性重发二维码 token（同一 tokenSeq，15m）
 *   POST /api/m/photo-data       取整图（桌面识别用）
 *   POST /api/m/photo-delete     删一张照片
 *   POST /api/m/photos-imported  识别成功打标（防重复导入重复扣费）
 *   POST /api/m/refresh          刷新二维码 = 换绑：tokenSeq+1 / sess+1 / 解绑设备
 *   POST /api/m/close            完成并清理（有未导入照片时 409，确认后 force）
 *
 * 手机端（免登录）：
 *   POST /api/m/claim            扫码绑定设备 → 会话 JWT
 *   POST /api/m/verify-session   断线恢复 / 对账
 *   POST /api/m/upload           上传一张照片（幂等）
 *
 * 定时清理（平台定时触发器，见 index.js 的检测头）：
 *   handleTimer → sweepExpired
 *
 * ⚠️ 本文件与 mupload-db.js 一起构成可整体摘除的功能模块。
 *
 * Token/会话模型：
 *   二维码 token = JWT {tid, typ:'mupload', ts:tokenSeq}，15m —— 不含老师邮箱
 *   手机会话     = JWT {tid, dev, typ:'msession', sv:sess}，24h —— 上传与恢复都校验
 *                  sv === task.sess，「刷新二维码换绑」才能杀死旧会话
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./tablestore');
const dbm = require('./mupload-db');
const { sendJson, readJsonBody } = require('./http');
const { verifyToken } = require('./auth');

const { incrementDaily, getDailyCount, getDailyFlag, setDailyFlag, dailyKey } = db;

const TOKEN_TTL_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const MAX_PHOTOS = dbm.MAX_PHOTOS;
/** 单张照片 dataURL 字符上限（base64；≈1.05MB 二进制） */
const MAX_DATAURL_CHARS = 1400000;
const MAX_DECODED_BYTES = 1050000;
const PHOTO_ID_RE = /^[a-z0-9]{6,32}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const JPEG_DATAURL_PREFIX = 'data:image/jpeg;base64,';
/** 建任务限流（次/天/老师） */
const MAX_CREATE_PER_DAY = 20;
/** 伪造签名 token 限流（次/天/IP）——只计密码学失败，语义错误不计数 */
const MAX_BAD_TOKEN_PER_DAY = 50;

function shanghaiDateStr(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    const first = fwd.split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

/** 从请求头取出登录 JWT，返回 email；未登录直接回 401 并返回 null。 */
function authenticate(req, res) {
  const email = verifyToken(req.headers.authorization);
  if (!email) {
    sendJson(req, res, 401, { error: '未登录或登录已过期' });
    return null;
  }
  return email;
}

function newId() {
  return crypto.randomBytes(6).toString('hex'); // 12 位 [0-9a-f]
}

// ---------------------------------------------------------------------------
// token / 会话
// ---------------------------------------------------------------------------

/** 签发二维码 token（含当前 tokenSeq，扫码时与任务行比对防旧码）。 */
function signMuToken(taskId, tokenSeq) {
  return jwt.sign({ tid: taskId, typ: 'mupload', ts: tokenSeq }, config.jwtSecret, {
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

/**
 * 校验二维码 token。返回 { ok:true, payload } 或 { ok:false, kind }。
 * kind: 'signature'（密码学失败，计入限流）| 'expired' | 'invalid'（语义错误，不计数）
 */
function verifyMuToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') return { ok: false, kind: 'expired' };
    return { ok: false, kind: 'signature' };
  }
  if (!payload || payload.typ !== 'mupload' || typeof payload.tid !== 'string') {
    return { ok: false, kind: 'invalid' };
  }
  return { ok: true, payload };
}

function signMuSession(taskId, deviceId, sess) {
  return jwt.sign({ tid: taskId, dev: deviceId, typ: 'msession', sv: sess }, config.jwtSecret, {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

/**
 * 校验手机会话。返回 { ok:true, task } 或 { ok:false, kind, state }。
 * state ∈ 'missing'|'closed'|'expired'|'revoked'（sv 与任务 sess 不符 = 已被换绑踢掉）。
 */
async function verifyMuSession(session) {
  let payload;
  try {
    payload = jwt.verify(session, config.jwtSecret);
  } catch {
    return { ok: false, kind: 'invalid' };
  }
  if (!payload || payload.typ !== 'msession' || typeof payload.tid !== 'string') {
    return { ok: false, kind: 'invalid' };
  }
  const task = await dbm.getTaskByIndex(payload.tid);
  const state = taskState(task);
  if (state !== 'active') return { ok: false, kind: 'state', state };
  if ((payload.sv | 0) !== task.sess) return { ok: false, kind: 'state', state: 'revoked' };
  return { ok: true, task };
}

/** 任务对手机端可见的状态。 */
function taskState(task, now = Date.now()) {
  if (!task) return 'missing';
  if (task.closed) return 'closed';
  if ((task.expiresAt || 0) <= now) return 'expired';
  return 'active';
}

/**
 * 桌面端任务归属校验：登录 → 经 index 定位 → owner 必须是本人。
 * 失败时直接回响应并返回 null。
 */
async function requireOwnTask(req, res, tid) {
  const email = authenticate(req, res);
  if (!email) return null;
  if (!tid || !/^[a-z0-9]{6,32}$/.test(tid)) {
    sendJson(req, res, 400, { error: '参数不正确' });
    return null;
  }
  const task = await dbm.getTaskByIndex(tid);
  if (!task || task.ownerEmail !== email) {
    sendJson(req, res, 404, { error: '任务不存在' });
    return null;
  }
  return task;
}

/** 桌面端任务行 → 对前端的投影（不含 ownerEmail）。 */
function taskView(task) {
  return {
    taskId: task.taskId,
    label: task.label,
    tool: task.tool,
    createdAt: task.createdAt,
    expiresAt: task.expiresAt,
    closed: task.closed,
    photoCount: task.photoCount,
  };
}

// ---------------------------------------------------------------------------
// 桌面端接口
// ---------------------------------------------------------------------------

/** POST /api/m/tasks {label?, force?} */
async function handleCreateTask(req, res) {
  const email = authenticate(req, res);
  if (!email) return;
  const body = await readJsonBody(req);

  const createKey = dailyKey(`mu#create#${email}`, shanghaiDateStr(), 'c');
  const created = await incrementDaily(createKey, 1);
  if (created > MAX_CREATE_PER_DAY) {
    return sendJson(req, res, 429, { error: '今日创建任务次数已达上限，请明天再试' });
  }

  // 找已有未结束任务
  const tasks = await dbm.listTasksOfOwner(email);
  const now = Date.now();
  const active = tasks.find((t) => !t.closed && t.expiresAt > now);

  if (active && !body.force) {
    // 附带未导入数，前端确认卡显示
    const unimported = await dbm.countUnimportedPhotos(active.taskId);
    return sendJson(req, res, 409, {
      error: '您已有一个进行中的扫码任务',
      existingTaskId: active.taskId,
      photoCount: active.photoCount,
      unimportedCount: unimported,
    });
  }

  const label = typeof body.label === 'string' ? body.label.replace(/[\u0000-\u001f]/g, '').slice(0, 40) : '';
  const taskId = newId();
  // 先建新后删旧：建新失败不动旧任务
  await dbm.createTask(email, taskId, { tool: 'handwriting', label, now });
  if (active) {
    // 先关再删（挡并发上传），对齐 handleClose——否则 in-flight 上传会在任务行删除后
    // 继续写出分块行，成为 sweep 永远扫不到的孤儿（index 行已删）
    await dbm.closeTask(email, active.taskId);
    await dbm.deleteAllPhotos(active.taskId);
    await dbm.deleteTaskRows(email, active.taskId);
  }

  const token = signMuToken(taskId, 1);
  const user = await db.getUser(email);
  return sendJson(req, res, 200, {
    taskId,
    token,
    expiresIn: TOKEN_TTL_SECONDS,
    task: { taskId, label, tool: 'handwriting', photoCount: 0, expiresAt: now + dbm.TASK_TTL_MS },
    quota: user ? user.quota : 0,
  });
}

/** GET /api/m/task?tid=&since=<n> —— 增量轮询。 */
async function handleGetTask(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return sendJson(req, res, 400, { error: '参数不正确' });
  }
  const tid = url.searchParams.get('tid') || '';
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);

  const task = await requireOwnTask(req, res, tid);
  if (!task) return;

  const state = taskState(task);
  if (state === 'expired') {
    // 惰性清理：过期的照片不再值得任何人等。先关再删（挡并发上传，对齐 handleClose）；
    // closeTask 用 EXPECT_EXIST，行可能已被并发 sweep 删掉，容错跳过
    await dbm.closeTask(task.ownerEmail, tid).catch(() => {});
    await dbm.deleteAllPhotos(tid);
    await dbm.deleteTaskRows(task.ownerEmail, tid);
    return sendJson(req, res, 200, { state: 'expired' });
  }
  if (state === 'closed') {
    return sendJson(req, res, 200, { state: 'closed' });
  }

  const rows = await dbm.listPhotoRows(tid, ['seq', 'size', 'w', 'h', 'blur', 'bright', 'imported', 'complete']);
  const photos = rows
    .map(dbm.photoFromRow)
    .filter((p) => p.photoId && p.complete)
    .sort((x, y) => x.seq - y.seq);

  // 缩略图只对增量行补拉（单行 ≤24KB，安全阈值内；单次响应最多 12 张）。
  // ⚠️ 必须最旧优先（slice(0,12)）：桌面端落后超过 12 张时若取最新 12 张，
  // 最早的行会因 since 持续推进而永远轮不到（缩略图永久缺失）
  const fresh = photos.filter((p) => p.seq > since).slice(0, 12);
  const thumbs = await dbm.getThumbs(tid, fresh.map((p) => p.photoId));

  return sendJson(req, res, 200, {
    state: 'active',
    task: taskView(task),
    photos: photos.map((p) => ({ ...p, thumb: thumbs.get(p.photoId) || undefined })),
  });
}

/** POST /api/m/token {tid} —— 非破坏性重发二维码（同一 tokenSeq，倒计时归零自动续）。 */
async function handleGetToken(req, res) {
  const body = await readJsonBody(req);
  const task = await requireOwnTask(req, res, typeof body.tid === 'string' ? body.tid.trim() : '');
  if (!task) return;
  if (taskState(task) !== 'active') {
    return sendJson(req, res, 409, { error: '任务已结束', state: taskState(task) });
  }
  return sendJson(req, res, 200, {
    token: signMuToken(task.taskId, task.tokenSeq),
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

/** POST /api/m/photo-data {tid, photoId} —— 取整图（桌面识别用）。 */
async function handlePhotoData(req, res) {
  const body = await readJsonBody(req);
  const task = await requireOwnTask(req, res, typeof body.tid === 'string' ? body.tid.trim() : '');
  if (!task) return;
  const photoId = typeof body.photoId === 'string' ? body.photoId : '';
  if (!PHOTO_ID_RE.test(photoId)) return sendJson(req, res, 400, { error: '参数不正确' });

  const dataUrl = await dbm.getPhotoData(task.taskId, photoId);
  if (dataUrl == null) return sendJson(req, res, 404, { error: '照片不存在或已被删除' });
  return sendJson(req, res, 200, { photoId, dataUrl });
}

/** POST /api/m/photo-delete {tid, photoId} */
async function handlePhotoDelete(req, res) {
  const body = await readJsonBody(req);
  const task = await requireOwnTask(req, res, typeof body.tid === 'string' ? body.tid.trim() : '');
  if (!task) return;
  const photoId = typeof body.photoId === 'string' ? body.photoId : '';
  if (!PHOTO_ID_RE.test(photoId)) return sendJson(req, res, 400, { error: '参数不正确' });

  await dbm.deletePhoto(task.ownerEmail, task.taskId, photoId);
  const fresh = await dbm.getTask(task.ownerEmail, task.taskId);
  return sendJson(req, res, 200, { ok: true, photoCount: fresh ? fresh.photoCount : 0 });
}

/** POST /api/m/photos-imported {tid, photoIds[]} —— 识别成功打标。 */
async function handlePhotosImported(req, res) {
  const body = await readJsonBody(req);
  const task = await requireOwnTask(req, res, typeof body.tid === 'string' ? body.tid.trim() : '');
  if (!task) return;
  const ids = Array.isArray(body.photoIds) ? body.photoIds.filter((x) => typeof x === 'string' && PHOTO_ID_RE.test(x)) : [];
  if (!ids.length) return sendJson(req, res, 400, { error: '参数不正确' });
  if (ids.length > 100) return sendJson(req, res, 400, { error: '单次最多 100 张' });

  const imported = await dbm.markImported(task.taskId, ids);
  return sendJson(req, res, 200, { ok: true, imported });
}

/** POST /api/m/refresh {tid} —— 刷新二维码 = 换绑（旧会话全失效）。 */
async function handleRefresh(req, res) {
  const body = await readJsonBody(req);
  const task = await requireOwnTask(req, res, typeof body.tid === 'string' ? body.tid.trim() : '');
  if (!task) return;
  if (taskState(task) === 'expired') {
    return sendJson(req, res, 409, { error: '任务已过期，请新建扫码任务' });
  }
  if (taskState(task) === 'closed') {
    return sendJson(req, res, 409, { error: '任务已结束' });
  }
  const rotated = await dbm.rotateTask(task.ownerEmail, task.taskId);
  const tokenSeq = rotated.tokenSeq || (await dbm.getTask(task.ownerEmail, task.taskId)).tokenSeq;
  return sendJson(req, res, 200, {
    token: signMuToken(task.taskId, tokenSeq),
    expiresIn: TOKEN_TTL_SECONDS,
    task: taskView(await dbm.getTask(task.ownerEmail, task.taskId)),
  });
}

/** POST /api/m/close {tid, force?} —— 完成并清理照片。 */
async function handleClose(req, res) {
  const body = await readJsonBody(req);
  const task = await requireOwnTask(req, res, typeof body.tid === 'string' ? body.tid.trim() : '');
  if (!task) return;
  if (taskState(task) === 'closed') {
    return sendJson(req, res, 200, { ok: true, alreadyClosed: true });
  }

  const unimported = await dbm.countUnimportedPhotos(task.taskId);
  if (unimported > 0 && !body.force) {
    return sendJson(req, res, 409, { error: `还有 ${unimported} 张照片未识别`, unimportedCount: unimported });
  }

  await dbm.closeTask(task.ownerEmail, task.taskId); // 先关（挡并发上传）再删
  const deleted = await dbm.deleteAllPhotos(task.taskId);
  return sendJson(req, res, 200, { ok: true, deleted });
}

// ---------------------------------------------------------------------------
// 手机端接口
// ---------------------------------------------------------------------------

/** claim / verify-session 共用的响应体（不含缩略图——二维码是投影公开物）。 */
async function mobileTaskPayload(task) {
  const rows = await dbm.listPhotoRows(task.taskId, ['seq', 'complete']);
  const photoIds = rows
    .map(dbm.photoFromRow)
    .filter((p) => p.photoId && p.complete)
    .sort((x, y) => x.seq - y.seq);
  const user = await db.getUser(task.ownerEmail);
  return {
    session: null, // 由调用方填
    task: {
      label: task.label,
      tool: task.tool,
      photoCount: task.photoCount,
      expiresAt: task.expiresAt,
      quota: user ? user.quota : 0,
      maxPhotos: MAX_PHOTOS,
    },
    photoIds: photoIds.map((p) => ({ photoId: p.photoId, seq: p.seq })),
  };
}

/** POST /api/m/claim {token, deviceId} —— 扫码绑定设备。 */
async function handleClaim(req, res) {
  const body = await readJsonBody(req);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!token) return sendJson(req, res, 400, { error: '缺少二维码参数' });
  if (!DEVICE_ID_RE.test(deviceId)) return sendJson(req, res, 400, { error: '设备标识不正确' });

  // 限流只计密码学验签失败（伪造签名）；404/409 语义状态不计数
  const failKey = dailyKey(`mu#badtok#${clientIp(req)}`, shanghaiDateStr(), 'c');
  if ((await getDailyCount(failKey)) >= MAX_BAD_TOKEN_PER_DAY) {
    return sendJson(req, res, 429, { error: '尝试次数过多，请明天再试' });
  }
  const v = verifyMuToken(token);
  if (!v.ok) {
    if (v.kind === 'signature') await incrementDaily(failKey, 1);
    const msg = v.kind === 'expired' ? '二维码已过期，请在电脑端刷新' : '二维码无效';
    return sendJson(req, res, 401, { error: msg, kind: v.kind });
  }

  const task = await dbm.getTaskByIndex(v.payload.tid);
  const state = taskState(task);
  if (state === 'missing') return sendJson(req, res, 404, { error: '任务不存在或已被清理' });
  if (state === 'closed') return sendJson(req, res, 409, { error: '任务已结束', state });
  if (state === 'expired') return sendJson(req, res, 409, { error: '任务已过期', state });
  if ((v.payload.ts | 0) !== task.tokenSeq) {
    return sendJson(req, res, 409, { error: '二维码已被刷新，请扫描最新二维码', state: 'refreshed' });
  }

  // 任意设备扫码均可上传（2026-09-27 需求变更：不再单设备绑定）。
  // deviceBound 仅作记录（后连者覆盖）；会话有效性只看 sv===task.sess，
  // 因此多设备各自的会话可并存上传，互不影响。
  await dbm.markDevice(task.ownerEmail, task.taskId, deviceId);

  const session = signMuSession(task.taskId, deviceId, task.sess);
  const payload = await mobileTaskPayload(task);
  return sendJson(req, res, 200, { ...payload, session, expiresIn: SESSION_TTL_SECONDS });
}

/** POST /api/m/verify-session {session} —— 断线恢复 / 对账。 */
async function handleVerifySession(req, res) {
  const body = await readJsonBody(req);
  const session = typeof body.session === 'string' ? body.session.trim() : '';
  if (!session) return sendJson(req, res, 400, { error: '参数不正确' });

  const v = await verifyMuSession(session);
  if (!v.ok) {
    if (v.kind === 'invalid') return sendJson(req, res, 401, { error: '会话无效，请重新扫码' });
    const msg = v.state === 'revoked'
      ? '二维码已刷新，请在电脑端重新扫码'
      : v.state === 'closed' ? '任务已结束，照片已删除'
        : v.state === 'expired' ? '任务已过期，照片已删除' : '任务不存在';
    return sendJson(req, res, 409, { error: msg, state: v.state });
  }
  const payload = await mobileTaskPayload(v.task);
  return sendJson(req, res, 200, payload);
}

/** POST /api/m/upload {session, photoId, dataUrl, w, h, size, quality{blur,bright}, thumb?} */
async function handleUpload(req, res) {
  const body = await readJsonBody(req);
  const session = typeof body.session === 'string' ? body.session.trim() : '';
  if (!session) return sendJson(req, res, 401, { error: '会话无效，请重新扫码' });

  const v = await verifyMuSession(session);
  if (!v.ok) {
    if (v.kind === 'invalid') return sendJson(req, res, 401, { error: '会话无效，请重新扫码' });
    const msg = v.state === 'revoked'
      ? '二维码已刷新，请在电脑端重新扫码'
      : v.state === 'closed' ? '任务已结束，照片已删除'
        : v.state === 'expired' ? '任务已过期，照片已删除' : '任务不存在';
    return sendJson(req, res, 409, { error: msg, state: v.state });
  }
  const task = v.task;

  const photoId = typeof body.photoId === 'string' ? body.photoId : '';
  if (!PHOTO_ID_RE.test(photoId)) return sendJson(req, res, 400, { error: '参数不正确' });

  const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
  if (!dataUrl.startsWith(JPEG_DATAURL_PREFIX)) {
    return sendJson(req, res, 400, { error: '仅支持 JPEG 照片' });
  }
  if (dataUrl.length > MAX_DATAURL_CHARS) {
    return sendJson(req, res, 413, { error: '照片过大，请重新拍摄' });
  }
  let decoded;
  try {
    decoded = Buffer.from(dataUrl.slice(JPEG_DATAURL_PREFIX.length), 'base64');
  } catch {
    return sendJson(req, res, 400, { error: '照片数据无效' });
  }
  if (decoded.length > MAX_DECODED_BYTES) {
    return sendJson(req, res, 413, { error: '照片过大，请重新拍摄' });
  }
  // JPEG 魔数（FFD8）
  if (decoded.length < 4 || decoded[0] !== 0xff || decoded[1] !== 0xd8) {
    return sendJson(req, res, 400, { error: '照片数据无效（非 JPEG）' });
  }

  const w = Math.min(10000, Math.max(0, parseInt(body.w, 10) || 0));
  const h = Math.min(10000, Math.max(0, parseInt(body.h, 10) || 0));
  const size = Math.min(20000000, Math.max(0, parseInt(body.size, 10) || 0));
  const q = body.quality || {};
  const blur = Math.min(65535, Math.max(0, parseInt(q.blur, 10) || 0));
  const bright = Math.min(65535, Math.max(0, parseInt(q.bright, 10) || 0));
  const thumb = typeof body.thumb === 'string'
    && body.thumb.startsWith(JPEG_DATAURL_PREFIX)
    && body.thumb.length <= dbm.THUMB_MAX_CHARS ? body.thumb : '';

  let result;
  try {
    result = await dbm.uploadPhoto({
      ownerEmail: task.ownerEmail,
      taskId: task.taskId,
      photoId,
      dataUrl,
      size,
      w,
      h,
      blur,
      bright,
      thumb,
      now: Date.now(),
    });
  } catch (err) {
    if (err && err.statusCode === 409) {
      // 手机端靠 state 分流终态；裸 409 会被当成可重试网络错误空转退避 5 分钟
      return sendJson(req, res, 409, {
        error: err.message,
        state: /已结束/.test(err.message) ? 'closed' : 'full',
      });
    }
    throw err;
  }

  const [fresh, user] = await Promise.all([
    dbm.getTask(task.ownerEmail, task.taskId),
    db.getUser(task.ownerEmail),
  ]);
  return sendJson(req, res, 200, {
    seq: result.seq,
    replaced: result.replaced,
    photoCount: fresh ? fresh.photoCount : result.seq,
    quota: user ? user.quota : 0,
    maxPhotos: MAX_PHOTOS,
  });
}

// ---------------------------------------------------------------------------
// 清扫（惰性门闩 + 平台定时触发器兜底）
// ---------------------------------------------------------------------------

/** 惰性门闩：上海时区每小时最多跑一次；由任意 /api/m 请求触发。 */
async function maybeSweep() {
  const now = Date.now();
  const hourKey = `mu#sweep#${new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 13)}`;
  if (await getDailyFlag(hourKey)) return;
  await setDailyFlag(hourKey);
  try {
    const n = await dbm.sweepExpired(now);
    if (n > 0) console.log(`[mupload] sweep 清理 ${n} 个过期任务`);
  } catch (err) {
    console.error('[mupload] sweep 失败:', err.message || err);
  }
}

/** 定时触发器入口（index.js 完成事件识别后分流）。 */
async function handleTimer(req, res) {
  const n = await dbm.sweepExpired(Date.now());
  return sendJson(req, res, 200, { ok: true, cleaned: n });
}

module.exports = {
  handleCreateTask,
  handleGetTask,
  handleGetToken,
  handlePhotoData,
  handlePhotoDelete,
  handlePhotosImported,
  handleRefresh,
  handleClose,
  handleClaim,
  handleVerifySession,
  handleUpload,
  maybeSweep,
  handleTimer,
};
