'use strict';
/** spike（一次性）：平台定时触发器端到端验证。
 *
 * 原理：handleTimer → sweepExpired 只认「expiresAt < now」的任务行，不读请求体、
 * 不需要鉴权。埋一个 expiresAt 在 1 分钟前的假任务，定时器一旦真跑过，这行必被删。
 *
 * 用法：
 *   node scripts/spike-timer-verify.js plant   # 埋过期假任务（owner=timer-verify@test.invalid）
 *   node scripts/spike-timer-verify.js check   # 触发器跑过一次后确认它已被清掉
 */
const dbm = require('../src/mupload-db');

const OWNER = 'timer-verify@test.invalid'; // 假邮箱，仅存在于测试行，sweep 会连行删除
const TASK = 'timerchk01';

(async () => {
  const mode = process.argv[2] || 'plant';
  if (mode === 'plant') {
    const now = Date.now();
    await dbm.client.putRow({
      tableName: dbm.TABLE_MU_TASKS,
      condition: new dbm.TableStore.Condition(dbm.TableStore.RowExistenceExpectation.IGNORE),
      primaryKey: [{ ownerEmail: OWNER }, { taskId: TASK }],
      attributeColumns: [
        { tool: 'handwriting' },
        { label: 'timer-verify' },
        { createdAt: dbm.TableStore.Long.fromNumber(now - 25 * 60 * 60 * 1000) },
        { expiresAt: dbm.TableStore.Long.fromNumber(now - 60 * 1000) }, // 已过期 1 分钟
        { closed: false },
        { tokenSeq: dbm.TableStore.Long.fromNumber(0) },
        { sess: dbm.TableStore.Long.fromNumber(0) },
        { deviceBound: '' },
        { photoCount: dbm.TableStore.Long.fromNumber(0) },
      ],
    });
    console.log(`已埋入过期假任务 owner=${OWNER} taskId=${TASK}`);
    console.log('等定时触发器跑一次（下一整点，或临时把触发器调成每 5 分钟）后，跑 check 模式确认。');
  } else if (mode === 'check') {
    const row = await dbm.getTask(OWNER, TASK);
    if (!row) {
      console.log('OK 假任务已被清扫 —— 定时触发器 → handleTimer → sweepExpired 链路端到端生效');
      return;
    }
    console.log('NOT-CLEANED 假任务还在 —— 触发器还没到点、未启用，或平台未真正调用（查平台调用日志里触发时刻的记录）');
    process.exitCode = 1;
  } else {
    console.error('用法: node scripts/spike-timer-verify.js plant|check');
    process.exitCode = 1;
  }
})().catch((e) => { console.error('spike 异常:', e.message || e); process.exit(1); });
