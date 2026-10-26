// 本地 OCR prompt 测试：直连 LLM 上游（不经过后端 /api/llm/chat，不扣网站额度）。
//
// 用法：
//   export PATH="/Users/william/nodejs/bin:$PATH"
//   node scripts/ocr-test.mjs <图片路径...> [--model=gemini-2.5-flash]
//
// - 读 server/.env 的 LLM_ENDPOINT / LLM_API_KEY
// - prompt 与段落组装语义均从 src/services/llm.ts 经 vite ssrLoadModule 加载
//   （与线上一份真源，改 prompt 即测）
// - ⚠️ PII：测试图与 OCR 输出可能含学生姓名——图片留在 ~/Downloads（仓库外），
//   输出只打印到终端，禁止把输出粘贴进仓库或文档。
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
  console.error('用法: node scripts/ocr-test.mjs <图片路径...> [--model=xxx]');
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

// ── prompt / 组装语义单一真源 ──
const vite = await createServer({ root, server: { middlewareMode: true }, logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
const { OCR_SYSTEM_PROMPT, assembleOcrLines } = await vite.ssrLoadModule('/src/services/llm.ts');
await vite.close();

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

for (const img of images) {
  const full = path.resolve(img);
  const ext = path.extname(full).toLowerCase();
  const mime = MIME[ext] || 'image/jpeg';
  const dataUrl = `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`;

  const label = path.basename(full);
  console.log(`\n=========== ${label} (${model}) ===========`);
  const t0 = Date.now();
  try {
    const resp = await fetch(env.LLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: OCR_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Please transcribe the text and extract the student name from the name field. Return as JSON: {"lines":[{"t":"...","p":true},...], "studentName":"..."}' },
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
    console.log(`--- 原始返回 (${((Date.now() - t0) / 1000).toFixed(1)}s，前 600 字) ---`);
    console.log(content.slice(0, 600));
    // 组装展示：与产品代码同一 assembleOcrLines + normalizeOcrParagraphs 语义
    try {
      const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      const parsed = JSON.parse(cleaned);
      const assembled = assembleOcrLines(parsed)
        .replace(/(?<!\n)[ \t]*\n(?!\n)[ \t]*/g, ' ')
        .trim();
      const paras = assembled.split('\n\n');
      console.log(`\n--- 组装结果：${paras.length} 个自然段，${assembled.length} 字符 ---`);
      paras.forEach((p, i) => {
        console.log(`  [段${i + 1}] ${p.length > 120 ? p.slice(0, 120) + '…' : p}`);
      });
      const pTrue = Array.isArray(parsed.lines) ? parsed.lines.filter((l) => l?.p === true).length : '-';
      const pFalse = Array.isArray(parsed.lines) ? parsed.lines.filter((l) => l?.p === false).length : '-';
      console.log(`--- lines: ${Array.isArray(parsed.lines) ? parsed.lines.length : '无'} 行（p:true=${pTrue} p:false=${pFalse}）studentName: ${JSON.stringify(parsed.studentName)} ---`);
    } catch { /* 非 JSON 输出，上面原文已打印 */ }
  } catch (e) {
    console.log(`请求失败: ${e.message}`);
  }
}
