/**
 * 将 invite-config.json 中的 API Key 拆分为 3 个碎片文件。
 *
 * 用法：node scripts/split-keys.js
 *
 * 输入：public/invite-config.json（源文件，含完整 API Key）
 * 输出：
 *   public/invite-p1.json
 *   public/invite-p2.json
 *   public/invite-p3.json
 *
 * 每个碎片文件保留相同的邀请码结构和用户信息，
 * 但 apiKey 字段只包含完整 Key 的 1/3。
 * 前端运行时同时请求 3 个文件并拼接还原。
 */

const fs = require('fs');
const path = require('path');

const SPLIT_COUNT = 3;
const SRC = path.join(__dirname, '..', 'public', 'invite-config.json');
const PUBLIC = path.join(__dirname, '..', 'public');

// 读取源配置
if (!fs.existsSync(SRC)) {
  console.error('invite-config.json not found — skipping key split');
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(SRC, 'utf-8'));

// 初始化 N 个碎片对象
const parts = Array.from({ length: SPLIT_COUNT }, () => ({}));

for (const [code, entry] of Object.entries(config)) {
  const key = entry.apiKey || '';
  const chunkSize = Math.ceil(key.length / SPLIT_COUNT);

  for (let i = 0; i < SPLIT_COUNT; i++) {
    const fragment = key.slice(i * chunkSize, (i + 1) * chunkSize);
    parts[i][code] = {
      name: entry.name,
      endpoint: entry.endpoint,
      apiKey: fragment,
      model: entry.model,
      part: i + 1,  // 标记这是第几片
      total: SPLIT_COUNT,
    };
  }
}

// 写入碎片文件
for (let i = 0; i < SPLIT_COUNT; i++) {
  const file = path.join(PUBLIC, `invite-p${i + 1}.json`);
  fs.writeFileSync(file, JSON.stringify(parts[i], null, 2), 'utf-8');
  console.log(`Written: public/invite-p${i + 1}.json`);
}

console.log('Key splitting complete.');
