/**
 * NLS TTS 冒烟：真连智能语音交互服务，验证 CreateToken 签名与 aida/aijia 两个发音人。
 *
 * 前置：server/.env 里有 NLS_AK_ID / NLS_AK_SECRET / NLS_APPKEY_MALE / NLS_APPKEY_FEMALE
 *       （config.js 会自动读取 server/.env）
 * 运行：node scripts/spike-nls-tts.mjs
 * 产物：~/Downloads/nls-spike-男声.mp3 / nls-spike-女声.mp3（仓库外，可直接试听核对音色）
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const tts = require('../server/src/tts.js');

const TEXT = '某某学校高三上期第一次月考，英语听力部分。现在开始试音。';
const CASES = [
  ['男声', 'male'],
  ['女声', 'female'],
];

const token = await tts.createNlsToken();
console.log(`✓ CreateToken 成功，有效期至 ${new Date(token.expireMs).toLocaleString()}`);

for (const [label, kind] of CASES) {
  const buf = await tts.synthesize(kind, TEXT, 0);
  const out = path.join(os.homedir(), 'Downloads', `nls-spike-${label}.mp3`);
  fs.writeFileSync(out, buf);
  console.log(`✓ ${label}合成成功：${buf.length} 字节 → ${out}`);
}
console.log('✓ 全部通过：请试听两个 mp3 核对音色与语速');
