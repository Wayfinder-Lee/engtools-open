'use strict';
/** spike（只读）：复现翻页续扫 OTSInvalidPK——rangeAll limit=1 + 打印 nextStartPrimaryKey 形状。 */
const { client, TableStore, TABLE_MU_PHOTOS } = require('../src/mupload-db');

(async () => {
  const T = TableStore;
  for (let round = 1; round <= 8; round += 1) {
    const params = {
      tableName: TABLE_MU_PHOTOS,
      direction: T.Direction.FORWARD,
      maxVersions: 1,
      inclusiveStartPrimaryKey: [{ taskId: T.INF_MIN, photoId: T.INF_MIN }],
      exclusiveEndPrimaryKey: [{ taskId: T.INF_MAX, photoId: T.INF_MAX }],
      limit: 1,
    };
    let pages = 0;
    try {
      for (;;) {
        const res = await client.getRange(params);
        pages += 1;
        if (!res.nextStartPrimaryKey) break;
        if (round === 1 && pages === 1) {
          console.log('nextStartPrimaryKey 条目形状:', JSON.stringify(res.nextStartPrimaryKey.map((k) => ({
            keys: Object.keys(k),
            name: k.name !== undefined ? String(k.name) : undefined,
            columnName: k.columnName,
            value: typeof k.value,
            columnValue: typeof k.columnValue,
          }))));
        }
        params.inclusiveStartPrimaryKey = res.nextStartPrimaryKey.map((k, i) => {
          const val = k.value !== undefined ? k.value : k.columnValue;
          const nm = Object.keys(params.inclusiveStartPrimaryKey[i])[0];
          return { [nm]: val };
        });
        if (pages > 300) break;
      }
      console.log(`round ${round}: OK 翻了 ${pages} 页`);
    } catch (err) {
      console.log(`round ${round}: 第 ${pages} 页后续扫 FAIL: ${err.message}`);
      console.log('堆栈:', (err.stack || '').split('\n').slice(0, 6).join('\n'));
      console.log('续扫起点详情:', JSON.stringify(params.inclusiveStartPrimaryKey.map((e) => ({
        keys: Object.keys(e),
        vals: Object.values(e).map((v) => `${typeof v}:${String(v).slice(0, 40)}`),
      }))));
    }
  }
  process.exit(0);
})().catch((e) => { console.error('spike 异常:', e); process.exit(1); });
