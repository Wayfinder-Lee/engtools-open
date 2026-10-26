'use strict';

/**
 * 一次性回填：把 redeem_codes 里已兑换的码写进 usage_log（kind:'redeem'），
 * 让老账户的「额度明细 / 累计充值」能看到功能上线前的兑换记录。
 *
 * 幂等：sk 用确定性后缀 `-r-<code>`（putUsageLog 的可选 sk 参数），重跑覆盖同一行、不产生重复。
 * 已知局限：功能上线前的注册赠送 / 邮箱验证赠送无法追溯（当时没有流水），老账户账面不平，已接受。
 *
 * 用法（在 server/ 目录，.env 指向目标 Tablestore）：node scripts/backfill-usage.js
 */

const db = require('../src/tablestore');

/** 与 tablestore.js 的 reverseTs 同逻辑（时间降序 sk 前缀）。 */
function reverseTs(ms) {
  return String(Number.MAX_SAFE_INTEGER - ms).padStart(16, '0');
}

(async () => {
  const { codes, truncated } = await db.listCodes();
  const used = codes.filter((c) => c.used && c.usedBy && c.usedAt > 0);
  console.log(`扫描到 ${codes.length} 个码，其中已兑换 ${used.length} 个${truncated ? '（⚠️ 扫描被截断，结果不完整，请排查）' : ''}`);
  if (used.length === 0) {
    console.log('没有需要回填的兑换记录。');
    return;
  }

  let written = 0;
  for (const c of used) {
    const sk = `${reverseTs(c.usedAt)}-r-${c.code}`;
    // eslint-disable-next-line no-await-in-loop
    await db.putUsageLog(c.usedBy, {
      kind: 'redeem',
      op: 'redeem',
      gain: c.credits,
      meta: c.code,
      sk,
    });
    written += 1;
    if (written % 100 === 0) console.log(`已写入 ${written}/${used.length} …`);
  }
  console.log(`回填完成：共写入 ${written} 条兑换流水。`);
})().catch((err) => {
  console.error('回填失败:', err);
  process.exit(1);
});
