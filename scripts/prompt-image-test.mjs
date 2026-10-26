// 本地「看图/图表作文题干配图」读图 prompt 测试：直连 LLM 上游（不经过后端 /api/llm/chat，不扣网站额度）。
//
// 用法：
//   node scripts/prompt-image-test.mjs <图片路径...> [--model=gemini-2.5-flash]
//
// - 读 server/.env 的 LLM_ENDPOINT / LLM_API_KEY
// - prompt 从 src/prompts/promptImageReadingPrompt.ts 经 vite ssrLoadModule 加载（与线上一份真源）
// - 请求参数镜像 readPromptImage（temp 0.1 / max_tokens 4000）；reasoning_effort low
//   对应登录态走中转的参数，自备 key 直连态没有它（差异主要在 thinking 深度）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 参数 ──
const args = process.argv.slice(2);
let model = 'gemini-2.5-flash';
const images = [];
for (const a of args) {
  if (a.startsWith('--model=')) model = a.slice('--model='.length);
  else images.push(a);
}
if (!images.length) {
  console.error('用法: node scripts/prompt-image-test.mjs <图片路径...> [--model=xxx]');
  process.exit(1);
}

// ── .env ──
const env = {};
for (const line of fs.readFileSync(path.join(root, 'server/.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
if (!env.LLM_ENDPOINT || !env.LLM_API_KEY) {
  console.error('server/.env 缺 LLM_ENDPOINT / LLM_API_KEY');
  process.exit(1);
}

// ── prompt 单一真源 ──
const vite = await createServer({ root, server: { middlewareMode: true }, logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
const { PROMPT_IMAGE_READING_SYSTEM, PROMPT_IMAGE_READING_USER } = await vite.ssrLoadModule('/src/prompts/promptImageReadingPrompt.ts');
await vite.close();

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

for (const img of images) {
  const full = path.resolve(img);
  const ext = path.extname(full).toLowerCase();
  const mime = MIME[ext] || 'image/jpeg';
  const dataUrl = `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`;

  console.log(`\n=========== ${path.basename(full)} (${model}) ===========`);
  const t0 = Date.now();
  try {
    const resp = await fetch(env.LLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 4000,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: PROMPT_IMAGE_READING_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT_IMAGE_READING_USER },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) {
      console.log(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      continue;
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '(空)';
    console.log(`--- 读图结果 (${((Date.now() - t0) / 1000).toFixed(1)}s) ---`);
    console.log(content);
  } catch (e) {
    console.log(`请求失败: ${e.message}`);
  }
}
