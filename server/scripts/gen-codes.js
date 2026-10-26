'use strict';

/**
 * 批量生成兑换码并写入 redeem_codes 表，同时导出 CSV（上架第三方发卡平台用）。
 *
 * 用法（在 server/ 目录，配置好 .env 后）：
 *   node scripts/gen-codes.js <数量> <每个码的额度>
 *   例：node scripts/gen-codes.js 50 100   # 生成 50 个、每个 100 点额度的码
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/tablestore');

// 去掉易混淆字符（0/O、1/I/L）
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomCode() {
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  // 形如 ENGT-XXXX-XXXX-XXXX-XXXX
  return 'ENGT-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16);
}

async function main() {
  const count = parseInt(process.argv[2], 10);
  const credits = parseInt(process.argv[3], 10);
  if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(credits) || credits <= 0) {
    console.error('用法: node scripts/gen-codes.js <数量> <每个码的额度>');
    process.exit(1);
  }

  const generated = [];
  for (let i = 0; i < count; i++) {
    let code;
    let ok = false;
    // 极小概率碰撞时重试
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      code = randomCode();
      ok = await db.createCode(code, credits);
    }
    if (!ok) {
      console.error('生成失败（重复过多），已生成', generated.length, '个');
      break;
    }
    generated.push(code);
    process.stdout.write(`\r已生成 ${generated.length}/${count}`);
  }
  process.stdout.write('\n');

  // 导出 CSV
  const csvPath = path.join(__dirname, '..', `codes-${credits}pt-${generated.length}.csv`);
  const csv = 'code,credits\n' + generated.map((c) => `${c},${credits}`).join('\n') + '\n';
  fs.writeFileSync(csvPath, csv, 'utf8');
  console.log(`完成。共 ${generated.length} 个码，面值 ${credits}，已导出：${csvPath}`);
  console.log('把 CSV 里的 code 列上架发卡平台即可。');
}

main().catch((err) => {
  console.error('出错:', err);
  process.exit(1);
});
