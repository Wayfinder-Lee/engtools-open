'use strict';

/**
 * m-upload 接口边界矩阵验证（P1 门槛）。对本地 npm start 的服务跑全流程：
 *   建任务 → 轮询 → claim → 上传（小图 + 800KB 分块大图）→ 重传幂等
 *   → refresh 换绑 → 旧码/旧会话失效 → 伪造签名限流 → 99 上限
 *   → 删除/打标/close → ghost 行恢复 → 清理测试数据
 *
 * 用法：先 npm start（另一终端），再 node scripts/verify-mupload-api.js
 * 测试账号用完即注销（DELETE /api/account），任务行直接删。
 */

const BASE = process.env.BASE || 'http://localhost:9000';
const EMAIL = `mu-verify-${Date.now()}@example.com`;
const PASSWORD = 'mu-verify-pass';
const DEV_A = 'dev-A-aaaa';
const DEV_B = 'dev-B-bbbb';

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, path, { token, session, body } = {}) {
  const merged = session ? { session, ...(body || {}) } : body;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: merged === undefined ? undefined : JSON.stringify(merged),
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* 空响应 */ }
  return { status: res.status, json };
}

/** 伪 JPEG：FFD8 魔数 + 填充（服务端只验魔数与大小）。 */
function fakeJpegDataUrl(bytes) {
  return 'data:image/jpeg;base64,' + Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.alloc(bytes - 6, 0x5a),
  ]).toString('base64');
}

(async () => {
  // 0) 注册测试账号
  const reg = await api('POST', '/api/auth/register', { body: { email: EMAIL, password: PASSWORD } });
  check('注册测试账号', reg.status === 200, JSON.stringify(reg.json));
  const token = reg.json && reg.json.token;

  // 重置本机 IP 的 claim 失败计数（脚本可重复执行；上限 50/天/IP 会跨运行累计）
  {
    const { client } = require('../src/mupload-db');
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    for (const ip of ['::1', '127.0.0.1', 'unknown', '::ffff:127.0.0.1']) {
      await client.deleteRow({
        tableName: 'daily_limits',
        condition: new (require('../src/tablestore').TableStore.Condition)(
          (require('../src/tablestore').TableStore.RowExistenceExpectation).IGNORE, null
        ),
        primaryKey: [{ key: `mu#badtok#${ip}#${today}#c` }],
      }).catch(() => {});
    }
  }

  let t = {};

  console.log('\n== 1. 建任务 / 轮询 ==');
  {
    const r = await api('POST', '/api/m/tasks', { token, body: { label: '尖峰验证' } });
    check('建任务 200', r.status === 200, JSON.stringify(r.json));
    t = r.json || {};
    check('返回 token/taskId/quota', !!(t.token && t.taskId && typeof t.quota === 'number'));
  }
  {
    const r = await api('GET', `/api/m/task?tid=${t.taskId}&since=0`, { token });
    check('轮询 state=active photos=[]', r.status === 200 && r.json.state === 'active' && r.json.photos.length === 0, JSON.stringify(r.json));
  }
  {
    const r = await api('GET', `/api/m/task?tid=deadbeefdead&since=0`, { token });
    check('他人/不存在任务 → 404', r.status === 404, JSON.stringify(r.json));
  }

  console.log('\n== 2. claim / 多设备连接 ==');
  let sessA = '';
  {
    const r = await api('POST', '/api/m/claim', { body: { token: t.token, deviceId: DEV_A } });
    check('claim 200 + session', r.status === 200 && !!r.json.session, JSON.stringify(r.json));
    sessA = r.json.session;
    check('claim 返回 task.photoIds=[]', Array.isArray(r.json.photoIds) && r.json.photoIds.length === 0);
    check('claim 返回 quota/maxPhotos', typeof r.json.task.quota === 'number' && r.json.task.maxPhotos === 99);
  }
  {
    const r = await api('POST', '/api/m/claim', { body: { token: t.token, deviceId: DEV_A } });
    check('同设备重扫幂等 200', r.status === 200, JSON.stringify(r.json));
  }
  {
    const r = await api('POST', '/api/m/claim', { body: { token: t.token, deviceId: DEV_B } });
    check('异设备 claim → 200（2026-09-27 起不绑设备，多设备并存）', r.status === 200 && !!r.json.session, JSON.stringify(r.json));
  }

  console.log('\n== 3. 上传 / 幂等 / 分块回读 ==');
  const photoId1 = 'aaaaaaaaaa01';
  const bigDataUrl = fakeJpegDataUrl(800 * 1024); // 800KB → 13 块
  {
    const r = await api('POST', '/api/m/upload', {
      session: sessA,
      body: { photoId: photoId1, dataUrl: bigDataUrl, w: 1600, h: 1200, size: 600000, quality: { blur: 120, bright: 130 }, thumb: 'data:image/jpeg;base64,AAAA' },
    });
    check('上传 800KB 大图 200', r.status === 200 && r.json.seq === 1, JSON.stringify(r.json));
  }
  {
    const r = await api('POST', '/api/m/photo-data', { token, body: { tid: t.taskId, photoId: photoId1 } });
    check('分块回读长度一致', r.status === 200 && r.json.dataUrl === bigDataUrl, `len=${(r.json.dataUrl || '').length}`);
  }
  {
    const small = fakeJpegDataUrl(2048);
    const r = await api('POST', '/api/m/upload', {
      session: sessA,
      body: { photoId: photoId1, dataUrl: small, w: 100, h: 100, size: 1500 },
    });
    check('同 photoId 重传 → replaced:true', r.status === 200 && r.json.replaced === true, JSON.stringify(r.json));
    const r2 = await api('POST', '/api/m/photo-data', { token, body: { tid: t.taskId, photoId: photoId1 } });
    check('重传后读到新数据', r2.json.dataUrl === small, `len=${(r2.json.dataUrl || '').length}`);
  }

  console.log('\n== 4. 上传边界 ==');
  {
    let r = await api('POST', '/api/m/upload', { session: sessA, body: { photoId: 'bbbbbbbbbb01', dataUrl: 'data:image/png;base64,AAAA', w: 1, h: 1, size: 3 } });
    check('非 JPEG 前缀 → 400', r.status === 400, JSON.stringify(r.json));
    r = await api('POST', '/api/m/upload', { session: sessA, body: { photoId: 'bbbbbbbbbb01', dataUrl: 'data:image/jpeg;base64,PD9wZGYg', w: 1, h: 1, size: 4 } });
    check('非 FFD8 魔数 → 400', r.status === 400, JSON.stringify(r.json));
    r = await api('POST', '/api/m/upload', { session: sessA, body: { photoId: 'bbbbbbbbbb01', dataUrl: 'x'.repeat(1500000), w: 1, h: 1, size: 1 } });
    check('超 1.4M chars → 400/413', r.status === 400 || r.status === 413, `got ${r.status}`);
    r = await api('POST', '/api/m/upload', { session: 'garbage.session', body: { photoId: 'bbbbbbbbbb01', dataUrl: fakeJpegDataUrl(64), w: 1, h: 1, size: 10 } });
    check('无效会话 → 401', r.status === 401, JSON.stringify(r.json));
  }

  console.log('\n== 5. 增量轮询 ==');
  {
    const r = await api('GET', `/api/m/task?tid=${t.taskId}&since=0`, { token });
    check('since=0 → 1 张 + 缩略图被丢（重传未带 thumb）', r.status === 200 && r.json.photos.length === 1);
    const r2 = await api('GET', `/api/m/task?tid=${t.taskId}&since=1`, { token });
    check('since=1 → photos 仍全量但无新缩略图', r2.status === 200 && r2.json.photos.length === 1 && r2.json.photos[0].thumb === undefined);
  }

  console.log('\n== 6. refresh 换绑 ==');
  {
    const r = await api('POST', '/api/m/refresh', { token, body: { tid: t.taskId } });
    check('refresh 200 + 新 token', r.status === 200 && !!r.json.token, JSON.stringify(r.json));
    const oldToken = t.token;
    t = { ...t, token: r.json.token };

    const rc = await api('POST', '/api/m/claim', { body: { token: oldToken, deviceId: DEV_B } });
    check('旧码 claim → 409', rc.status === 409, JSON.stringify(rc.json));

    const ru = await api('POST', '/api/m/upload', { session: sessA, body: { photoId: 'cccccccccc01', dataUrl: fakeJpegDataUrl(64), w: 1, h: 1, size: 10 } });
    check('旧会话 upload → 409 revoked', ru.status === 409 && ru.json.state === 'revoked', JSON.stringify(ru.json));

    const rn = await api('POST', '/api/m/claim', { body: { token: t.token, deviceId: DEV_B } });
    check('refresh 后新设备 → 200', rn.status === 200, JSON.stringify(rn.json));
    sessA = rn.json.session;
  }

  console.log('\n== 8. ghost 行恢复 ==');
  {
    // 直接种一条 seq=0 半写占位，再走正常上传 → 应补走分配路径
    const { client, TableStore } = require('../src/mupload-db');
    await client.putRow({
      tableName: 'mupload_photos',
      condition: new TableStore.Condition(TableStore.RowExistenceExpectation.IGNORE, null),
      primaryKey: [{ taskId: t.taskId }, { photoId: 'ghostghost01' }],
      attributeColumns: [
        { seq: TableStore.Long.fromNumber(0) },
        { uploadedAt: TableStore.Long.fromNumber(0) },
        { complete: false },
        { imported: false },
        { chunkCount: TableStore.Long.fromNumber(1) },
        { size: TableStore.Long.fromNumber(0) },
        { w: TableStore.Long.fromNumber(0) },
        { h: TableStore.Long.fromNumber(0) },
        { blur: TableStore.Long.fromNumber(0) },
        { bright: TableStore.Long.fromNumber(0) },
      ],
    });
    const r = await api('POST', '/api/m/upload', { session: sessA, body: { photoId: 'ghostghost01', dataUrl: fakeJpegDataUrl(64), w: 10, h: 10, size: 12 } });
    check('ghost 补分配 → 200 seq>0', r.status === 200 && r.json.seq > 0, JSON.stringify(r.json));
    const r2 = await api('POST', '/api/m/photo-data', { token, body: { tid: t.taskId, photoId: 'ghostghost01' } });
    check('ghost 恢复后可回读', r2.status === 200 && r2.json.dataUrl === fakeJpegDataUrl(64), JSON.stringify(r2.json).slice(0, 80));
  }

  console.log('\n== 9. 99 上限 ==');
  {
    let hit409 = false;
    let n = 0;
    for (let i = 0; i < 105; i++) {
      const pid = `bulk${String(i).padStart(8, '0')}`;
      const r = await api('POST', '/api/m/upload', { session: sessA, body: { photoId: pid, dataUrl: fakeJpegDataUrl(64), w: 1, h: 1, size: 10 } });
      n = i + 1;
      if (r.status === 409) {
        hit409 = true;
        check(`第 ${n} 次上传 → 409 上限`, /上限/.test(r.json.error || ''), JSON.stringify(r.json));
        check('上限 409 带 state:"full"（手机端据此终态化，不空转重试）', r.json.state === 'full', JSON.stringify(r.json));
        break;
      }
    }
    if (!hit409) check('99 上限触发 409', false, `传了 ${n} 张未触发`);
  }

  console.log('\n== 10. 打标 / 删除 / close ==');
  {
    const r = await api('GET', `/api/m/task?tid=${t.taskId}&since=9999`, { token });
    const photos = (r.json.photos || []).map((p) => p.photoId);
    check('close 前未导入数 > 0 → 409', (await api('POST', '/api/m/close', { token, body: { tid: t.taskId } })).status === 409);

    const ri = await api('POST', '/api/m/photos-imported', { token, body: { tid: t.taskId, photoIds: photos.slice(0, 3) } });
    check('photos-imported ok', ri.status === 200 && ri.json.imported === 3, JSON.stringify(ri.json));

    const cnt0 = (await api('GET', `/api/m/task?tid=${t.taskId}&since=9999`, { token })).json.task.photoCount;
    const rd = await api('POST', '/api/m/photo-delete', { token, body: { tid: t.taskId, photoId: photos[0] } });
    const cnt1 = (await api('GET', `/api/m/task?tid=${t.taskId}&since=9999`, { token })).json.task.photoCount;
    check('photo-delete → 计数减', rd.status === 200 && cnt1 === cnt0 - 1, `cnt0=${cnt0} cnt1=${cnt1}`);

    const rd2 = await api('POST', '/api/m/photo-delete', { token, body: { tid: t.taskId, photoId: photos[0] } });
    const cnt2 = (await api('GET', `/api/m/task?tid=${t.taskId}&since=9999`, { token })).json.task.photoCount;
    check('重复删同一张 → 计数不再减（幂等守卫）', rd2.status === 200 && cnt2 === cnt1, `cnt1=${cnt1} cnt2=${cnt2}`);

    const rc = await api('POST', '/api/m/close', { token, body: { tid: t.taskId, force: true } });
    check('close force → ok', rc.status === 200 && rc.json.ok === true, JSON.stringify(rc.json));

    const rp = await api('POST', '/api/m/photo-data', { token, body: { tid: t.taskId, photoId: photos[1] } });
    check('close 后照片 404', rp.status === 404, JSON.stringify(rp.json));

    const ru = await api('POST', '/api/m/upload', { session: sessA, body: { photoId: 'zzzzzzzzzz01', dataUrl: fakeJpegDataUrl(64), w: 1, h: 1, size: 10 } });
    check('close 后 upload → 409', ru.status === 409, JSON.stringify(ru.json));

    const rl = await api('POST', '/api/m/claim', { body: { token: t.token, deviceId: DEV_B } });
    check('close 后 claim → 409', rl.status === 409, JSON.stringify(rl.json));
  }

  console.log('\n== 12. force 建任务：先关再删，无孤儿分块 ==');
  let forceTid = '';
  {
    const r1 = await api('POST', '/api/m/tasks', { token, body: { label: 'force-旧' } });
    check('force 前置：建旧任务', r1.status === 200, JSON.stringify(r1.json));
    const oldTid = r1.json && r1.json.taskId;
    const s = await api('POST', '/api/m/claim', { body: { token: r1.json.token, deviceId: DEV_A } });
    check('force 前置：旧任务 claim', s.status === 200, JSON.stringify(s.json));
    // 128KB 大图（3 块），验证分块也被回收
    await api('POST', '/api/m/upload', { session: s.json.session, body: { photoId: 'forcephoto01', dataUrl: fakeJpegDataUrl(128 * 1024), w: 1, h: 1, size: 10 } });

    const r2 = await api('POST', '/api/m/tasks', { token, body: { label: 'force-新' } });
    check('有进行中任务再建 → 409', r2.status === 409, JSON.stringify(r2.json));
    const r3 = await api('POST', '/api/m/tasks', { token, body: { label: 'force-新', force: true } });
    check('force 建新 → 200', r3.status === 200, JSON.stringify(r3.json));
    forceTid = (r3.json && r3.json.taskId) || '';

    // PK-only 扫旧 taskId 的分块表：必须为 0（含 in-flight 上传竞态重建的兜底回收）
    const { client, TableStore, TABLE_MU_CHUNKS } = require('../src/mupload-db');
    const res = await client.getRange({
      tableName: TABLE_MU_CHUNKS,
      inclusiveStartPrimaryKey: [{ taskId: oldTid, key: TableStore.INF_MIN }],
      exclusiveEndPrimaryKey: [{ taskId: oldTid, key: TableStore.INF_MAX }],
      limit: 10,
    });
    check('force 后旧任务分块行=0（无孤儿）', (res.rows || []).length === 0, `got ${(res.rows || []).length}`);
  }

  console.log('\n== 7. 伪造签名限流 ==');
  {
    const forged = t.token.replace(/.$/, t.token.endsWith('a') ? 'b' : 'a');
    let got429 = false;
    for (let i = 0; i < 51; i++) {
      const r = await api('POST', '/api/m/claim', { body: { token: forged, deviceId: DEV_A } });
      if (r.status === 429) {
        got429 = true;
        check(`伪造签名第 ${i + 1} 次 → 429`, true);
        break;
      }
    }
    if (!got429) check('伪造签名 51 次 → 429', false, '始终未 429');
  }


  console.log('\n== 11. 清理 ==');
  {
    // 任务行/index 行直接删（close 只清了照片）；再注销测试账号
    const { deleteTaskRows } = require('../src/mupload-db');
    await deleteTaskRows(EMAIL, t.taskId);
    if (forceTid) await deleteTaskRows(EMAIL, forceTid);
    const r = await api('DELETE', '/api/account', { token });
    check('注销测试账号', r.status === 200, JSON.stringify(r.json));
  }

  console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('验证脚本异常:', err);
  process.exit(1);
});
