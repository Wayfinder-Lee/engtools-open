'use strict';

/**
 * English Teacher Toolkit 后端入口（Node.js Web 服务，监听端口 9000）。
 *
 * 路由：
 *   GET  /                  健康检查
 *   POST /api/auth/send-verify-code  发送邮箱验证码
 *   POST /api/auth/register         注册（需验证码）
 *   POST /api/auth/login            登录
 *   GET  /api/me                    查询当前用户额度
 *   POST /api/redeem                兑换码充值
 *   POST /api/llm/chat              校验+扣额度+转发 LLM（响应保持 OpenAI 结构）
 *   GET  /api/usage/summary         使用看板聚合（额度总览/各 op 次数/按上海日消费）
 *   GET  /api/usage                 使用流水分页（额度明细，时间降序）
 *   POST /api/usage/report          客户端数量上报（白名单 op，看板「真实数量」指标）
 *   POST /api/tts                   听力语音合成（云端 TTS；登录用户，免费，日限流）
 */

const crypto = require('crypto');
const http = require('http');
const config = require('./config');
const db = require('./tablestore');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');
const { sendJson, sendPreflight, readJsonBody, applyCors } = require('./http');
const { sendVerifyCode } = require('./mail');

// 扫码拍照上传（m-upload）：可整体摘除模式（模块不存在时自动停用其路由）
let mupload = null;
try {
  // eslint-disable-next-line global-require
  mupload = require('./mupload');
} catch (_err) {
  mupload = null;
}

// 听力 TTS（云端一句话合成）：同款可摘除模式；环境变量未配置时模块抛错自动停用
let tts = null;
try {
  // eslint-disable-next-line global-require
  tts = require('./tts');
} catch (_err) {
  tts = null;
}

config.assertServerConfig();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** 生成 6 位数字验证码 */
function randomCode() {
  return String(crypto.randomInt(100000, 999999));
}

/** 从请求头取出并校验 JWT，返回 email；未登录时直接回 401 并返回 null。 */
function authenticate(req, res) {
  const email = verifyToken(req.headers.authorization);
  if (!email) {
    sendJson(req, res, 401, { error: '未登录或登录已过期' });
    return null;
  }
  return email;
}

// ---------------------------------------------------------------------------
// 路由处理
// ---------------------------------------------------------------------------

/** 发送邮箱验证码，60 秒内同一邮箱不可重发。 */
async function handleSendVerifyCode(req, res) {
  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);
  // purpose: register(注册，旧流程) / verify(验证已注册的未验证账号) / reset(重置密码)
  const purpose = body.purpose === 'reset' ? 'reset' : body.purpose === 'verify' ? 'verify' : 'register';
  if (!EMAIL_RE.test(email)) return sendJson(req, res, 400, { error: '邮箱格式不正确' });

  // 查是否已注册
  const existing = await db.getUser(email);
  if (purpose === 'register' && existing) {
    return sendJson(req, res, 409, { error: '该邮箱已注册，请直接登录' });
  }
  if (purpose === 'reset' && !existing) {
    return sendJson(req, res, 404, { error: '该邮箱未注册' });
  }
  if (purpose === 'verify' && (!existing || isVerifiedUser(existing))) {
    return sendJson(req, res, existing ? 200 : 404, existing
      ? { ok: true, sent: false }
      : { error: '该邮箱未注册' });
  }

  // 60s 内是否已发过码
  const result = await db.client.getRow({
    tableName: db.TABLE_VERIFY_CODES,
    primaryKey: [{ email }],
    maxVersions: 1,
  });
  if (result && result.row && result.row.primaryKey) {
    const attrs = {};
    if (Array.isArray(result.row.attributes)) {
      for (const a of result.row.attributes) attrs[a.columnName] = a.columnValue;
    }
    const sentAt = typeof attrs.sentAt?.toNumber === 'function' ? attrs.sentAt.toNumber() : (typeof attrs.sentAt === 'number' ? attrs.sentAt : 0);
    if (sentAt && Date.now() - sentAt < 60000) {
      return sendJson(req, res, 429, { error: '请 60 秒后再重新发送验证码' });
    }
  }

  const code = randomCode();
  await db.saveVerifyCode(email, code);

  const { sent, preview } = await sendVerifyCode(email, code);

  // 本地模式：通过响应把验证码带回去（仅测试用）
  return sendJson(req, res, 200, { ok: true, sent, ...(sent ? {} : { devCode: preview }) });
}

async function handleRegister(req, res) {
  // 注册频控（防批量小号薅额度）：每 IP 每小时 ≤3、每天 ≤10。
  // 用 daily_limits 原子自增当计数器；存储抖动时放行（fail-open，不伤真实用户）。
  const ip = clientIp(req);
  try {
    const hourBucket = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 13); // 上海时区 YYYY-MM-DDTHH
    const hourCount = await db.incrementDaily(`reg#${ip}#${hourBucket}`);
    if (hourCount > 3) return sendJson(req, res, 429, { error: '注册过于频繁，请稍后再试' });
    const dayCount = await db.incrementDaily(`reg#${ip}#${shanghaiDateStr()}`);
    if (dayCount > 10) return sendJson(req, res, 429, { error: '今日注册次数已达上限，请明天再试' });
  } catch (_e) { /* 频控存储失败：放行 */ }

  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const verifyCode = typeof body.verifyCode === 'string' ? body.verifyCode.trim() : '';

  if (!EMAIL_RE.test(email)) return sendJson(req, res, 400, { error: '邮箱格式不正确' });
  if (password.length < 6) return sendJson(req, res, 400, { error: '密码至少 6 位' });

  // M6 双通道：带验证码 = 旧流程（验证即发正式赠送额度）；不带 = 免验证注册，
  // 先进产品（少量体验额度 UNVERIFIED_CREDITS，防批量小号薅 LLM 额度），
  // 邮箱验证后再补发正式赠送额度并解锁兑换
  if (verifyCode) {
    const codeOk = await db.checkVerifyCode(email, verifyCode);
    if (!codeOk) return sendJson(req, res, 400, { error: '验证码错误或已过期' });

    const created = await db.createUser(email, hashPassword(password), config.freeCredits, true);
    if (!created) return sendJson(req, res, 409, { error: '该邮箱已注册' });

    try { await db.putUsageLog(email, { kind: 'grant', op: 'signup', gain: config.freeCredits, meta: 'signup' }); } catch (_e) { /* 流水失败不影响注册 */ }

    const token = signToken(email);
    return sendJson(req, res, 200, { token, email, quota: config.freeCredits, emailVerified: true });
  }

  const created = await db.createUser(email, hashPassword(password), config.unverifiedCredits, false);
  if (!created) return sendJson(req, res, 409, { error: '该邮箱已注册' });

  try { await db.putUsageLog(email, { kind: 'grant', op: 'signup', gain: config.unverifiedCredits, meta: 'signup' }); } catch (_e) { /* 流水失败不影响注册 */ }

  const token = signToken(email);
  return sendJson(req, res, 200, { token, email, quota: config.unverifiedCredits, emailVerified: false });
}

/** M6：登录用户提交邮箱验证码 → emailVerified 翻转并补发正式赠送额度（原子防重复）。 */
async function handleVerifyEmail(req, res) {
  const email = authenticate(req, res);
  if (!email) return;
  const body = await readJsonBody(req);
  const verifyCode = typeof body.verifyCode === 'string' ? body.verifyCode.trim() : '';
  if (!verifyCode) return sendJson(req, res, 400, { error: '请输入验证码' });

  const user = await db.getUser(email);
  if (!user) return sendJson(req, res, 404, { error: '用户不存在' });
  if (isVerifiedUser(user)) return sendJson(req, res, 200, { ok: true, quota: user.quota, alreadyVerified: true });

  const codeOk = await db.checkVerifyCode(email, verifyCode);
  if (!codeOk) return sendJson(req, res, 400, { error: '验证码错误或已过期' });

  const granted = await db.verifyUserEmail(email, config.freeCredits);
  if (granted) {
    try { await db.putUsageLog(email, { kind: 'grant', op: 'verify_email', gain: config.freeCredits, meta: 'verify' }); } catch (_e) { /* 流水失败不影响验证 */ }
  }
  const user2 = await db.getUser(email);
  return sendJson(req, res, 200, {
    ok: true,
    quota: user2 ? user2.quota : config.freeCredits,
    alreadyVerified: !granted,
  });
}

/** 「我的账户」：修改密码（验旧密码，新密码 ≥6 位）。 */
async function handleChangePassword(req, res) {
  const email = authenticate(req, res);
  if (!email) return;
  const body = await readJsonBody(req);
  const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!oldPassword) return sendJson(req, res, 400, { error: '请输入当前密码' });
  if (newPassword.length < 6) return sendJson(req, res, 400, { error: '新密码至少 6 位' });
  if (newPassword === oldPassword) return sendJson(req, res, 400, { error: '新密码不能与当前密码相同' });

  const user = await db.getUser(email);
  if (!user) return sendJson(req, res, 404, { error: '用户不存在' });
  if (!verifyPassword(oldPassword, user.passwordHash)) {
    return sendJson(req, res, 400, { error: '当前密码不正确' });
  }
  await db.updatePassword(email, hashPassword(newPassword));
  return sendJson(req, res, 200, { ok: true });
}

/** 游客额度查询（按调用方 IP）。 */
async function handleGuestMe(req, res) {
  const ip = clientIp(req);
  const quota = await db.ensureGuest(ip, config.guestCredits);
  return sendJson(req, res, 200, { quota, total: config.guestCredits });
}

/** 重置密码：验证码 + 新密码。 */
async function handleResetPassword(req, res) {
  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);
  const verifyCode = typeof body.verifyCode === 'string' ? body.verifyCode.trim() : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!EMAIL_RE.test(email)) return sendJson(req, res, 400, { error: '邮箱格式不正确' });
  if (!verifyCode) return sendJson(req, res, 400, { error: '请输入验证码' });
  if (newPassword.length < 6) return sendJson(req, res, 400, { error: '新密码至少 6 位' });

  const codeOk = await db.checkVerifyCode(email, verifyCode);
  if (!codeOk) return sendJson(req, res, 400, { error: '验证码错误或已过期' });

  await db.updatePassword(email, hashPassword(newPassword));
  return sendJson(req, res, 200, { ok: true });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  const user = await db.getUser(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return sendJson(req, res, 401, { error: '邮箱或密码错误' });
  }

  const token = signToken(email);
  return sendJson(req, res, 200, { token, email, quota: user.quota, emailVerified: isVerifiedUser(user) });
}

async function handleMe(req, res) {
  const email = authenticate(req, res);
  if (!email) return;
  const user = await db.getUser(email);
  if (!user) return sendJson(req, res, 404, { error: '用户不存在' });
  return sendJson(req, res, 200, { email: user.email, quota: user.quota, emailVerified: isVerifiedUser(user) });
}

async function handleRedeem(req, res) {
  const email = authenticate(req, res);
  if (!email) return;
  // M6：未验证邮箱不能兑换（防批量注册小号刷兑换码）；存量老账号按注册时间视为已验证
  const me = await db.getUser(email);
  if (me && !isVerifiedUser(me)) {
    return sendJson(req, res, 403, { error: '请先验证邮箱后再兑换额度' });
  }
  const body = await readJsonBody(req);
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!code) return sendJson(req, res, 400, { error: '请输入兑换码' });

  const credits = await db.claimCode(code, email);
  if (credits == null) return sendJson(req, res, 400, { error: '兑换码无效或已被使用' });

  await db.addUserQuota(email, credits);
  try { await db.putUsageLog(email, { kind: 'redeem', op: 'redeem', gain: credits, meta: code }); } catch (_e) { /* 流水失败不影响兑换 */ }
  const user = await db.getUser(email);
  return sendJson(req, res, 200, { credits, quota: user ? user.quota : credits });
}

/** 注销账号（PIPL 用户权利）：JWT 鉴权通过后删除用户行，不可恢复。 */
async function handleDeleteAccount(req, res) {
  const email = authenticate(req, res);
  if (!email) return;
  const deleted = await db.deleteUser(email);
  if (!deleted) return sendJson(req, res, 404, { error: '用户不存在或已注销' });
  return sendJson(req, res, 200, { ok: true });
}

// 扣费映射（根据前端 _operation 字段）
const CREDIT_COST = {
  word: 0,           // 免费，每日限额 50
  vocab_section: 5,  // 每段 ≤2000 词
  cloze: 20,
  practical: 20,
  continuation: 30,
  worksheet: 30,
  class_report: 10,  // 班级讲评报告（一次生成整班共性问题/亮点/评讲课建议）
  ocr: 1,
  prompt_vision: 1,  // 看图/图表作文题干配图读图（单张，同 ocr）
  copybook: 5,       // 字帖练习内容生成
  exampaper: 5,      // 试卷结构化解析（每大题块）
  exampaper_vision: 5, // 试卷照片/扫描件逐页视觉转写
  rewrite: 3,        // M1 段落级「换一个」局部重生成
  rewrite_essay: 8,  // M1 换难度重写整篇范文
  level_check: 2,    // M4 难度自检
  summarize: 1,      // 续写题干概括（此前走 unknown-op 兜底 1，显式化；行为不变）
  auto_title: 0,     // 自动存档标题（免费辅助，gemini-2.5-flash；不进使用流水）
};
const WORD_DAILY_LIMIT = 50;

/**
 * 存量用户兼容（M6）：免验证注册上线前的老账号，注册时虽验过码，但旧代码从不在
 * 验证后写 emailVerified=true——库里存量全是 false。按注册时间划线：截止前注册
 * 的一律视为已验证；之后注册的看真实字段。
 */
const LEGACY_VERIFIED_CUTOFF = Date.parse('2026-09-21T00:00:00Z');
function isVerifiedUser(user) {
  if (!user) return false;
  return user.emailVerified === true || (user.createdAt || 0) < LEGACY_VERIFIED_CUTOFF;
}

/** 提取客户端 IP（网关/代理走 x-forwarded-for，兜底 socket）。 */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    // ⚠️ 取最后一段（最接近网关的一跳）：客户端可自报 XFF 首段伪造来源 IP，
    // 取首段 = 信任伪造值，游客额度与一切按 IP 的限流都会被绕过。
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

async function handleLlmChat(req, res) {
  // M6：无有效 JWT 时按游客（IP 维度体验额度）放行，而不是直接 401
  const email = verifyToken(req.headers.authorization) || null;

  const body = await readJsonBody(req);
  if (!body || !Array.isArray(body.messages) || !body.model) {
    return sendJson(req, res, 400, { error: '缺少 model 或 messages' });
  }

  const op = body._operation || '';
  const cost = CREDIT_COST[op] ?? 1;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const account = email ? { email } : { guestIp: clientIp(req) };
  const acctKey = email || `guest:${account.guestIp}`;

  // 自定义单词：日限额 50 次，免费
  if (op === 'word') {
    const countKey = db.dailyKey(acctKey, today, 'word_count');
    const cur = await db.incrementDaily(countKey, 1);
    if (cur <= WORD_DAILY_LIMIT) {
      // 50 次内免费，直接转发（不扣额度）
      return forwardLlm(req, res, account, 0, body);
    }
    // 超过 50 次：检查是否已解锁（游客无解锁通道，只能等明天/注册）
    const unlockKey = db.dailyKey(acctKey, today, 'word_unlocked');
    if (await db.getDailyFlag(unlockKey)) {
      return forwardLlm(req, res, account, 0, body);
    }
    // 未解锁 → 提示付费
    return sendJson(req, res, 402, { error: '今日免费次数已用完', unlockCost: 1 });
  }

  // 词汇分段：校验 2000 词上限
  if (op === 'vocab_section') {
    const text = (body.messages || []).map((m) => m.content || '').join(' ');
    if (text.split(/\s+/).length > 2000) {
      return sendJson(req, res, 400, { error: '该段落超过 2000 词限制，请拆分后再生成' });
    }
  }

  // 付费操作
  return forwardLlm(req, res, account, cost, body);
}

/** 实际转发 LLM，扣 cost 额度（cost=0 则不扣）。account = { email } 或 { guestIp }。 */
async function forwardLlm(req, res, account, cost, body) {
  const email = account.email || null;
  const guestIp = account.guestIp || null;

  if (cost > 0) {
    const reserved = email ? await db.reserveCredit(email, cost) : await db.reserveGuestCredit(guestIp, cost);
    if (!reserved) {
      return sendJson(req, res, 402, email
        ? { error: '额度不足，请兑换后再使用' }
        : { error: '体验额度已用完。注册（免费）领取正式额度，或明天再来', guestExhausted: true });
    }
  }

  /** 失败退额（按账号类型走各自的表）。 */
  const refund = async (points) => {
    if (cost <= 0) return;
    if (email) await db.refundCredit(email, points);
    else await db.refundGuestCredit(guestIp, points);
  };

  try {
    const upstream = await fetch(config.llmEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      await refund(cost);
      applyCors(req, res);
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(text || JSON.stringify({ error: 'LLM 上游错误' }));
    }

    // 上游 200 但 choices 内容为空（脏页面 thinking 烧满 max_tokens、finish_reason=length
    // 输出 0 字符——试卷视觉转写的实测失败形态）：用户没拿到任何内容，退费后按错误返回，
    // 避免前端「失败页可重试」每重试一次白扣一次。非 JSON 响应体（流式片段等）不在此列
    let emptyContent = false;
    try {
      const parsed = JSON.parse(text);
      const content = parsed && parsed.choices && parsed.choices[0]
        && parsed.choices[0].message && parsed.choices[0].message.content;
      emptyContent = typeof content !== 'string' || content.trim() === '';
    } catch { /* 非 JSON：按有内容放行 */ }
    if (emptyContent) {
      await refund(cost);
      applyCors(req, res);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'LLM 返回内容为空，本次额度已退回，请重试' }));
    }

    // 使用流水：只记真正扣费的成功调用（上游失败/空内容退费的不记，明细才与扣款一致）。
    // 登录用户的免费 word 也记（看板「查词次数」）；游客只记 cost>0——guest:<ip> 分区
    // 行数天然受体验额度上限约束，不膨胀。auto_title 是零额度的自动辅助调用且频次高，
    // 记了只会刷屏额度明细，明确排除。必须 await（函数平台可能在响应后冻结容器），失败只记日志。
    if ((cost > 0 || email) && body._operation !== 'auto_title') {
      try {
        await db.putUsageLog(email || `guest:${guestIp}`, { kind: 'llm', op: body._operation || 'unknown', cost });
      } catch (logErr) {
        // eslint-disable-next-line no-console
        console.error('[usage-log]', (logErr && logErr.message) || logErr);
      }
    }

    applyCors(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(text);
  } catch (err) {
    await refund(cost);
    return sendJson(req, res, 502, { error: 'LLM 上游请求失败: ' + String(err.message || err) });
  }
}

/** 支付 1 credit 解除今日自定义单词限制。 */
async function handleUnlockWordLimit(req, res) {
  const email = authenticate(req, res);
  if (!email) return;

  const reserved = await db.reserveCredit(email, 1);
  if (!reserved) return sendJson(req, res, 402, { error: '额度不足' });

  const today = new Date().toISOString().slice(0, 10);
  await db.setDailyFlag(db.dailyKey(email, today, 'word_unlocked'));
  try { await db.putUsageLog(email, { kind: 'unlock', op: 'word_unlock', cost: 1 }); } catch (_e) { /* 流水失败不影响解锁 */ }
  const user = await db.getUser(email);
  return sendJson(req, res, 200, { ok: true, quota: user ? user.quota : 0 });
}

// ---------------------------------------------------------------------------
// 使用统计（看板 / 额度明细 / 客户端数量上报）
// ---------------------------------------------------------------------------

/** 客户端上报白名单：op → 单次 count 钳制上限（服务端不信前端数量级）。 */
const REPORT_OPS = { vocab_words: 2000, exampaper_done: 1, copybook_print: 1 };
const MAX_REPORTS_PER_DAY = 200;

/** 上海日期字符串（日限流键口径；勿用 LLM 路径的 UTC 旧口径）。 */
function shanghaiDateStr() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** GET /api/usage/summary —— 看板聚合（鉴权）。 */
async function handleUsageSummary(req, res) {
  const email = authenticate(req, res);
  if (!email) return;
  const user = await db.getUser(email);
  if (!user) return sendJson(req, res, 404, { error: '用户不存在' });
  const summary = await db.usageSummary(email, user.quota);
  return sendJson(req, res, 200, summary);
}

/** GET /api/usage?limit=&cursor=&type= —— 使用流水分页，时间降序（鉴权）。 */
async function handleUsage(req, res) {
  const email = authenticate(req, res);
  if (!email) return;
  const q = new URL(req.url, 'http://localhost').searchParams;
  const limit = Math.min(Math.max(parseInt(q.get('limit') || '50', 10) || 50, 1), 200);
  // cursor = 上一页返回的 sk（16 位反转时间戳 + 后缀）；校验形状防注入任意扫描起点
  const rawCursor = q.get('cursor') || '';
  const cursor = /^[0-9]{16}(-[0-9A-Za-z-]{1,40})?$/.test(rawCursor) ? rawCursor : '';
  const type = ['charge', 'spend'].includes(q.get('type') || '') ? q.get('type') : 'all';
  const { rows, nextCursor } = await db.listUsageLog(email, { limit, cursor, type });
  return sendJson(req, res, 200, { rows, nextCursor });
}

/** POST /api/usage/report { op, count } —— 客户端真实数量上报（鉴权；未验证邮箱也放行）。 */
async function handleUsageReport(req, res) {
  const email = authenticate(req, res);
  if (!email) return;
  const body = await readJsonBody(req);
  const op = typeof body.op === 'string' ? body.op : '';
  if (!(op in REPORT_OPS)) return sendJson(req, res, 400, { error: '不支持的上报类型' });
  const n = Math.floor(Number(body.count));
  if (!Number.isFinite(n)) return sendJson(req, res, 400, { error: 'count 必须是数字' });
  const count = Math.max(1, Math.min(n, REPORT_OPS[op]));

  // 日限流（200 次/人/日）；INCREMENT 非幂等，不包重试
  const used = await db.incrementDaily(db.dailyKey(email, shanghaiDateStr(), 'report'), 1);
  if (used > MAX_REPORTS_PER_DAY) {
    return sendJson(req, res, 429, { error: '今日上报次数已达上限' });
  }

  try {
    await db.putUsageLog(email, { kind: 'stat', op, count });
  } catch (_err) {
    return sendJson(req, res, 500, { error: '写入失败，请稍后重试' });
  }
  return sendJson(req, res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

const ROUTES = {
  'POST /api/auth/send-verify-code': handleSendVerifyCode,
  'POST /api/auth/register': handleRegister,
  'POST /api/auth/reset-password': handleResetPassword,
  'POST /api/auth/verify': handleVerifyEmail,
  'POST /api/auth/login': handleLogin,
  'GET /api/me': handleMe,
  'GET /api/guest/me': handleGuestMe,
  'POST /api/redeem': handleRedeem,
  'DELETE /api/account': handleDeleteAccount,
  'POST /api/account/password': handleChangePassword,
  'POST /api/llm/chat': handleLlmChat,
  'POST /api/unlock-word-limit': handleUnlockWordLimit,
  // 使用统计（看板/明细/上报）：读接口鉴权，report 任何 JWT 用户可用
  'GET /api/usage/summary': handleUsageSummary,
  'GET /api/usage': handleUsage,
  'POST /api/usage/report': handleUsageReport,
  // 扫码拍照上传（桌面端 Bearer 登录 JWT；手机端免登录，claim 换会话 JWT）
  ...(mupload
    ? {
      'POST /api/m/tasks': mupload.handleCreateTask,
      'GET /api/m/task': mupload.handleGetTask,
      'POST /api/m/token': mupload.handleGetToken,
      'POST /api/m/photo-data': mupload.handlePhotoData,
      'POST /api/m/photo-delete': mupload.handlePhotoDelete,
      'POST /api/m/photos-imported': mupload.handlePhotosImported,
      'POST /api/m/refresh': mupload.handleRefresh,
      'POST /api/m/close': mupload.handleClose,
      'POST /api/m/claim': mupload.handleClaim,
      'POST /api/m/verify-session': mupload.handleVerifySession,
      'POST /api/m/upload': mupload.handleUpload,
    }
    : {}),
  // 听力语音合成（登录用户；免费，日限流；模块被移除或未配置时整段消失）
  ...(tts ? { 'POST /api/tts': tts.handleSynthesize } : {}),
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendPreflight(req, res);

    // 平台定时触发器兜底清扫（每小时；惰性门闩见 mupload.maybeSweep）。
    // ⚠️ 实测：有的平台对 Web 函数的事件调用 = **POST /invoke**，请求体
    // {triggerName,triggerTime,payload}，可能**不带标准触发器类型头**——
    // 只按 header 识别会静默漏接。
    // 识别 = 显式 header（文档口径，保留）∨「非 /api 路径的请求且事件体含 triggerName/
    // triggerTime 任一字段」（定时事件载荷形状；站点流量只走 /api/*，不会误伤，伪造
    // 最多触发一次幂等无害的清扫）。
    const pathname0 = (req.url || '').split('?')[0];
    const triggerType = String(req.headers['x-fc-trigger-type'] || '').toLowerCase();
    const isApiPath = pathname0 === '/' || pathname0.startsWith('/api/');
    let looksLikeTimerEvent = false;
    if (triggerType !== 'timer' && !isApiPath && req.method !== 'OPTIONS' && mupload) {
      try {
        const evt = await readJsonBody(req);
        looksLikeTimerEvent = !!(evt && (evt.triggerName !== undefined || evt.triggerTime !== undefined));
        // 诊断留痕（确认真实请求形态后可删）：事件调用到底走哪个路径、带什么头
        const fcHeaders = Object.entries(req.headers)
          .filter(([k]) => k.startsWith('x-fc-'))
          .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`);
        // eslint-disable-next-line no-console
        console.log('[timer-event]', req.method, req.url, `matched=${looksLikeTimerEvent}`, fcHeaders.join(' '), 'body-keys=', evt && typeof evt === 'object' ? Object.keys(evt).join(',') : typeof evt);
      } catch { /* 非 JSON 体：不当事件调用 */ }
    }
    if (triggerType === 'timer' || looksLikeTimerEvent) {
      if (mupload) {
        await mupload.handleTimer(req, res);
        return;
      }
      return sendJson(req, res, 200, { ok: true, skipped: true });
    }

    const pathname = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && pathname === '/') {
      return sendJson(req, res, 200, { ok: true, service: 'engtools-api' });
    }

    const handler = ROUTES[`${req.method} ${pathname}`];
    if (!handler) return sendJson(req, res, 404, { error: '接口不存在' });

    // 惰性清扫门闩：任意 /api/m 请求触发（上海时区每小时最多一次）
    if (mupload && pathname.startsWith('/api/m/') && req.method === 'GET') {
      await mupload.maybeSweep();
    }

    await handler(req, res);
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 500;
    if (!res.headersSent) sendJson(req, res, status, { error: String(err.message || err) });
    // eslint-disable-next-line no-console
    console.error('[error]', req.method, req.url, err);
  }
});

server.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`engtools-api 已启动，监听端口 ${config.port}`);
});
