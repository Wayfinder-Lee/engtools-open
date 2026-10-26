'use strict';

/**
 * P0 尖峰测试·第二幕：大列「读路径」诊断。
 *
 * 第一幕发现：putRow 写 512KB~1MB 大列成功，但 getRow 回读同一行时
 * promise 永不 resolve（进程静默退出 code 0）。本脚本用超时包装逐条测：
 *   A. getRow 排除 data 列（columnsToGet）→ 是否成功（判断「响应体大小」vs「行大小」）
 *   B. getRow 带全部列 → 预期挂起（对照组）
 *   C. getRange 窄区间带 data 列 → photo-data 接口的备选读路径
 *   D. getRange 排除 data → 轮询路径
 * 全部调用包 15s 超时，挂起会显式报 HANG 而不是静默退出。
 *
 * 用法（在 server/ 目录）：node scripts/spike-read-paths.js
 */

const { client, TableStore, rowExists, attrsToObject } = require('../src/tablestore');

const TABLE = 'mupload_spike_tmp';
const STRING = TableStore.PrimaryKeyType.STRING;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => {
        const e = new Error(`HANG(${label}): ${ms}ms 内未返回`);
        e.code = 'SPIKE_HANG';
        reject(e);
      }, ms);
      // 不让这个 timer 挂住进程
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

async function probe(label, fn) {
  const t0 = Date.now();
  try {
    const r = await withTimeout(fn(), 15000, label);
    console.log(`  ${label}: ✅ ${Date.now() - t0}ms`);
    return r;
  } catch (err) {
    if (err.code === 'SPIKE_HANG') {
      console.log(`  ${label}: 🚨 ${err.message}`);
    } else {
      console.log(`  ${label}: ❌ ${err.code || ''} ${String(err.message || err).slice(0, 140)}`);
    }
    return null;
  }
}

async function main() {
  // 先确认大行还在（第一幕写过 row-s0 = 1MB）
  console.log('== A. getRow 排除大列（columnsToGet=[seq,note]）==');
  const metaOnly = await probe('getRow row-s0 columnsToGet=[seq,note]', () =>
    client.getRow({
      tableName: TABLE,
      primaryKey: [{ k: 'row-s0' }],
      maxVersions: 1,
      columnsToGet: ['seq', 'note'],
    })
  );
  if (metaOnly && rowExists(metaOnly)) {
    const cols = metaOnly.row.attributes.map((a) => a.columnName).join(',');
    console.log(`    返回列: [${cols}]（不含 data 即证明排除生效）`);
  }

  console.log('== B. getRow 全列（对照组，第一幕在此挂起）==');
  await probe('getRow row-s0 全列', () =>
    client.getRow({ tableName: TABLE, primaryKey: [{ k: 'row-s0' }], maxVersions: 1 })
  );

  console.log('== C. getRange 窄区间带 data 列 ==');
  const rangeFull = await probe(
    'getRange [row-s0, row-s0~] columnsToGet=[data]',
    () =>
      client.getRange({
        tableName: TABLE,
        direction: TableStore.Direction.FORWARD,
        inclusiveStartPrimaryKey: [{ k: 'row-s0' }],
        exclusiveEndPrimaryKey: [{ k: 'row-s0~' }],
        maxVersions: 1,
        limit: 1,
        columnsToGet: ['data'],
      })
  );
  if (rangeFull && Array.isArray(rangeFull.rows) && rangeFull.rows.length) {
    const attrs = attrsToObject(rangeFull.rows[0]);
    const len = typeof attrs.data === 'string' ? attrs.data.length : -1;
    console.log(`    data 列长度 = ${len}（写入 1MB=${1024 * 1024}）${len === 1024 * 1024 ? '→ 完整回读 ✅' : '→ ⚠️ 长度不符'}`);
  }

  console.log('== D. getRange 排除 data（轮询路径）==');
  const rangeMeta = await probe(
    'getRange 全表 columnsToGet=[seq,note]',
    () =>
      client.getRange({
        tableName: TABLE,
        direction: TableStore.Direction.FORWARD,
        inclusiveStartPrimaryKey: [{ k: 'row-' }],
        exclusiveEndPrimaryKey: [{ k: 'row-zzz' }],
        maxVersions: 1,
        limit: 10,
        columnsToGet: ['seq', 'note'],
      })
  );
  if (rangeMeta) {
    for (const r of rangeMeta.rows || []) {
      console.log(`    ${r.primaryKey[0].value} → [${r.attributes.map((a) => a.columnName).join(',')}]`);
    }
  }

  console.log('\n诊断结束。');
  process.exit(0);
}

main().catch((err) => {
  console.error('诊断脚本失败:', err);
  process.exit(1);
});
