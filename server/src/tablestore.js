'use strict';

/**
 * Tablestore（表格存储）数据层。
 *   users             主键 email(string)；属性 passwordHash(string), quota(int), createdAt(int), emailVerified(bool)
 *   redeem_codes      主键 code(string)；属性 credits(int), used(bool), usedBy(string), usedAt(int), createdAt(int)
 *   verify_codes      主键 email(string)；属性 code(string), expiresAt(int), sentAt(int)
 *   daily_limits      主键 key(string)；属性 count(int) / value(bool)
 *   guest_credits     主键 ip(string)；属性 quota(int), createdAt(int)——游客体验额度（按 IP）
 *   usage_log         主键 acct(string), sk(string)；使用流水（看板/额度明细），见下方「使用流水」节
 */

const TableStore = require('tablestore');
const crypto = require('crypto');
const config = require('./config');

const Long = TableStore.Long;
const { RowExistenceExpectation, ComparatorType, ReturnType } = TableStore;

const TABLE_USERS = 'users';
const TABLE_CODES = 'redeem_codes';
const TABLE_VERIFY_CODES = 'verify_codes';
const TABLE_DAILY_LIMITS = 'daily_limits';
const TABLE_GUEST_CREDITS = 'guest_credits';
const TABLE_USAGE_LOG = 'usage_log';

const client = new TableStore.Client({
  accessKeyId: config.tablestore.accessKeyId,
  secretAccessKey: config.tablestore.accessKeySecret,
  endpoint: config.tablestore.endpoint,
  instancename: config.tablestore.instancename,
  maxRetries: 3,
});

/** 判断错误是否为「行条件校验失败」（用于并发保护、唯一性判断）。 */
function isConditionFail(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return err.code === 'OTSConditionCheckFailed' || /ConditionCheckFail/i.test(msg);
}

/** 把 Tablestore 的整数（Int64/Long）安全转成 JS number。 */
function toNumber(v) {
  if (v == null) return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

/** 把 getRow 返回的 attributes 数组转成普通对象。 */
function attrsToObject(row) {
  const out = {};
  if (!row || !Array.isArray(row.attributes)) return out;
  for (const a of row.attributes) out[a.columnName] = a.columnValue;
  return out;
}

/** 行是否存在（getRow 未命中时 row 为空对象，无 primaryKey）。 */
function rowExists(result) {
  return !!(result && result.row && Array.isArray(result.row.primaryKey) && result.row.primaryKey.length);
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

/** 读取用户；不存在返回 null。 */
async function getUser(email) {
  const result = await client.getRow({
    tableName: TABLE_USERS,
    primaryKey: [{ email }],
    maxVersions: 1,
  });
  if (!rowExists(result)) return null;
  const attrs = attrsToObject(result.row);
  return {
    email,
    passwordHash: attrs.passwordHash,
    quota: toNumber(attrs.quota) || 0,
    createdAt: toNumber(attrs.createdAt) || 0,
    emailVerified: attrs.emailVerified === true,
  };
}

/**
 * 创建用户。邮箱已存在时（EXPECT_NOT_EXIST 条件失败）返回 false。
 * emailVerified=false（M6 免验证注册）时额度给游客级、验证后才补发正式赠送额度。
 */
async function createUser(email, passwordHash, credits, emailVerified = true) {
  try {
    await client.putRow({
      tableName: TABLE_USERS,
      condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_NOT_EXIST, null),
      primaryKey: [{ email }],
      attributeColumns: [
        { passwordHash },
        { quota: Long.fromNumber(credits) },
        { createdAt: Long.fromNumber(Date.now()) },
        { emailVerified },
      ],
      returnContent: { returnType: ReturnType.Primarykey },
    });
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false; // 邮箱已注册
    throw err;
  }
}

/**
 * 验证邮箱（M6）：emailVerified false→true 原子翻转并把正式赠送额度 INCREMENT 进余额。
 * 已验证过（条件失败）返回 false，防重复发额。
 */
async function verifyUserEmail(email, freeCredits) {
  try {
    await client.updateRow({
      tableName: TABLE_USERS,
      condition: new TableStore.Condition(
        RowExistenceExpectation.EXPECT_EXIST,
        new TableStore.SingleColumnCondition('emailVerified', false, ComparatorType.EQUAL)
      ),
      primaryKey: [{ email }],
      // ⚠️ PUT 与 INCREMENT 必须拆成两个元素：同元素会让 SDK 客户端序列化崩溃（'The buffer is full'，实测复现）
      updateOfAttributeColumns: [{ PUT: [{ emailVerified: true }] }, { INCREMENT: [{ quota: Long.fromNumber(freeCredits) }] }],
    });
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

/** 更新用户密码哈希。 */
async function updatePassword(email, passwordHash) {
  await client.updateRow({
    tableName: TABLE_USERS,
    condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
    primaryKey: [{ email }],
    updateOfAttributeColumns: [{ PUT: [{ passwordHash }] }],
  });
}

/** 注销账号（PIPL 用户权利）：删除用户行；行不存在返回 false。 */
async function deleteUser(email) {
  try {
    await client.deleteRow({
      tableName: TABLE_USERS,
      condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
      primaryKey: [{ email }],
    });
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 游客体验额度（按 IP，M6）
// ---------------------------------------------------------------------------

/** 读取游客余额；行不存在返回 null。 */
async function getGuestQuota(ip) {
  const result = await client.getRow({
    tableName: TABLE_GUEST_CREDITS,
    primaryKey: [{ ip }],
    maxVersions: 1,
  });
  if (!rowExists(result)) return null;
  const attrs = attrsToObject(result.row);
  return toNumber(attrs.quota) || 0;
}

/** 确保游客行存在（首次使用送 initial 额度），返回当前余额。 */
async function ensureGuest(ip, initial) {
  try {
    await client.putRow({
      tableName: TABLE_GUEST_CREDITS,
      condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_NOT_EXIST, null),
      primaryKey: [{ ip }],
      attributeColumns: [
        { quota: Long.fromNumber(initial) },
        { createdAt: Long.fromNumber(Date.now()) },
      ],
    });
  } catch (err) {
    if (!isConditionFail(err)) throw err; // 已存在 = 正常
  }
  return await getGuestQuota(ip);
}

/**
 * 预扣游客 points 点额度：仅当 quota >= points 时原子自减，返回 true；不足返回 false。
 */
async function reserveGuestCredit(ip, points = 1) {
  try {
    await client.updateRow({
      tableName: TABLE_GUEST_CREDITS,
      condition: new TableStore.Condition(
        RowExistenceExpectation.EXPECT_EXIST,
        new TableStore.SingleColumnCondition('quota', Long.fromNumber(points), ComparatorType.GREATER_EQUAL)
      ),
      primaryKey: [{ ip }],
      updateOfAttributeColumns: [{ INCREMENT: [{ quota: Long.fromNumber(-points) }] }],
    });
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

/** 游客失败退额。 */
async function refundGuestCredit(ip, points = 1) {
  await client.updateRow({
    tableName: TABLE_GUEST_CREDITS,
    condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
    primaryKey: [{ ip }],
    updateOfAttributeColumns: [{ INCREMENT: [{ quota: Long.fromNumber(points) }] }],
  });
}

/** 给用户额度增加 delta（可为负），原子操作。 */
async function addUserQuota(email, delta) {
  await client.updateRow({
    tableName: TABLE_USERS,
    condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
    primaryKey: [{ email }],
    updateOfAttributeColumns: [{ INCREMENT: [{ quota: Long.fromNumber(delta) }] }],
  });
}

/**
 * 预扣 points 点额度：仅当 quota >= points 时原子自减，返回 true；额度不足则返回 false。
 */
async function reserveCredit(email, points = 1) {
  try {
    await client.updateRow({
      tableName: TABLE_USERS,
      condition: new TableStore.Condition(
        RowExistenceExpectation.EXPECT_EXIST,
        new TableStore.SingleColumnCondition('quota', Long.fromNumber(points), ComparatorType.GREATER_EQUAL)
      ),
      primaryKey: [{ email }],
      updateOfAttributeColumns: [{ INCREMENT: [{ quota: Long.fromNumber(-points) }] }],
    });
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false; // 额度不足
    throw err;
  }
}

/** 回补 points 点额度（LLM 调用失败时退款）。 */
async function refundCredit(email, points = 1) {
  await addUserQuota(email, points);
}

// ---------------------------------------------------------------------------
// 兑换码
// ---------------------------------------------------------------------------

/** 创建一个兑换码（生成脚本 / 管理页共用）。已存在返回 false。createdAt 缺省取当前时间。 */
async function createCode(code, credits, createdAt = Date.now()) {
  try {
    await client.putRow({
      tableName: TABLE_CODES,
      condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_NOT_EXIST, null),
      primaryKey: [{ code }],
      attributeColumns: [
        { credits: Long.fromNumber(credits) },
        { used: false },
        { usedBy: '' },
        { usedAt: Long.fromNumber(0) },
        { createdAt: Long.fromNumber(createdAt) },
      ],
      returnContent: { returnType: ReturnType.Primarykey },
    });
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

/**
 * 遍历全部兑换码（GetRange 分页），返回 { codes, truncated }。
 * 行属性：credits / used / usedBy / usedAt / createdAt（2026-10 前旧脚本生成的码没有
 * createdAt 列，读回 0，管理页显示「—」）。扫描顺序 = 主键字典序。
 * ⚠️ 扫描范围限定 ENGT- 前缀（脚本与管理页生成的码都带此前缀）——GetRange 没有
 * 「只取主键」模式（columnsToGet:['__none__'] 静默返回 0 行，见 memory/tablestore-sdk-pitfalls），
 * 列必须全取，故每页 limit=500（单页响应 ≤~75KB），避开 OTS ≥128KB 大响应概率性停摆阈值。
 */
async function listCodes() {
  const end = 'ENGT.'; // '.'(0x2E) > '-'(0x2D)：恰好覆盖全部 ENGT- 开头的主键
  const codes = [];
  let start = 'ENGT-';
  // 页数护栏：40 页 × 500 行 = 2 万行，超出按 truncated 返回（防失控循环）
  for (let page = 0; page < 40; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await client.getRange({
      tableName: TABLE_CODES,
      direction: TableStore.Direction.FORWARD,
      inclusiveStartPrimaryKey: [{ code: start }],
      exclusiveEndPrimaryKey: [{ code: end }],
      limit: 500,
      maxVersions: 1,
    });
    // ⚠️ getRange 的行在 result.rows（复数），与 getRow 的 result.row 不同
    const rows = Array.isArray(result.rows) ? result.rows : [];
    for (const row of rows) {
      const attrs = attrsToObject(row);
      const pk = row.primaryKey.find((p) => p.name === 'code');
      codes.push({
        code: pk ? String(pk.value) : '',
        credits: toNumber(attrs.credits) || 0,
        used: attrs.used === true,
        usedBy: attrs.usedBy || '',
        usedAt: toNumber(attrs.usedAt) || 0,
        createdAt: toNumber(attrs.createdAt) || 0,
      });
    }
    // ⚠️ SDK 的续读游标是驼峰 nextStartPrimaryKey（无 next_start_primary_key 字段）；
    // 缺它时翻页会静默停在第一页。每项形如 { name, value }
    const next = result.nextStartPrimaryKey;
    if (!Array.isArray(next) || !next.length) return { codes, truncated: false };
    const nextPk = next.find((p) => p.name === 'code');
    const nextCode = nextPk ? String(nextPk.value) : '';
    if (!nextCode || nextCode >= end) return { codes, truncated: false };
    start = nextCode;
  }
  return { codes, truncated: true };
}

/**
 * 兑换：原子地把码标记为已用（条件 used == false），成功返回该码面值 credits。
 * 已被用过或不存在时返回 null。防止并发/重复兑换。
 */
async function claimCode(code, email) {
  // 先读出面值（并判断存在性）
  const result = await client.getRow({
    tableName: TABLE_CODES,
    primaryKey: [{ code }],
    maxVersions: 1,
  });
  if (!rowExists(result)) return null;
  const attrs = attrsToObject(result.row);
  if (attrs.used === true) return null;
  const credits = toNumber(attrs.credits) || 0;

  try {
    await client.updateRow({
      tableName: TABLE_CODES,
      condition: new TableStore.Condition(
        RowExistenceExpectation.EXPECT_EXIST,
        new TableStore.SingleColumnCondition('used', false, ComparatorType.EQUAL)
      ),
      primaryKey: [{ code }],
      updateOfAttributeColumns: [
        {
          PUT: [{ used: true }, { usedBy: email }, { usedAt: Long.fromNumber(Date.now()) }],
        },
      ],
    });
  } catch (err) {
    if (isConditionFail(err)) return null; // 已被并发兑换
    throw err;
  }
  return credits;
}

// ---------------------------------------------------------------------------
// 邮箱验证码
// ---------------------------------------------------------------------------

/**
 * 写入验证码（覆盖旧码），有效期 10 分钟。
 */
async function saveVerifyCode(email, code) {
  await client.putRow({
    tableName: TABLE_VERIFY_CODES,
    condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
    primaryKey: [{ email }],
    attributeColumns: [
      { code },
      { expiresAt: Long.fromNumber(Date.now() + 10 * 60 * 1000) },
      { sentAt: Long.fromNumber(Date.now()) },
    ],
  });
}

/**
 * 校验验证码。成功后删掉该行（防止重复用）。返回 true 表示通过。
 * ⚠️ 防在线穷举：连续错 VERIFY_CODE_MAX_FAILS 次即作废该码（删行），
 * 用户重新发码即可（发码端有 60s 节流）。不设防的话 6 位码可在 10 分钟
 * 有效期内被穷举，进而经重置密码路径接管任意账号。
 */
const VERIFY_CODE_MAX_FAILS = 5;

async function checkVerifyCode(email, code) {
  const result = await client.getRow({
    tableName: TABLE_VERIFY_CODES,
    primaryKey: [{ email }],
    maxVersions: 1,
  });
  if (!rowExists(result)) return false;
  const attrs = attrsToObject(result.row);
  const storedCode = attrs.code;
  const expiresAt = toNumber(attrs.expiresAt) || 0;
  const fails = toNumber(attrs.fails) || 0;
  if (fails >= VERIFY_CODE_MAX_FAILS) {
    // 连错太多次：作废该码，逼用户重新发码
    await client.deleteRow({
      tableName: TABLE_VERIFY_CODES,
      primaryKey: [{ email }],
      condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
    });
    return false;
  }
  if (Date.now() > expiresAt || String(storedCode) !== String(code)) {
    // 记失败次数（原列写回，避免 putRow 整行覆盖丢掉 expiresAt/sentAt——
    // 丢了 sentAt 会重置 60s 发码节流，丢了 expiresAt 会把码续命 10 分钟）
    await client.putRow({
      tableName: TABLE_VERIFY_CODES,
      condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
      primaryKey: [{ email }],
      attributeColumns: [
        { code: storedCode },
        { expiresAt: Long.fromNumber(expiresAt) },
        { sentAt: Long.fromNumber(toNumber(attrs.sentAt) || Date.now()) },
        { fails: Long.fromNumber(fails + 1) },
      ],
    });
    return false;
  }
  // 用过即删
  await client.deleteRow({
    tableName: TABLE_VERIFY_CODES,
    primaryKey: [{ email }],
    condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
  });
  return true;
}

// ---------------------------------------------------------------------------
// 每日限额
// ---------------------------------------------------------------------------

/** 日计数器 key */
function dailyKey(email, dateStr, suffix) {
  return `${email}#${dateStr}#${suffix}`;
}

/** 原子自增日计数器，返回自增后的值。 */
async function incrementDaily(key, delta = 1) {
  const result = await client.updateRow({
    tableName: TABLE_DAILY_LIMITS,
    condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
    primaryKey: [{ key }],
    updateOfAttributeColumns: [{ INCREMENT: [{ count: Long.fromNumber(delta) }] }],
    // ⚠️ 字段名必须是 returnColumns：SDK encoder 只认它（returnColumnNames 会被
    // 静默忽略 → AfterModify 返回空行，计数器永远拿不到真实值）
    returnContent: { returnType: ReturnType.AfterModify, returnColumns: ['count'] },
  });
  if (result && result.row && Array.isArray(result.row.attributes)) {
    for (const a of result.row.attributes) {
      if (a.columnName === 'count') return toNumber(a.columnValue);
    }
  }
  return delta; // 刚创建的，初始值即 delta
}

/** 设置一个布尔标记（如解锁状态）。 */
async function setDailyFlag(key) {
  await client.putRow({
    tableName: TABLE_DAILY_LIMITS,
    condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
    primaryKey: [{ key }],
    attributeColumns: [{ value: true }],
  });
}

/** 查询某个 key 是否存在（用于判断解锁状态等）。 */
async function getDailyFlag(key) {
  const result = await client.getRow({
    tableName: TABLE_DAILY_LIMITS,
    primaryKey: [{ key }],
    maxVersions: 1,
  });
  return rowExists(result);
}

/** 读取日计数器当前值（行不存在返回 0）。 */
async function getDailyCount(key) {
  const result = await client.getRow({
    tableName: TABLE_DAILY_LIMITS,
    primaryKey: [{ key }],
    maxVersions: 1,
  });
  if (!rowExists(result)) return 0;
  return toNumber(attrsToObject(result.row).count) || 0;
}

// ---------------------------------------------------------------------------
// 使用流水（usage_log：看板聚合 + 额度明细）
// ---------------------------------------------------------------------------

/** 反转时间戳（16 位零填充）：sk 升序 = 时间降序，FORWARD 扫描即最新在前。 */
function reverseTs(ms) {
  return String(Number.MAX_SAFE_INTEGER - ms).padStart(16, '0');
}

/**
 * 写一条使用流水。acctKey = email 或 `guest:${ip}`。
 * 字段：kind(llm|redeem|grant|unlock|stat) / op / cost / gain / count(stat 数量) / meta(≤64 字符结构化值)。
 * sk 缺省按当前时间随机生成；回填脚本传入确定性 sk（含兑换码）保证重跑幂等。
 * ⚠️ 调用方必须 await（函数平台可能在响应后冻结容器，fire-and-forget 可能永不执行），
 * 且自行 try/catch——日志失败绝不能影响主响应。meta 只放结构化值（兑换码等），禁止自由文本（PII 铁律）。
 */
async function putUsageLog(acctKey, { kind, op, cost = 0, gain = 0, count = null, meta = '', sk = null }) {
  const now = Date.now();
  const key = sk || `${reverseTs(now)}-${crypto.randomBytes(4).toString('hex')}`;
  await client.putRow({
    tableName: TABLE_USAGE_LOG,
    condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
    primaryKey: [{ acct: acctKey }, { sk: key }],
    attributeColumns: [
      { kind },
      { op },
      { cost: Long.fromNumber(cost) },
      { gain: Long.fromNumber(gain) },
      { createdAt: Long.fromNumber(now) },
      ...(count != null ? [{ count: Long.fromNumber(count) }] : []),
      ...(meta ? [{ meta: String(meta).slice(0, 64) }] : []),
    ],
  });
}

/**
 * 按账号倒序读使用流水（FORWARD 扫 sk 升序 = 时间降序），返回 { rows, nextCursor }。
 *   type: 'all' | 'charge'(redeem|grant) | 'spend'(llm|unlock|stat)——服务端过滤，保证游标分页正确
 *   cursor: 上一页返回的 nextCursor（= 那一页最后一行的 sk）；续读起点是含行，需跳过首行去重
 * 行很小（~120B），单页 limit=100（响应 ~12KB），最多内部翻 3 页凑满 limit，远离 128KB 停摆阈值。
 */
async function listUsageLog(acctKey, { limit = 50, cursor = '', type = 'all' } = {}) {
  const cap = Math.min(Math.max(1, limit | 0 || 50), 200);
  const KIND_SETS = {
    charge: new Set(['redeem', 'grant']),
    spend: new Set(['llm', 'unlock', 'stat']),
  };
  const kinds = KIND_SETS[type] || null;
  const rows = [];
  let nextCursor = null;
  let start = cursor || TableStore.INF_MIN;
  let skipFirst = !!cursor;
  for (let page = 0; page < 3 && rows.length < cap; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await client.getRange({
      tableName: TABLE_USAGE_LOG,
      direction: TableStore.Direction.FORWARD,
      inclusiveStartPrimaryKey: [{ acct: acctKey }, { sk: start }],
      exclusiveEndPrimaryKey: [{ acct: acctKey }, { sk: TableStore.INF_MAX }],
      limit: 100,
      maxVersions: 1,
    });
    const got = Array.isArray(result.rows) ? result.rows : [];
    let stoppedEarly = false; // 凑满 cap 提前停收：本页可能还有没消费的行
    let lastSk = '';
    for (const row of got) {
      const pk = row.primaryKey.find((p) => p.name === 'sk');
      const sk = pk ? String(pk.value) : '';
      if (skipFirst && sk === cursor) { skipFirst = false; continue; }
      const a = attrsToObject(row);
      if (kinds && !kinds.has(a.kind)) continue;
      rows.push({
        sk,
        kind: a.kind,
        op: a.op,
        cost: toNumber(a.cost) || 0,
        gain: toNumber(a.gain) || 0,
        count: a.count == null ? null : toNumber(a.count),
        meta: a.meta || '',
        createdAt: toNumber(a.createdAt) || 0,
      });
      lastSk = sk;
      if (rows.length >= cap) { stoppedEarly = true; break; }
    }
    // ⚠️ 驼峰 nextStartPrimaryKey；缺失 = GetRange 已扫到底
    const next = result.nextStartPrimaryKey;
    const hasContinuation = Array.isArray(next) && next.length > 0;
    if (rows.length >= cap) {
      // 凑满 cap 只说明「这一批够了」，不说明「后面没数据」：
      // - 本页提前停收 → 从最后收进行之后续读（下一页可能复扫本页尾部）
      // - 恰好收完本页且有续读游标 → 从游标续读
      // - 恰好收完本页且已到底 → 真没有更多了
      if (stoppedEarly) nextCursor = lastSk;
      else if (hasContinuation) {
        const nextSk = next.find((p) => p.name === 'sk');
        nextCursor = nextSk ? String(nextSk.value !== undefined ? nextSk.value : nextSk.columnValue) : null;
      }
      if (nextCursor) break;
    }
    if (!hasContinuation) break;
    const nextSk = next.find((p) => p.name === 'sk');
    const nextVal = nextSk ? String(nextSk.value !== undefined ? nextSk.value : nextSk.columnValue) : '';
    if (!nextVal) break;
    start = nextVal;
  }
  return { rows, nextCursor };
}

/**
 * 聚合整账号流水（看板一次拉全量）：总支出/总获得、本月（上海时区）支出、
 * 各 op 次数（count ?? 1）、stat 类累计数量、近 400 天按上海日聚合的支出（热力图/趋势）。
 * BACKWARD 从最新往回扫（500 行/页，护栏 20 页 = 1 万行）——万一触护栏截断，
 * 丢的是最旧数据（lifetime 总数偏小）而近期热力图仍完整，partial 置 true 供前端提示。
 */
async function usageSummary(email, quota) {
  const SH_OFFSET = 8 * 60 * 60 * 1000;
  const now = Date.now();
  const monthPrefix = new Date(now + SH_OFFSET).toISOString().slice(0, 7); // YYYY-MM
  const cutoff = now - 400 * 24 * 60 * 60 * 1000;
  const out = { quota, totalSpent: 0, totalGained: 0, monthSpent: 0, ops: {}, statTotals: {}, daily: {}, partial: false };
  let start = TableStore.INF_MAX;
  for (let page = 0; page < 20; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await client.getRange({
      tableName: TABLE_USAGE_LOG,
      direction: TableStore.Direction.BACKWARD,
      inclusiveStartPrimaryKey: [{ acct: email }, { sk: start }],
      exclusiveEndPrimaryKey: [{ acct: email }, { sk: TableStore.INF_MIN }],
      limit: 500,
      maxVersions: 1,
    });
    for (const row of (Array.isArray(result.rows) ? result.rows : [])) {
      const a = attrsToObject(row);
      const cost = toNumber(a.cost) || 0;
      const gain = toNumber(a.gain) || 0;
      const createdAt = toNumber(a.createdAt) || 0;
      out.totalSpent += cost;
      out.totalGained += gain;
      if (a.kind === 'llm' || a.kind === 'stat' || a.kind === 'unlock') {
        out.ops[a.op] = (out.ops[a.op] || 0) + (a.count != null ? toNumber(a.count) : 1);
      }
      if (a.kind === 'stat') {
        out.statTotals[a.op] = (out.statTotals[a.op] || 0) + (toNumber(a.count) || 0);
      }
      // 上海日/月口径（勿用 index.js word 计数器的 UTC 旧口径）
      const sh = new Date(createdAt + SH_OFFSET).toISOString();
      if (sh.slice(0, 7) === monthPrefix) out.monthSpent += cost;
      if (createdAt >= cutoff && cost > 0) {
        const day = sh.slice(0, 10);
        out.daily[day] = (out.daily[day] || 0) + cost;
      }
    }
    const next = result.nextStartPrimaryKey;
    if (!Array.isArray(next) || !next.length) return out;
    const nsk = next.find((p) => p.name === 'sk');
    const nval = nsk ? String(nsk.value !== undefined ? nsk.value : nsk.columnValue) : '';
    if (!nval) return out;
    start = nval;
  }
  out.partial = true;
  return out;
}

module.exports = {
  client,
  TableStore,
  TABLE_USERS,
  TABLE_CODES,
  TABLE_VERIFY_CODES,
  TABLE_DAILY_LIMITS,
  getUser,
  createUser,
  updatePassword,
  deleteUser,
  verifyUserEmail,
  TABLE_GUEST_CREDITS,
  getGuestQuota,
  ensureGuest,
  reserveGuestCredit,
  refundGuestCredit,
  addUserQuota,
  reserveCredit,
  refundCredit,
  createCode,
  claimCode,
  listCodes,
  saveVerifyCode,
  checkVerifyCode,
  incrementDaily,
  setDailyFlag,
  getDailyFlag,
  getDailyCount,
  TABLE_USAGE_LOG,
  putUsageLog,
  listUsageLog,
  usageSummary,
  rowExists,
  attrsToObject,
  toNumber,
  isConditionFail,
  dailyKey,
};
