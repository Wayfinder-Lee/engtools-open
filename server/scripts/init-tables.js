'use strict';

/**
 * 一次性建表脚本（幂等，可安全重复执行）。
 * 用法（在 server/ 目录，配置好 .env 里的 TABLESTORE_* 后）：
 *   npm run init-tables
 *
 * 本文件负责账号 / 额度系统的全部数据表。
 */

const { client, TableStore, TABLE_USERS, TABLE_CODES, TABLE_VERIFY_CODES, TABLE_DAILY_LIMITS, TABLE_GUEST_CREDITS, TABLE_USAGE_LOG } = require('../src/tablestore');

// 扫码拍照上传（m-upload）：可选加载，模块不存在就跳过其建表
let muploadDb = null;
try {
  // eslint-disable-next-line global-require
  muploadDb = require('../src/mupload-db');
} catch (_err) {
  muploadDb = null;
}

const STRING = TableStore.PrimaryKeyType.STRING;

/** 表 → 主键列定义。列顺序即主键顺序，决定范围查询的前缀。 */
const TABLE_DEFS = {
  [TABLE_USERS]: [{ name: 'email', type: STRING }],
  [TABLE_CODES]: [{ name: 'code', type: STRING }],
  [TABLE_VERIFY_CODES]: [{ name: 'email', type: STRING }],
  [TABLE_DAILY_LIMITS]: [{ name: 'key', type: STRING }],
  [TABLE_GUEST_CREDITS]: [{ name: 'ip', type: STRING }], // M6：游客体验额度（按 IP）
  [TABLE_USAGE_LOG]: [ // 使用流水：acct 分区 + sk 反转时间戳（升序=时间降序）
    { name: 'acct', type: STRING },
    { name: 'sk', type: STRING },
  ],
};

async function createIfAbsent(tableName) {
  const def = TABLE_DEFS[tableName];
  if (!def) throw new Error(`未定义表结构: ${tableName}`);
  try {
    await client.createTable({
      tableMeta: { tableName, primaryKey: def },
      reservedThroughput: { capacityUnit: { read: 0, write: 0 } }, // 按量付费实例用 0/0
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

(async () => {
  for (const tableName of Object.keys(TABLE_DEFS)) {
    await createIfAbsent(tableName);
  }
  if (muploadDb) {
    await muploadDb.ensureTables();
  } else {
    console.log('ℹ️  未发现扫码上传模块，跳过其建表');
  }
  console.log('建表完成。');
})().catch((err) => {
  console.error('建表失败:', err);
  process.exit(1);
});
