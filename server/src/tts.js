'use strict';

/**
 * 听力 TTS（智能语音「一句话合成」RESTful API）。
 *
 *   POST /api/tts    { text, voice: 'male'|'female', speechRate? } → audio/mpeg 二进制
 *
 * 设计要点：
 *   - AccessKey / 项目 AppKey 只在服务端环境变量（config.tts），绝不进前端；
 *     任一变量缺失时本模块加载即抛错 → index.js 自动停用该路由（可摘除模式）
 *   - Token 由 CreateToken API（RPC v1 签名，零 SDK 依赖）换取，24h 有效：
 *     模块级缓存、过期前 10 分钟刷新、并发去重；网关鉴权走 X-NLS-Token 头
 *     （token 不进 URL / 访问日志）
 *   - 免费使用：日限流 TTS_DAILY_LIMIT 次/人（daily_limits 表），只记使用流水不扣额度
 *   - 用户文本即用即弃：不落库、不进日志，流水 meta 只记「声别·字数」
 */

const crypto = require('crypto');
const db = require('./tablestore');
const config = require('./config');
const { verifyToken } = require('./auth');
const { sendJson, readJsonBody, applyCors } = require('./http');

const cfg = config.tts;
if (!cfg.accessKeyId || !cfg.accessKeySecret || !cfg.appkeyMale || !cfg.appkeyFemale) {
  throw new Error('tts 未配置：缺少 NLS_AK_ID / NLS_AK_SECRET / NLS_APPKEY_MALE / NLS_APPKEY_FEMALE');
}

/** 一句话合成网关与 Token 签发域（智能语音交互仅华东2·上海） */
const TTS_GATEWAY = 'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts';
const TOKEN_HOST = 'https://nls-meta.cn-shanghai.aliyuncs.com/';

/** 单次请求文本上限（官方超过即截断，前端同步 maxlength） */
const MAX_TEXT_CHARS = 300;
/** 语速范围：-500~500（步进 50；|100| ≈ ±10% 听感） */
const SPEECH_RATE_MIN = -500;
const SPEECH_RATE_MAX = 500;

/** 声别 → (项目 AppKey, 发音人)。voice 显式传，不依赖控制台项目配置 */
const VOICES = {
  male: { appkey: cfg.appkeyMale, voice: 'aida' }, // 男声项目 · 艾达（标准男声）
  female: { appkey: cfg.appkeyFemale, voice: 'aijia' }, // 女声项目 · 艾佳（标准女声）
};

/** 每人每日合成次数上限 */
const DAILY_LIMIT = cfg.dailyLimit;

// ── Token（POP RPC v1 签名，无 SDK 依赖） ──

/** RFC3986 百分号编码（encodeURIComponent 不编码 !'()*，POP 签名要求编码） */
function popEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

let tokenCache = null; // { id, expireMs }
let tokenPromise = null;

/** CreateToken 换访问令牌（24h 有效）。仅供本模块与 spike 脚本使用。 */
async function createNlsToken() {
  const params = {
    AccessKeyId: cfg.accessKeyId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    // POP 要求秒级 UTC ISO8601（带毫秒会签名对不上）
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2019-02-28',
  };
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${popEncode(k)}=${popEncode(params[k])}`)
    .join('&');
  const stringToSign = `GET&${popEncode('/')}&${popEncode(qs)}`;
  const signature = crypto
    .createHmac('sha1', `${cfg.accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
  const res = await fetch(`${TOKEN_HOST}?${qs}&Signature=${popEncode(signature)}`);
  const data = await res.json();
  const token = data && data.Token;
  if (!res.ok || !token || !token.Id) {
    throw new Error(`CreateToken 失败: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { id: token.Id, expireMs: Number(token.ExpireTime) * 1000 };
}

/** 取有效 token：缓存 + 并发去重 + 过期前 10 分钟刷新。 */
async function getToken() {
  if (tokenCache && Date.now() < tokenCache.expireMs - 10 * 60 * 1000) return tokenCache.id;
  if (!tokenPromise) {
    tokenPromise = createNlsToken()
      .then((t) => {
        tokenCache = t;
        tokenPromise = null;
        return t.id;
      })
      .catch((err) => {
        tokenPromise = null;
        throw err;
      });
  }
  return tokenPromise;
}

// ── 合成 ──

/**
 * 按 voiceKind（'male' | 'female'）合成 mp3，返回 Buffer。
 * token 恰好过期（24h 边界竞态）时清缓存换新 token 重试一次。
 */
async function synthesize(voiceKind, text, speechRate = 0) {
  const { appkey, voice } = VOICES[voiceKind];
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken();
    const res = await fetch(TTS_GATEWAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NLS-Token': token },
      body: JSON.stringify({
        appkey,
        text,
        voice,
        format: 'mp3',
        sample_rate: 16000,
        volume: 50,
        speech_rate: speechRate,
      }),
    });
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.startsWith('audio/')) {
      return Buffer.from(await res.arrayBuffer());
    }
    let detail = `HTTP ${res.status}`;
    let status = 0;
    try {
      const j = await res.json();
      status = Number(j && j.status) || 0;
      if (j && j.message) detail = `${j.status} ${j.message}`;
    } catch { /* 非 JSON 错误体，保留 HTTP 状态码 */ }
    // 40000001 / 40000004 = token 无效 / 过期
    if (attempt === 0 && (status === 40000001 || status === 40000004)) {
      tokenCache = null;
      continue;
    }
    throw new Error(`语音合成失败（${detail}）`);
  }
  throw new Error('语音合成失败（换新 token 重试后仍失败）');
}

// ── HTTP 处理 ──

/** 上海时区日期串（日限流键口径，同 codes.js）。 */
function shanghaiDateStr() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 语速钳制：取整到 50 的倍数。 */
function clampSpeechRate(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const stepped = Math.round(n / 50) * 50;
  return Math.max(SPEECH_RATE_MIN, Math.min(SPEECH_RATE_MAX, stepped));
}

/** POST /api/tts：{ text, voice, speechRate } → audio/mpeg（需登录 JWT，免费，日限流）。 */
async function handleSynthesize(req, res) {
  const email = verifyToken(req.headers.authorization);
  if (!email) return sendJson(req, res, 401, { error: '请登录后使用语音合成' });

  const body = await readJsonBody(req);
  // 按码点截断（防 emoji 代理对被劈开），再压空白
  const text = (typeof body.text === 'string' ? Array.from(body.text).slice(0, MAX_TEXT_CHARS).join('') : '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return sendJson(req, res, 400, { error: '请输入要合成的文字' });

  const kind = body.voice === 'female' ? 'female' : 'male';
  const speechRate = clampSpeechRate(body.speechRate);

  // 日限流：先占额再合成（合成失败的极少数也计入，换实现简单）
  const used = await db.incrementDaily(db.dailyKey(email, shanghaiDateStr(), 'tts'), 1);
  if (used > DAILY_LIMIT) {
    return sendJson(req, res, 429, { error: `今日合成次数已达上限（${DAILY_LIMIT} 次/天），明天再来` });
  }

  try {
    const audio = await synthesize(kind, text, speechRate);
    // 使用流水：只记次数与字数，用户文本不落库
    try {
      await db.putUsageLog(email, {
        kind: 'stat',
        op: 'tts',
        count: 1,
        meta: `${kind === 'male' ? '男声' : '女声'}·${text.length}字`,
      });
    } catch (_err) { /* 流水失败不影响合成结果 */ }

    applyCors(req, res);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length,
      'Cache-Control': 'no-store',
    });
    return res.end(audio);
  } catch (err) {
    return sendJson(req, res, 502, { error: String((err && err.message) || err) });
  }
}

module.exports = { handleSynthesize, createNlsToken, synthesize };
