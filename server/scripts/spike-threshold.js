'use strict';

/**
 * 实测「读路径安全阈值」：多大响应体能稳定完整到达？
 * 梯度写 + 读回（20s 超时 × 3 次/档），然后并发突发读验证桌面取图模式，
 * 最后删临时表。
 *
 * 背景：spike-net-probe 已证实 512KB~1MB 响应在本地路径 ~480KB 处被掐断，
 * 30s 后 socket 干净关闭（无 end 无 error）→ SDK 永久挂起。
 * 本脚本找「稳定安全」的单响应上限，为照片分块（chunk）尺寸定标。
 */

const { client, TableStore, rowExists, attrsToObject } = require('../src/tablestore');

const TABLE = 'mupload_spike_tmp';
const STRING = TableStore.PrimaryKeyType.STRING;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error(`HANG(${label})`), { code: 'SPIKE_HANG' })), ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

const KB = 1024;
const SIZES = [32 * KB, 64 * KB, 128 * KB, 200 * KB, 256 * KB, 384 * KB];
const REPS = 3;

async function putRow(tag, sizeBytes) {
  await client.putRow({
    tableName: TABLE,
    condition: new TableStore.Condition(TableStore.RowExistenceExpectation.IGNORE, null),
    primaryKey: [{ k: tag }],
    attributeColumns: [{ data: 'A'.repeat(sizeBytes) }],
  });
}

/** 读回并校验长度；返回 'ok' | 'hang' | 'mismatch(len)' | 'missing' */
async function readCheck(tag, expectBytes) {
  try {
    const r = await withTimeout(
      client.getRow({ tableName: TABLE, primaryKey: [{ k: tag }], maxVersions: 1 }),
      20000,
      tag
    );
    if (!rowExists(r)) return 'missing';
    const attrs = attrsToObject(r.row);
    return typeof attrs.data === 'string' && attrs.data.length === expectBytes ? 'ok' : `mismatch(${(attrs.data || '').length})`;
  } catch (e) {
    return e.code === 'SPIKE_HANG' ? 'hang' : `err:${String(e.message).slice(0, 60)}`;
  }
}

async function main() {
  console.log('== 梯度读回测试（每档 3 次）==');
  const safe = [];
  for (const size of SIZES) {
    const tag = `r${size}`;
    await putRow(tag, size);
    const results = [];
    for (let i = 0; i < REPS; i++) results.push(await readCheck(tag, size));
    const okCount = results.filter((r) => r === 'ok').length;
    console.log(`  ${(size / KB).toFixed(0).padStart(3)}KB: ${results.join(' ')} ${okCount === REPS ? '✅' : '❌'}`);
    if (okCount === REPS) safe.push(size);
  }
  const maxSafe = safe.length ? safe[safe.length - 1] : 0;
  console.log(`\n稳定安全档上限: ${(maxSafe / KB).toFixed(0)}KB`);

  if (maxSafe >= 64 * KB) {
    console.log('\n== 并发突发读（模拟桌面取图：4 并发 × 10 轮）==');
    const chunk = Math.min(maxSafe, 256 * KB);
    const tag = `r${chunk}`;
    let fails = 0;
    const t0 = Date.now();
    for (let round = 0; round < 10; round++) {
      const rs = await Promise.all(
        [0, 1, 2, 3].map(() =>
          readCheck(tag, chunk).catch(() => 'err')
        )
      );
      fails += rs.filter((r) => r !== 'ok').length;
    }
    console.log(`  ${chunk / KB}KB × 4并发 × 10轮 = 40 次，失败 ${fails}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // 清理临时表（含第一幕遗留的大行）
  try {
    await client.deleteTable({ tableName: TABLE });
    console.log('\n🧹 已删除临时表 ' + TABLE);
  } catch (e) {
    console.log(`\n⚠️ 删表失败（可控制台手动删）: ${e.message}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('脚本失败:', e);
  process.exit(1);
});
