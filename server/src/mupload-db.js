'use strict';

/**
 * 扫码拍照上传（m-upload）的数据层。
 *
 * ⚠️ 本文件是「扫码上传」功能的全部数据库代码，可整体摘除：
 *    删掉本文件 + src/mupload.js + 根目录 m-upload.html + src/m/，
 *    再删掉 index.js 里的路由注册与 init-tables.js 里的 ensureTables 调用即可。
 *
 * 四张表：
 *   mupload_tasks   主键 ownerEmail+taskId；属性 tool, label, createdAt, expiresAt,
 *                   closed, tokenSeq, sess, deviceBound, photoCount
 *   mupload_index   主键 taskId；属性 owner, createdAt —— 手机端只持 tid，
 *                   经此表定位任务行（token/URL 里不放老师邮箱）
 *   mupload_photos  主键 taskId+photoId；属性 seq, uploadedAt, complete, chunkCount,
 *                   size, w, h, blur, bright, imported, thumb —— 只存元数据与缩略图
 *   mupload_chunks  主键 taskId+key；属性 data —— key = `${photoId}#${两位序号}`,
 *                   每行 ≤ CHUNK_CHARS 字符
 *
 * ⚠️ 为什么照片要分块（P0 尖峰实测结论）：
 *    Tablestore 单行上限 2MB，写入 1MB+ 均成功；但**读路径**在真实实例上
 *    （跨公网访问托管数据库）≥128KB 的响应体概率性中途停摆——
 *    先快速到达 ~480KB，随后静默 30s，socket 干净关闭（无 end 无 error），
 *    SDK promise 永不 resolve。32/64KB 实测 43/43 稳定（含 4 并发突发）。
 *    因此照片按 64KB 分块存储：任何一次 OTS 请求/响应都不超过安全阈值。
 *    所有 SDK 调用另包超时 + 读重试（getSafe），挂起时快速失败而不是卡死服务。
 *
 * ⚠️ 隐私：照片行不存学生姓名（姓名只在前端识别后的 state）；表里只有
 *    taskId/photoId/deviceId/ownerEmail 这类标识符。
 */

const {
  client,
  TableStore,
  rowExists,
  attrsToObject,
  toNumber,
  isConditionFail,
} = require('./tablestore');

const Long = TableStore.Long;
const { RowExistenceExpectation, ComparatorType, ReturnType } = TableStore;

const TABLE_MU_TASKS = 'mupload_tasks';
const TABLE_MU_INDEX = 'mupload_index';
const TABLE_MU_PHOTOS = 'mupload_photos';
const TABLE_MU_CHUNKS = 'mupload_chunks';

/** 单块最大字符数：实测安全读阈值 64KB（43/43 稳定），128KB 起概率性停摆 */
const CHUNK_CHARS = 64 * 1024;
/** 单张照片块数上限（服务端 MAX_DATAURL_CHARS=1.4M ÷ 64KB 向上取整） */
const MAX_CHUNKS_PER_PHOTO = 22;
/** 单任务照片上限（分配超出即回滚 + 409） */
const MAX_PHOTOS = 99;
/** 任务存活时长（「最长 24 小时自动清理」文案的依据） */
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
/** 缩略图列上限（手机端生成 ~320px JPEG dataURL；超长直接丢弃不影响主流程） */
const THUMB_MAX_CHARS = 24000;

// ---------------------------------------------------------------------------
// 基础设施：超时包装 + 读重试（SDK 无默认 socket 超时，大响应停摆会永久挂起）
// ---------------------------------------------------------------------------

const READ_TIMEOUT_MS = 15000;

function sdkTimeout(promise, ms = READ_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => {
        const e = new Error('Tablestore 响应超时（疑似大响应停摆）');
        e.code = 'MU_DB_TIMEOUT';
        reject(e);
      }, ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

/** getRow + 超时 + 重试 1 次（读是幂等的）。 */
async function getRowSafe(params) {
  try {
    return await sdkTimeout(client.getRow(params));
  } catch (err) {
    if (err.code === 'MU_DB_TIMEOUT') return sdkTimeout(client.getRow(params));
    throw err;
  }
}

/** getRange + 超时 + 重试 1 次（读是幂等的）。 */
async function getRangeSafe(params) {
  try {
    return await sdkTimeout(client.getRange(params));
  } catch (err) {
    if (err.code === 'MU_DB_TIMEOUT') return sdkTimeout(client.getRange(params));
    throw err;
  }
}

/** 瞬时错误判定：读停摆超时 / 网络层断连（跨公网链路 ECONNRESET 属常态）。 */
function isTransientDbError(err) {
  if (!err) return false;
  if (err.code === 'MU_DB_TIMEOUT' || err.code === 'NetworkingError') return true;
  return /ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|ECONNREFUSED/.test(err.message || '');
}

/**
 * 幂等操作专用：超时/瞬时网络错误重试 1 次。
 * ⚠️ 只能包「重复执行无副作用」的操作——纯读、DELETE/PUT IGNORE、写同值；
 * INCREMENT、EXPECT_NOT_EXIST 占位这类不可重复的操作绝不能用（会双重计数）。
 */
async function idemRetry(fn) {
  try {
    return await sdkTimeout(fn());
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    return sdkTimeout(fn());
  }
}

/** 从一行里按列名取主键值（兼容 {name,value} / {columnName,columnValue} 两种形状）。 */
function pkOf(row, name) {
  const pk = (row && row.primaryKey) || [];
  for (const k of pk) {
    if ((k.name || k.columnName) === name) {
      return k.value !== undefined ? k.value : k.columnValue;
    }
  }
  return undefined;
}

/**
 * 范围查询并自动翻页。
 * startPK/endPK 形如 [{ taskId: 'x', photoId: TableStore.INF_MIN }, ...]。
 * ⚠️ 翻页续扫要按列名重建起点：若调用方把多列塞进同一个对象（合并式），这里先
 * 拆成单列条目再发——否则列名数组只取到第一列，续扫第二列的名字会变成
 * "undefined"，OTS 报 Validate PK name fail（首扫不受影响，纯翻页坑）。
 */
async function rangeAll(tableName, startPK, endPK, options = {}) {
  const flat = (pk) => pk.flatMap((o) => Object.entries(o).map(([name, value]) => ({ [name]: value })));
  const pkNames = flat(startPK).map((o) => Object.keys(o)[0]);
  const params = {
    tableName,
    direction: TableStore.Direction.FORWARD,
    maxVersions: 1,
    inclusiveStartPrimaryKey: flat(startPK),
    exclusiveEndPrimaryKey: flat(endPK),
    limit: options.limit || 500,
  };
  if (options.columnsToGet) params.columnsToGet = options.columnsToGet;

  const out = [];
  for (let page = 0; page < 20; page += 1) {
    const res = await getRangeSafe(params);
    out.push(...((res && res.rows) || []));
    const next = res && res.nextStartPrimaryKey;
    if (!next || !next.length) break;
    params.inclusiveStartPrimaryKey = next.map((k, i) => {
      const val = k.value !== undefined ? k.value : k.columnValue;
      return { [pkNames[i]]: val };
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 表
// ---------------------------------------------------------------------------

const TABLE_DEFS = {
  [TABLE_MU_TASKS]: [
    { name: 'ownerEmail', type: TableStore.PrimaryKeyType.STRING },
    { name: 'taskId', type: TableStore.PrimaryKeyType.STRING },
  ],
  [TABLE_MU_INDEX]: [{ name: 'taskId', type: TableStore.PrimaryKeyType.STRING }],
  [TABLE_MU_PHOTOS]: [
    { name: 'taskId', type: TableStore.PrimaryKeyType.STRING },
    { name: 'photoId', type: TableStore.PrimaryKeyType.STRING },
  ],
  [TABLE_MU_CHUNKS]: [
    { name: 'taskId', type: TableStore.PrimaryKeyType.STRING },
    { name: 'key', type: TableStore.PrimaryKeyType.STRING },
  ],
};

async function createIfAbsent(tableName) {
  try {
    await client.createTable({
      tableMeta: { tableName, primaryKey: TABLE_DEFS[tableName] },
      reservedThroughput: { capacityUnit: { read: 0, write: 0 } },
      tableOptions: { timeToLive: -1, maxVersions: 1 },
    });
    console.log(`✅ 已创建表 ${tableName}`);
  } catch (err) {
    const msg = String(err.message || err);
    if (/OTSObjectAlreadyExist|already exist/i.test(msg)) {
      console.log(`ℹ️  表 ${tableName} 已存在，跳过`);
    } else {
      throw err;
    }
  }
}

/** 建好本功能需要的 4 张表（已存在则跳过）。init-tables.js 可选加载调用。 */
async function ensureTables() {
  for (const tableName of Object.keys(TABLE_DEFS)) {
    await createIfAbsent(tableName);
  }
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

/** 任务行属性 → 普通对象。 */
function taskFromRow(row) {
  const a = attrsToObject(row);
  return {
    ownerEmail: pkOf(row, 'ownerEmail'),
    taskId: pkOf(row, 'taskId'),
    tool: a.tool || 'handwriting',
    label: a.label || '',
    createdAt: toNumber(a.createdAt) || 0,
    expiresAt: toNumber(a.expiresAt) || 0,
    closed: a.closed === true,
    tokenSeq: toNumber(a.tokenSeq) || 0,
    sess: toNumber(a.sess) || 0,
    deviceBound: a.deviceBound || '',
    photoCount: Math.max(0, toNumber(a.photoCount) || 0),
  };
}

/** 创建任务（taskId 已由调用方生成并保证唯一）。 */
async function createTask(ownerEmail, taskId, { tool, label, now }) {
  await sdkTimeout(client.putRow({
    tableName: TABLE_MU_INDEX,
    condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_NOT_EXIST, null),
    primaryKey: [{ taskId }],
    attributeColumns: [
      { owner: ownerEmail },
      { createdAt: Long.fromNumber(now) },
    ],
  }));
  await sdkTimeout(client.putRow({
    tableName: TABLE_MU_TASKS,
    condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_NOT_EXIST, null),
    primaryKey: [{ ownerEmail }, { taskId }],
    attributeColumns: [
      { tool },
      { label },
      { createdAt: Long.fromNumber(now) },
      { expiresAt: Long.fromNumber(now + TASK_TTL_MS) },
      { closed: false },
      { tokenSeq: Long.fromNumber(1) },
      { sess: Long.fromNumber(1) },
      { deviceBound: '-' },
      { photoCount: Long.fromNumber(0) },
    ],
  }));
}

/** 经 index 表定位任务（手机端只有 tid）。不存在返回 null。 */
async function getTaskByIndex(taskId) {
  const res = await getRowSafe({
    tableName: TABLE_MU_INDEX,
    primaryKey: [{ taskId }],
    maxVersions: 1,
  });
  if (!rowExists(res)) return null;
  const owner = attrsToObject(res.row).owner;
  if (!owner) return null;
  return getTask(owner, taskId);
}

async function getTask(ownerEmail, taskId) {
  const res = await getRowSafe({
    tableName: TABLE_MU_TASKS,
    primaryKey: [{ ownerEmail }, { taskId }],
    maxVersions: 1,
  });
  if (!rowExists(res)) return null;
  return taskFromRow(res.row);
}

/** 列出某老师的全部任务（找「已有未结束任务」用；行小，全量拉回）。 */
async function listTasksOfOwner(ownerEmail) {
  const rows = await rangeAll(
    TABLE_MU_TASKS,
    [{ ownerEmail, taskId: TableStore.INF_MIN }],
    [{ ownerEmail, taskId: TableStore.INF_MAX }]
  );
  return rows.map(taskFromRow);
}

/**
 * 刷新二维码（换绑）：tokenSeq+1、sess+1、deviceBound 清空。
 * 返回自增后的 { tokenSeq, sess }（读不到返回值时由调用方回读任务行）。
 * PUT 与 INCREMENT 必须拆元素（tablestore.js:120 既有教训）。
 */
async function rotateTask(ownerEmail, taskId) {
  const res = await sdkTimeout(client.updateRow({
    tableName: TABLE_MU_TASKS,
    condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
    primaryKey: [{ ownerEmail }, { taskId }],
    updateOfAttributeColumns: [
      { PUT: [{ deviceBound: '-' }] },
      { INCREMENT: [{ tokenSeq: Long.fromNumber(1) }] },
      { INCREMENT: [{ sess: Long.fromNumber(1) }] },
    ],
    returnContent: {
      returnType: ReturnType.AfterModify,
      returnColumns: ['tokenSeq', 'sess'],
    },
  }));
  const out = { tokenSeq: 0, sess: 0 };
  if (res && res.row && Array.isArray(res.row.attributes)) {
    for (const a of res.row.attributes) {
      if (a.columnName === 'tokenSeq') out.tokenSeq = toNumber(a.columnValue) || 0;
      if (a.columnName === 'sess') out.sess = toNumber(a.columnValue) || 0;
    }
  }
  return out;
}

/** 关闭任务（先关后删，挡住并发上传）。PUT 同值幂等，可安全重试。 */
async function closeTask(ownerEmail, taskId) {
  await idemRetry(() => client.updateRow({
    tableName: TABLE_MU_TASKS,
    condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
    primaryKey: [{ ownerEmail }, { taskId }],
    updateOfAttributeColumns: [{ PUT: [{ closed: true }] }],
  }));
}

/** 删除任务行 + index 行。 */
async function deleteTaskRows(ownerEmail, taskId) {
  await idemRetry(() => client.deleteRow({
    tableName: TABLE_MU_TASKS,
    condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
    primaryKey: [{ ownerEmail }, { taskId }],
  }));
  await idemRetry(() => client.deleteRow({
    tableName: TABLE_MU_INDEX,
    condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
    primaryKey: [{ taskId }],
  }));
}

/**
 * 记录扫码设备（任意设备均可连接：后连者覆盖，仅作记录、不做限制）。
 * 幂等写同值，可安全重试。
 */
async function markDevice(ownerEmail, taskId, deviceId) {
  await sdkTimeout(client.updateRow({
    tableName: TABLE_MU_TASKS,
    condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
    primaryKey: [{ ownerEmail }, { taskId }],
    updateOfAttributeColumns: [{ PUT: [{ deviceBound: deviceId }] }],
  }));
}

/** photoCount 原子 +delta，返回新值（用于分配 seq）。条件：任务存在且未关闭。 */
async function bumpPhotoCount(ownerEmail, taskId, delta) {
  const res = await sdkTimeout(client.updateRow({
    tableName: TABLE_MU_TASKS,
    condition: new TableStore.Condition(
      RowExistenceExpectation.EXPECT_EXIST,
      new TableStore.SingleColumnCondition('closed', false, ComparatorType.EQUAL)
    ),
    primaryKey: [{ ownerEmail }, { taskId }],
    updateOfAttributeColumns: [{ INCREMENT: [{ photoCount: Long.fromNumber(delta) }] }],
    // ⚠️ SDK encoder 读的是 returnColumns（不是 returnColumnNames，写错了会静默返回空行）
    returnContent: {
      returnType: ReturnType.AfterModify,
      returnColumns: ['photoCount'],
    },
  }));
  if (res && res.row && Array.isArray(res.row.attributes)) {
    for (const a of res.row.attributes) {
      if (a.columnName === 'photoCount') return toNumber(a.columnValue);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 照片（元数据 + 分块）
// ---------------------------------------------------------------------------

function chunkKey(photoId, idx) {
  return `${photoId}#${String(idx).padStart(2, '0')}`;
}

/** 把 dataURL 字符串切成 ≤CHUNK_CHARS 的块。 */
function chunkify(dataUrl) {
  const out = [];
  for (let i = 0; i < dataUrl.length; i += CHUNK_CHARS) {
    out.push(dataUrl.slice(i, i + CHUNK_CHARS));
  }
  return out;
}

function photoPk(taskId, photoId) {
  return [{ taskId }, { photoId }];
}

/** 读照片元数据行；不存在返回 null。 */
async function getPhotoMeta(taskId, photoId, columnsToGet) {
  const params = {
    tableName: TABLE_MU_PHOTOS,
    primaryKey: photoPk(taskId, photoId),
    maxVersions: 1,
  };
  if (columnsToGet) params.columnsToGet = columnsToGet;
  const res = await getRowSafe(params);
  if (!rowExists(res)) return null;
  const a = attrsToObject(res.row);
  return {
    photoId,
    seq: toNumber(a.seq) || 0,
    uploadedAt: toNumber(a.uploadedAt) || 0,
    complete: a.complete === true,
    chunkCount: toNumber(a.chunkCount) || 0,
    size: toNumber(a.size) || 0,
    w: toNumber(a.w) || 0,
    h: toNumber(a.h) || 0,
    blur: toNumber(a.blur) || 0,
    bright: toNumber(a.bright) || 0,
    imported: a.imported === true,
    hasThumb: typeof a.thumb === 'string' && a.thumb.length > 0,
    thumb: typeof a.thumb === 'string' ? a.thumb : '',
  };
}

/** 列出任务全部照片元数据行（raw），按 seq 升序。 */
async function listPhotoRows(taskId, columnsToGet) {
  const rows = await rangeAll(
    TABLE_MU_PHOTOS,
    [{ taskId, photoId: TableStore.INF_MIN }],
    [{ taskId, photoId: TableStore.INF_MAX }],
    columnsToGet ? { columnsToGet } : {}
  );
  return rows;
}

/** 照片元数据行 → 普通对象（含 photoId 主键）。 */
function photoFromRow(row) {
  const a = attrsToObject(row);
  return {
    photoId: pkOf(row, 'photoId'),
    seq: toNumber(a.seq) || 0,
    uploadedAt: toNumber(a.uploadedAt) || 0,
    complete: a.complete === true,
    chunkCount: toNumber(a.chunkCount) || 0,
    size: toNumber(a.size) || 0,
    w: toNumber(a.w) || 0,
    h: toNumber(a.h) || 0,
    blur: toNumber(a.blur) || 0,
    bright: toNumber(a.bright) || 0,
    imported: a.imported === true,
  };
}

/** 已完成且未识别的照片数（close 确认卡 / 建新任务 409 用）。 */
async function countUnimportedPhotos(taskId) {
  const rows = await listPhotoRows(taskId, ['imported', 'complete']);
  return rows.map(photoFromRow).filter((p) => p.complete && !p.imported).length;
}

/** 写一批 chunk 行（IGNORE 条件，幂等覆盖；每波 4 行 batch 写入）。 */
async function writeChunks(taskId, photoId, chunks) {
  for (let start = 0; start < chunks.length; start += 4) {
    const rows = chunks.slice(start, start + 4).map((data, j) => ({
      type: 'PUT',
      primaryKey: [{ taskId }, { key: chunkKey(photoId, start + j) }],
      attributeColumns: [{ data }],
      // ⚠️ batch 行必须显式带 condition：SDK 的 proto 编码器无条件调用
      // Condition.encode(message.condition)，缺省会在客户端直接 TypeError
      condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
    }));
    const res = await idemRetry(() => client.batchWriteRow({
      tables: [{ tableName: TABLE_MU_CHUNKS, rows }],
    }));
    for (const r of (res && res.tables) || []) {
      if (!r.isOk) throw new Error(`chunk 写入失败: ${r.errorCode || ''} ${r.errorMessage || ''}`);
    }
  }
}

/**
 * 上传一张照片（幂等协议）。
 * 返回 { seq, photoCount, replaced }。
 *   replaced=true  同 photoId 重传且原照片已完整 → 只覆盖数据，seq/计数不变
 *
 * 时序（防幽灵行/重复计数）：
 *   1. PutRow 元数据占位（EXPECT_NOT_EXIST, complete=false, seq=0）
 *   2. 条件 INCREMENT photoCount（closed==false）→ 得 seq；>MAX 回滚 + 409
 *   3. 占位行 PUT seq（崩溃恢复的标记：seq>0 = 已分配）
 *   4. batchWrite 写全部 chunk（IGNORE，幂等覆盖）
 *   5. 占位行 PUT complete=true
 * 已有行时：complete=true → 走覆盖路径；complete=false → 崩溃恢复
 * （seq>0 跳过分配，seq=0 重新分配）。
 */
async function uploadPhoto({ ownerEmail, taskId, photoId, dataUrl, size, w, h, blur, bright, thumb, now }) {
  const chunks = chunkify(dataUrl);
  const chunkCount = chunks.length;
  const thumbOk = typeof thumb === 'string' && thumb.length > 0 && thumb.length <= THUMB_MAX_CHARS ? thumb : '';

  const baseAttrs = [
    { chunkCount: Long.fromNumber(chunkCount) },
    { size: Long.fromNumber(size || 0) },
    { w: Long.fromNumber(w || 0) },
    { h: Long.fromNumber(h || 0) },
    { blur: Long.fromNumber(blur || 0) },
    { bright: Long.fromNumber(bright || 0) },
  ];

  // 1) 占位
  let existing = null;
  try {
    await sdkTimeout(client.putRow({
      tableName: TABLE_MU_PHOTOS,
      condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_NOT_EXIST, null),
      primaryKey: photoPk(taskId, photoId),
      attributeColumns: [
        { seq: Long.fromNumber(0) },
        { uploadedAt: Long.fromNumber(0) },
        { complete: false },
        { imported: false },
        ...(thumbOk ? [{ thumb: thumbOk }] : []),
        ...baseAttrs,
      ],
    }));
  } catch (err) {
    if (!isConditionFail(err)) throw err;
    existing = await getPhotoMeta(taskId, photoId);
    if (!existing) {
      // 占位存在但读不到（刚被删）：按新上传重试一次
      return uploadPhoto({ ownerEmail, taskId, photoId, dataUrl, size, w, h, blur, bright, thumb, now });
    }
    if (existing.complete) {
      // 覆盖路径：保原 seq 与计数，只换数据（EXPECT_EXIST 在 complete 翻转上兜底，
      // 防止与「老师删除」竞态后复活出两份计数）
      try {
        await writeChunks(taskId, photoId, chunks);
        await sdkTimeout(client.updateRow({
          tableName: TABLE_MU_PHOTOS,
          condition: new TableStore.Condition(
            RowExistenceExpectation.EXPECT_EXIST,
            new TableStore.SingleColumnCondition('complete', true, ComparatorType.EQUAL)
          ),
          primaryKey: photoPk(taskId, photoId),
          updateOfAttributeColumns: [{ PUT: baseAttrs.concat(thumbOk ? [{ thumb: thumbOk }] : []) }],
        }));
        return { seq: existing.seq, photoCount: null, replaced: true };
      } catch (err) {
        if (!isConditionFail(err)) throw err;
        // 覆盖期间被老师删掉：行已不在，按全新上传重新走一遍
        return uploadPhoto({ ownerEmail, taskId, photoId, dataUrl, size, w, h, blur, bright, thumb, now });
      }
    }
  }

  // 崩溃恢复：占位在但没写完。seq>0 = 上次已分配，复用；seq=0 = 重新分配
  let seq = existing ? existing.seq : 0;
  if (seq === 0) {
    // 2) 条件分配（closed==false；单条件限制下选 closed，99 上限靠回滚兜底）
    const count = await bumpPhotoCount(ownerEmail, taskId, 1);
    if (count == null) {
      // 任务不存在或已关闭：清掉刚建的占位，按语义报错
      await deletePhotoRows(taskId, photoId);
      const e = new Error('任务已结束，无法继续上传');
      e.statusCode = 409;
      throw e;
    }
    if (count > MAX_PHOTOS) {
      await bumpPhotoCount(ownerEmail, taskId, -1);
      await deletePhotoRows(taskId, photoId);
      const e = new Error(`已达 ${MAX_PHOTOS} 张上限`);
      e.statusCode = 409;
      throw e;
    }
    seq = count;
    // 3) 落盘 seq（崩溃恢复标记）
    await sdkTimeout(client.updateRow({
      tableName: TABLE_MU_PHOTOS,
      condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
      primaryKey: photoPk(taskId, photoId),
      updateOfAttributeColumns: [{ PUT: [{ seq: Long.fromNumber(seq) }] }],
    }));
  }

  // 4) chunks
  await writeChunks(taskId, photoId, chunks);

  // 5) complete（PUT 齐全量属性：崩溃恢复路径复用的占位带着上次尝试的旧
  // chunkCount/尺寸——重传内容块数不同时若不覆盖，getPhotoData 会读错块范围）
  await sdkTimeout(client.updateRow({
    tableName: TABLE_MU_PHOTOS,
    condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
    primaryKey: photoPk(taskId, photoId),
    updateOfAttributeColumns: [{ PUT: baseAttrs.concat([
      { complete: true },
      { uploadedAt: Long.fromNumber(now) },
      ...(thumbOk ? [{ thumb: thumbOk }] : []),
    ]) }],
  }));

  return { seq, photoCount: seq, replaced: false };
}

/** 取整图 dataURL（桌面识别用）：读元数据 → 并发读全部块 → 拼接。 */
async function getPhotoData(taskId, photoId) {
  const meta = await getPhotoMeta(taskId, photoId, ['complete', 'chunkCount']);
  if (!meta) return null;
  if (!meta.complete) {
    const e = new Error('照片尚未上传完成');
    e.statusCode = 409;
    throw e;
  }
  const parts = new Array(meta.chunkCount).fill('');
  const CONC = 6;
  for (let start = 0; start < meta.chunkCount; start += CONC) {
    const idxs = [];
    for (let i = start; i < Math.min(start + CONC, meta.chunkCount); i++) idxs.push(i);
    const results = await Promise.all(idxs.map(async (i) => {
      const res = await getRowSafe({
        tableName: TABLE_MU_CHUNKS,
        primaryKey: [{ taskId }, { key: chunkKey(photoId, i) }],
        maxVersions: 1,
        columnsToGet: ['data'],
      });
      if (!rowExists(res)) throw new Error(`照片数据缺失（块 ${i}）`);
      const a = attrsToObject(res.row);
      if (typeof a.data !== 'string') throw new Error(`照片数据缺失（块 ${i}）`);
      return { i, data: a.data };
    }));
    for (const r of results) parts[r.i] = r.data;
  }
  return parts.join('');
}

/** 批量取缩略图（新到照片的轮询补拉）。返回 Map(photoId → thumb)。 */
async function getThumbs(taskId, photoIds) {
  const out = new Map();
  const CONC = 6;
  for (let start = 0; start < photoIds.length; start += CONC) {
    const wave = photoIds.slice(start, start + CONC);
    const results = await Promise.all(wave.map(async (photoId) => {
      const res = await getRowSafe({
        tableName: TABLE_MU_PHOTOS,
        primaryKey: photoPk(taskId, photoId),
        maxVersions: 1,
        columnsToGet: ['thumb'],
      });
      if (!rowExists(res)) return null;
      const a = attrsToObject(res.row);
      return typeof a.thumb === 'string' && a.thumb ? { photoId, thumb: a.thumb } : null;
    }));
    for (const r of results) if (r) out.set(r.photoId, r.thumb);
  }
  return out;
}

/** 删除一张照片的全部行（元数据 + 分块）。meta 行确曾存在才 photoCount-1。 */
async function deletePhoto(ownerEmail, taskId, photoId) {
  const existed = await deletePhotoRows(taskId, photoId);
  if (!existed) return false;
  try {
    await bumpPhotoCount(ownerEmail, taskId, -1);
  } catch (err) {
    if (!isConditionFail(err)) throw err; // 任务已关闭/已删：计数不必回退
  }
  return true;
}

/**
 * 按块数构造一张照片的全部块 key（块 key 由 chunkKey 生成、两位序号，可预测）。
 * 删除走构造而不是 range 扫描——GetRange 没有「只取主键」模式，columnsToGet 塞
 * 不存在列名会静默返回 0 行（OTS 实测），扫描式删除曾因此整体空转。
 */
function chunkKeysOf(photoId, chunkCount) {
  const n = Math.max(0, Math.min(MAX_CHUNKS_PER_PHOTO, Math.ceil(toNumber(chunkCount) || 0)));
  return Array.from({ length: n }, (_, i) => chunkKey(photoId, i));
}

/** 删一张照片的行（不动计数）。返回 meta 行是否确曾存在。
 *  ⚠️ meta 删除必须 EXPECT_EXIST：用 IGNORE 的话重复删除会「成功」并把 photoCount
 *  多扣——photoCount 是 seq 分配器，多扣会让后续 seq 永久错乱。不需要存在性的
 *  调用方（上传回滚等）忽略返回值即可。 */
async function deletePhotoRows(taskId, photoId) {
  // 先删 chunks 再删元数据；块数从 meta 的 chunkCount 读（单行小读，安全）
  const meta = await getPhotoMeta(taskId, photoId, ['chunkCount']);
  await deleteChunkRows(taskId, chunkKeysOf(photoId, meta ? meta.chunkCount : 0));
  let existed = true;
  try {
    await sdkTimeout(client.deleteRow({
      tableName: TABLE_MU_PHOTOS,
      condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
      primaryKey: photoPk(taskId, photoId),
    }));
  } catch (err) {
    if (!isConditionFail(err)) throw err;
    existed = false; // 行本就不存在（重复删除 / 已被并发删除）
  }
  return existed;
}

async function deleteChunkRows(taskId, keys) {
  for (let start = 0; start < keys.length; start += 50) {
    const group = keys.slice(start, start + 50);
    const res = await idemRetry(() => client.batchWriteRow({
      tables: [{
        tableName: TABLE_MU_CHUNKS,
        rows: group.map((key) => ({
          type: 'DELETE',
          primaryKey: [{ taskId }, { key }],
          condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
        })),
      }],
    }));
    for (const r of (res && res.tables) || []) {
      if (!r.isOk && !/OTSRowNotExist/.test(r.errorCode || '')) {
        throw new Error(`chunk 删除失败: ${r.errorCode || ''} ${r.errorMessage || ''}`);
      }
    }
  }
}

/**
 * 清空任务照片（close / sweep 用）。双保险：删完再只取主键扫一遍，非零再删一轮。
 * 返回删除的照片行数。
 */
async function deleteAllPhotos(taskId) {
  let n = await deleteAllPhotosOnce(taskId);
  if (n > 0) {
    const again = await listPhotoRows(taskId, ['seq']);
    if (again.length > 0) {
      await deleteAllPhotosOnce(taskId);
      n = Math.max(n, again.length);
    }
  }
  return n;
}

async function deleteAllPhotosOnce(taskId) {
  // 块 key 可预测（两位序号），由 meta 的 chunkCount 直接构造删除，零扫描。
  // ⚠️ 不能用 range 扫分块：GetRange 没有「只取主键」模式，columnsToGet 塞
  // 不存在列名会静默返回 0 行（OTS 实测），带真列名则每行拖回 64KB data。
  const rows = await listPhotoRows(taskId, ['seq', 'chunkCount']);
  const photoIds = [];
  for (const row of rows) {
    const photoId = pkOf(row, 'photoId');
    photoIds.push(photoId);
    const a = attrsToObject(row);
    await deleteChunkRows(taskId, chunkKeysOf(photoId, a.chunkCount));
  }
  // 元数据行 batch 删
  for (let start = 0; start < photoIds.length; start += 50) {
    const group = photoIds.slice(start, start + 50);
    const res = await idemRetry(() => client.batchWriteRow({
      tables: [{
        tableName: TABLE_MU_PHOTOS,
        rows: group.map((photoId) => ({
          type: 'DELETE',
          primaryKey: photoPk(taskId, photoId),
          condition: new TableStore.Condition(RowExistenceExpectation.IGNORE, null),
        })),
      }],
    }));
    for (const r of (res && res.tables) || []) {
      if (!r.isOk) throw new Error(`照片元数据删除失败: ${r.errorCode || ''}`);
    }
  }
  // 兜底：上面删除之后仍残留的分块行（in-flight 上传窗口写出/重建的、覆盖重传
  // 缩块后遗留的旧尾块、meta 已丢的孤儿），任务行删掉后就永远无人能再扫到（表无
  // TTL）。GetRange 无 PK-only 模式，只能全列扫——limit=1 单页 ≤64KB，低于 128KB
  // 停摆阈值；删一页从头发扫一页，残留只会变少故必然收敛，常态 0 行时仅 1 次扫描
  for (let round = 0; round < 100; round += 1) {
    const orphan = await rangeAll(
      TABLE_MU_CHUNKS,
      [{ taskId, key: TableStore.INF_MIN }],
      [{ taskId, key: TableStore.INF_MAX }],
      { limit: 1 }
    );
    if (orphan.length === 0) break;
    if (round === 99) console.error(`[mupload] 任务 ${taskId} 兜底清扫 100 轮仍有残留分块，跳过`);
    await deleteChunkRows(taskId, orphan.map((r) => pkOf(r, 'key')));
  }
  return photoIds.length;
}

/** 识别成功打标（防重复导入重复扣费）。行已不存在的忽略。 */
async function markImported(taskId, photoIds) {
  let n = 0;
  for (let start = 0; start < photoIds.length; start += 25) {
    const group = photoIds.slice(start, start + 25);
    const res = await idemRetry(() => client.batchWriteRow({
      tables: [{
        tableName: TABLE_MU_PHOTOS,
        rows: group.map((photoId) => ({
          type: 'UPDATE',
          primaryKey: photoPk(taskId, photoId),
          attributeColumns: [{ PUT: [{ imported: true }] }],
          condition: new TableStore.Condition(RowExistenceExpectation.EXPECT_EXIST, null),
        })),
      }],
    }));
    for (const r of (res && res.tables) || []) {
      if (r.isOk) n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 清扫（过期任务 → 级联删除照片/分块/索引/任务行）
// ---------------------------------------------------------------------------

/** 扫全表找过期任务并级联删除。返回清理的任务数。 */
async function sweepExpired(now) {
  const rows = await rangeAll(
    TABLE_MU_TASKS,
    // ⚠️ startPK/endPK 必须含表的全部主键列（ownerEmail+taskId），缺列直接
    // OTSInvalidPK 报错——曾因只给 ownerEmail 导致 sweep 从未成功过
    [{ ownerEmail: TableStore.INF_MIN, taskId: TableStore.INF_MIN }],
    [{ ownerEmail: TableStore.INF_MAX, taskId: TableStore.INF_MAX }],
    { columnsToGet: ['expiresAt', 'closed'] }
  );
  let cleaned = 0;
  for (const row of rows) {
    const a = attrsToObject(row);
    const expiresAt = toNumber(a.expiresAt) || 0;
    if (expiresAt >= now) continue;
    const ownerEmail = pkOf(row, 'ownerEmail');
    const taskId = pkOf(row, 'taskId');
    try {
      await closeTask(ownerEmail, taskId); // 先关（挡并发上传）再删，对齐 handleClose
      await deleteAllPhotos(taskId);
      await deleteTaskRows(ownerEmail, taskId);
      cleaned += 1;
    } catch (err) {
      console.error(`[mupload] 清理任务 ${taskId} 失败:`, err.message || err);
    }
  }
  return cleaned;
}

module.exports = {
  client,
  TableStore,
  TABLE_MU_TASKS,
  TABLE_MU_INDEX,
  TABLE_MU_PHOTOS,
  TABLE_MU_CHUNKS,
  CHUNK_CHARS,
  MAX_PHOTOS,
  TASK_TTL_MS,
  THUMB_MAX_CHARS,
  createTask,
  getTask,
  getTaskByIndex,
  listTasksOfOwner,
  rotateTask,
  closeTask,
  deleteTaskRows,
  markDevice,
  bumpPhotoCount,
  photoFromRow,
  countUnimportedPhotos,
  getPhotoMeta,
  listPhotoRows,
  uploadPhoto,
  getPhotoData,
  getThumbs,
  deletePhoto,
  deleteAllPhotos,
  markImported,
  sweepExpired,
  ensureTables,
};
