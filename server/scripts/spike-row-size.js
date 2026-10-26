'use strict';

/**
 * P0 尖峰测试：实测 Tablestore 单行/单属性列的大小上限（一次性，可重复执行）。
 *
 * 背景：扫码拍照上传（m-upload）要把压缩照片以 base64 字符串（目标 ≤1.4MB）存进
 * mupload_photos 的 data 列。各公开文档对「单列 2MB / 单行 8MB」口径不一
 * （有说法疑为百度云 TableStorage 的限制），必须以真实实例实测为准。
 *
 * 做法：建临时表 mupload_spike_tmp，从 1.0MB 起逐级写入更大的字符串列，
 * 记录首个失败点；顺带验证 GetRange columnsToGet 排除大列后只回元数据。
 * 结束后删掉临时表。
 *
 * 用法（在 server/ 目录，.env 配好 TABLESTORE_*）：
 *   node scripts/spike-row-size.js
 */

const {
  client,
  TableStore,
  rowExists,
  attrsToObject,
  toNumber,
} = require('../src/tablestore');

const TABLE = 'mupload_spike_tmp';
const STRING = TableStore.PrimaryKeyType.STRING;

/** 生成约 sizeBytes 大小的伪随机字符串（用重复填充，模拟 base64 均匀字符）。 */
function filler(sizeBytes) {
  // 'A'.charCodeAt 循环即可；列值内容不影响大小限制
  return 'A'.repeat(sizeBytes);
}

async function createTempTable() {
  try {
    await client.createTable({
      tableMeta: { tableName: TABLE, primaryKey: [{ name: 'k', type: STRING }] },
      reservedThroughput: { capacityUnit: { read: 0, write: 0 } },
      tableOptions: { timeToLive: -1, maxVersions: 1 },
    });
    console.log(`✅ 已创建临时表 ${TABLE}`);
  } catch (err) {
    if (!/OTSObjectAlreadyExist|already exist/i.test(String(err.message || err))) throw err;
  }
}

async function dropTempTable() {
  try {
    await client.deleteTable({ tableName: TABLE });
    console.log(`🧹 已删除临时表 ${TABLE}`);
  } catch (err) {
    console.log(`⚠️  删除临时表失败（可手动删）: ${err.message || err}`);
  }
}

/** 尝试写入一行 data 列为 sizeBytes 大小的字符串；成功返回 true。 */
async function tryPut(tag, sizeBytes) {
  try {
    await client.putRow({
      tableName: TABLE,
      condition: new TableStore.Condition(TableStore.RowExistenceExpectation.IGNORE, null),
      primaryKey: [{ k: `row-${tag}` }],
      attributeColumns: [
        { data: filler(sizeBytes) },
        { seq: TableStore.Long.fromNumber(1) },
        { note: tag },
      ],
    });
    console.log(`  ${tag}: ${(sizeBytes / 1024 / 1024).toFixed(2)}MB 写入 ✅`);
    return true;
  } catch (err) {
    console.log(`  ${tag}: ${(sizeBytes / 1024 / 1024).toFixed(2)}MB 写入 ❌ ${err.code || ''} ${String(err.message || err).slice(0, 120)}`);
    return false;
  }
}

/** 回读指定行，返回 data 列实际长度（-1 = 行不存在）。 */
async function readBack(tag) {
  const result = await client.getRow({
    tableName: TABLE,
    primaryKey: [{ k: `row-${tag}` }],
    maxVersions: 1,
  });
  if (!rowExists(result)) return -1;
  const attrs = attrsToObject(result.row);
  return typeof attrs.data === 'string' ? attrs.data.length : -1;
}

async function main() {
  await createTempTable();

  // 1) 逐级加大找上限（1.0MB → 2.2MB，256KB 步进）
  const SIZES = [
    1.0 * 1024 * 1024,
    1.25 * 1024 * 1024,
    1.5 * 1024 * 1024,
    1.75 * 1024 * 1024,
    2.0 * 1024 * 1024,
    2.25 * 1024 * 1024,
  ];
  let lastOkBytes = 0;
  let firstFailBytes = 0;
  let lastOkTag = '';
  for (let i = 0; i < SIZES.length; i++) {
    const tag = `s${i}`;
    const ok = await tryPut(tag, SIZES[i]);
    if (ok) {
      const real = await readBack(tag);
      const expect = SIZES[i];
      if (real === expect) {
        console.log(`    回读一致：${(real / 1024 / 1024).toFixed(2)}MB ✅`);
      } else {
        console.log(`    ⚠️  回读长度 ${real} ≠ 写入 ${expect}（可能被截断/改写！）`);
      }
      lastOkBytes = expect;
      lastOkTag = tag;
    } else {
      firstFailBytes = SIZES[i];
      break;
    }
  }

  console.log('\n========== 结论 ==========');
  if (lastOkBytes > 0) {
    console.log(`单属性列实测可写入：${(lastOkBytes / 1024 / 1024).toFixed(2)}MB（行 row-${lastOkTag}）`);
    // 按 7 折给 MAX_DATAURL_CHARS 建议（留行头/列名/其他列余量）
    const suggested = Math.floor(lastOkBytes * 0.7);
    console.log(`建议 MAX_DATAURL_CHARS = ${suggested}（实测值 × 0.7 ≈ ${(suggested / 1024 / 1024).toFixed(2)}MB）`);
  }
  if (firstFailBytes > 0) {
    console.log(`首个失败点：${(firstFailBytes / 1024 / 1024).toFixed(2)}MB`);
  }

  // 2) GetRange columnsToGet 排除 data 列：验证轮询只回元数据
  try {
    const range = await client.getRange({
      tableName: TABLE,
      direction: TableStore.Direction.FORWARD,
      inclusiveStartPrimaryKey: [{ k: 'row-' }],
      exclusiveEndPrimaryKey: [{ k: 'row-zzz' }],
      maxVersions: 1,
      limit: 10,
      columnsToGet: ['seq', 'note'], // 刻意不带 data
    });
    const rows = (range.rows || []).map((r) => ({
      k: r.primaryKey[0].value,
      cols: r.attributes.map((a) => a.columnName).join(','),
    }));
    console.log('\nGetRange columnsToGet=[seq,note]（排除 data）：');
    for (const r of rows) console.log(`  ${r.k} → 列: ${r.cols}`);
    const leaked = rows.some((r) => r.cols.includes('data'));
    console.log(leaked ? '  ❌ data 列被返回了！columnsToGet 未生效？' : '  ✅ data 列未返回，轮询只拉元数据可行');
  } catch (err) {
    console.log(`GetRange 测试失败: ${err.code || ''} ${err.message || err}`);
  }

  await dropTempTable();
}

main().catch((err) => {
  console.error('尖峰测试失败:', err);
  process.exit(1);
});
