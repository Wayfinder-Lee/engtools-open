'use strict';

/**
 * 环境变量解析与校验。
 *
 * 生产环境：变量在运行平台的环境变量配置里设置。
 * 本地开发/脚本：可在 server/.env 里写 KEY=VALUE（本文件会自动读取，无需依赖 dotenv）。
 */

const fs = require('fs');
const path = require('path');

// 本地便利：若存在 server/.env，则把其中未设置的变量注入 process.env
(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 去掉可选的包裹引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`缺少必需的环境变量: ${name}`);
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const config = {
  // 服务端口：默认监听 9000
  port: parseInt(optional('FC_SERVER_PORT', optional('PORT', '9000')), 10),

  // JWT（服务端启动时校验，见 assertServerConfig）
  jwtSecret: optional('JWT_SECRET', ''),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '30d'),

  // LLM 上游（任一 OpenAI 兼容接口；服务端启动时校验）
  llmEndpoint: optional('LLM_ENDPOINT', ''),
  llmApiKey: optional('LLM_API_KEY', ''),

  // CORS 白名单：逗号分隔的多个来源
  allowedOrigins: optional('ALLOWED_ORIGIN', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Tablestore
  tablestore: {
    endpoint: required('TABLESTORE_ENDPOINT'),
    instancename: required('TABLESTORE_INSTANCE'),
    accessKeyId: required('TABLESTORE_AK_ID'),
    accessKeySecret: required('TABLESTORE_AK_SECRET'),
  },

  // 邮箱发送（nodemailer SMTP）—— 用于发验证码
  smtp: {
    host: optional('SMTP_HOST', 'smtp.qq.com'),
    port: parseInt(optional('SMTP_PORT', '465'), 10),
    secure: optional('SMTP_SECURE', 'true') === 'true',
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    from: optional('SMTP_FROM', optional('SMTP_USER', '')),
  },

  // 听力 TTS：
  // 前四项任缺其一 → tts.js 模块加载即抛错，该功能自动停用（可摘除模式）
  tts: {
    accessKeyId: optional('NLS_AK_ID', ''),
    accessKeySecret: optional('NLS_AK_SECRET', ''),
    appkeyMale: optional('NLS_APPKEY_MALE', ''),   // 男声项目 AppKey（发音人艾达）
    appkeyFemale: optional('NLS_APPKEY_FEMALE', ''), // 女声项目 AppKey（发音人艾佳）
    dailyLimit: parseInt(optional('TTS_DAILY_LIMIT', '100'), 10), // 每人每日合成次数
  },

  // 业务参数
  freeCredits: parseInt(optional('FREE_CREDITS', '10'), 10), // 注册赠送额度（验证邮箱后发放）
  guestCredits: parseInt(optional('GUEST_CREDITS', '100'), 10), // 游客体验额度（按 IP，M6）
  unverifiedCredits: parseInt(optional('UNVERIFIED_CREDITS', '10'), 10), // 免验证注册的初始额度（防批量小号薅 LLM；验证邮箱后补发 FREE_CREDITS）
  maxBodyBytes: parseInt(optional('MAX_BODY_BYTES', String(10 * 1024 * 1024)), 10), // 请求体上限（OCR 图片 base64 需较大）
};

/**
 * 校验「运行 HTTP 服务」所必需的变量（脚本无需这些，故不在模块加载时强制）。
 * 由 index.js 在启动时调用。
 */
config.assertServerConfig = function assertServerConfig() {
  const missing = [];
  if (!config.jwtSecret) missing.push('JWT_SECRET');
  if (!config.llmEndpoint) missing.push('LLM_ENDPOINT');
  if (!config.llmApiKey) missing.push('LLM_API_KEY');
  if (missing.length) throw new Error(`缺少必需的环境变量: ${missing.join(', ')}`);
};

module.exports = config;
