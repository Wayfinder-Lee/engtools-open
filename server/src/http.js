'use strict';

/** HTTP 工具：CORS、请求体读取、JSON 响应。 */

const config = require('./config');

/** 计算该请求应返回的 Access-Control-Allow-Origin 值；不允许则返回 null。 */
function resolveCorsOrigin(req) {
  const origin = req.headers.origin;
  if (config.allowedOrigins.includes('*')) return '*';
  if (origin && config.allowedOrigins.includes(origin)) return origin;
  return null;
}

/** 给响应写入 CORS 头。 */
function applyCors(req, res) {
  const allowOrigin = resolveCorsOrigin(req);
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    if (allowOrigin !== '*') res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** 发送 JSON 响应（自动带 CORS 头）。 */
function sendJson(req, res, status, body) {
  applyCors(req, res);
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** 处理 OPTIONS 预检。 */
function sendPreflight(req, res) {
  applyCors(req, res);
  res.writeHead(204);
  res.end();
}

/**
 * 读取并解析 JSON 请求体，超过 maxBodyBytes 抛错。
 * 返回解析后的对象（空体返回 {}）。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_err) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { resolveCorsOrigin, applyCors, sendJson, sendPreflight, readJsonBody };
