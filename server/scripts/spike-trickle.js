'use strict';

/**
 * 大响应是「永久停摆」还是「慢速涓流」？
 * 给大行 getRow 挂 120s 长超时 + data 块日志（每块打时间戳/累计字节），
 * 观察吞吐曲线。结束后无论结果如何都退出。
 */
const TableStore = require('tablestore');
const HttpClient = TableStore.HttpClient;
const origHandle = HttpClient.prototype.handleRequest;
HttpClient.prototype.handleRequest = function (httpRequest, httpOptions, callback, error) {
  const wrapped = function (httpResp) {
    let bytes = 0;
    let chunks = 0;
    const t0 = Date.now();
    let lastLog = 0;
    httpResp.on('data', (c) => {
      bytes += c.length;
      chunks++;
      const now = Date.now();
      if (now - lastLog > 1000) {
        lastLog = now;
        process.stdout.write(`  [${((now - t0) / 1000).toFixed(1)}s] 累计 ${(bytes / 1024).toFixed(0)}KB (${chunks} 块)\n`);
      }
    });
    httpResp.on('end', () => console.log(`  [NET] end @ ${((Date.now() - t0) / 1000).toFixed(1)}s, 共 ${(bytes / 1024).toFixed(0)}KB`));
    httpResp.on('error', (e) => console.log(`  [NET] error @ ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`));
    httpResp.socket.on('timeout', () => console.log('  [NET] socket idle timeout 事件'));
    httpResp.socket.on('close', (hadErr) => console.log(`  [NET] socket close (hadError=${hadErr}) @ ${((Date.now() - t0) / 1000).toFixed(1)}s`));
    callback(httpResp);
  };
  return origHandle.call(this, httpRequest, httpOptions, wrapped, error);
};

const { client } = require('../src/tablestore');

(async () => {
  console.log('getRow row-s0（1MB data 列），最长观察 120s …');
  const t0 = Date.now();
  try {
    await Promise.race([
      client.getRow({ tableName: 'mupload_spike_tmp', primaryKey: [{ k: 'row-s0' }], maxVersions: 1 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('OBSERVATION_TIMEOUT_120S')), 120000)),
    ]);
    console.log(`✅ resolve，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`❌ ${e.message}（总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  }
  process.exit(0);
})();
