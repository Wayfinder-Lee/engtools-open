'use strict';

/**
 * 大列读挂起定位：网络层 vs 解析层。
 * 猴子补丁 HttpClient.prototype.handleRequest，给每个响应挂 data/end/error 探针，
 * 看大响应是「字节没到齐」还是「到齐了但 SDK 不 resolve」。
 */
const TableStore = require('tablestore');

const HttpClient = TableStore.HttpClient;
const origHandle = HttpClient.prototype.handleRequest;
HttpClient.prototype.handleRequest = function (httpRequest, httpOptions, callback, error) {
  const wrapped = function (httpResp) {
    let bytes = 0;
    const t0 = Date.now();
    httpResp.on('data', (c) => {
      bytes += c.length;
    });
    const origEnd = httpResp.emit.bind(httpResp, 'end');
    // 在最前面再挂一个 end 监听（emit 顺序按注册顺序，我们注册得最早，先打日志）
    httpResp.on('end', () => {
      console.log(`[NET] end: 共 ${bytes} 字节, 耗时 ${Date.now() - t0}ms, content-length=${httpResp.headers && httpResp.headers['content-length']}`);
    });
    httpResp.on('error', (e) => console.log(`[NET] error: ${e.message}`));
    callback(httpResp);
  };
  return origHandle.call(this, httpRequest, httpOptions, wrapped, error);
};

const { client } = require('../src/tablestore');

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error(`HANG(${label})`), { code: 'SPIKE_HANG' })), ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

(async () => {
  console.log('-- 小行对照（row-tiny）--');
  try {
    await withTimeout(client.getRow({ tableName: 'mupload_spike_tmp', primaryKey: [{ k: 'row-tiny' }], maxVersions: 1 }), 10000, 'tiny');
    console.log('   tiny getRow ✅\n');
  } catch (e) {
    console.log(`   tiny getRow ${e.code === 'SPIKE_HANG' ? '🚨 HANG' : '❌ ' + e.message}\n`);
  }

  console.log('-- 大行（row-s0, 1MB data 列）--');
  try {
    await withTimeout(client.getRow({ tableName: 'mupload_spike_tmp', primaryKey: [{ k: 'row-s0' }], maxVersions: 1 }), 20000, 'big');
    console.log('   big getRow ✅（居然没挂？）\n');
  } catch (e) {
    console.log(`   big getRow ${e.code === 'SPIKE_HANG' ? '🚨 HANG（网络层探针若已打出 end = 解析层问题；没打 end = 网络层问题）' : '❌ ' + e.message}\n`);
  }

  setTimeout(() => process.exit(0), 500).unref();
})();
