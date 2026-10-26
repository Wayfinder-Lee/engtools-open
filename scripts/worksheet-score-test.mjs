// 个性化学案评分去聚类验证：直连 LLM 上游（不经过后端，不扣网站额度）。
// 对强/中/弱三档合成作文跑完整生产 prompt（handwritingPrompts.ts 单一真源），
// 检查 score 是否拉开、定档句是否出现在 overallComment 首句。
//
// 用法：node scripts/worksheet-score-test.mjs [--type=continuation|practical] [--model=gemini-3.5-flash]
// 2026-10 背景：25 分制读后续写扎堆 18 分（旧版判据抽象 + JSON 示例锚定 9/9/18），
// 重写评分标准（档内上/下限 + 降档硬规则 + 先定档后取分）后用本脚本回归。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
let type = 'continuation';
let model = 'gemini-3.5-flash';
for (const a of args) {
  if (a.startsWith('--type=')) type = a.slice('--type='.length);
  else if (a.startsWith('--model=')) model = a.slice('--model='.length);
}

const env = {};
for (const line of fs.readFileSync(path.join(root, 'server/.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
if (!env.LLM_ENDPOINT || !env.LLM_API_KEY) {
  console.error('server/.env 缺 LLM_ENDPOINT / LLM_API_KEY');
  process.exit(1);
}

const vite = await createServer({ root, server: { middlewareMode: true }, logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
const { buildHandwritingWorksheetPrompt } = await vite.ssrLoadModule('/src/prompts/handwritingPrompts.ts');
const { normalizeHandwritingResult } = await vite.ssrLoadModule('/src/services/llm.ts');
await vite.close();

// ── normalize 断言（分数硬化：字符串数字/越界钳制/round/求和兜底/maxScore 按题型纠偏） ──
{
  const MIN = { studentName: 't', overallComment: 'x' };
  const A = [
    ['score "18" 字符串 → 18', { ...MIN, score: '18', maxScore: 25 }, 'continuation', (r) => r.score === 18],
    ['score 99 → 钳 25', { ...MIN, score: 99, maxScore: 25 }, 'continuation', (r) => r.score === 25],
    ['score -3 → 钳 0', { ...MIN, score: -3 }, 'practical', (r) => r.score === 0],
    ['score 18.7 → round 19', { ...MIN, score: 18.7 }, undefined, (r) => r.score === 19],
    ['score 缺失 → 按维度和 16 兜底', { ...MIN, scoreBreakdown: { content: 6, language: 6, cohesion: 4 } }, 'continuation', (r) => r.score === 16 && r.scoreBreakdown?.content === 6],
    ['续写自报 maxScore 15 → 纠偏 25', { ...MIN, score: 10, maxScore: 15 }, 'continuation', (r) => r.maxScore === 25 && r.score === 10],
    ['无 essayType → maxScore 信任自报', { ...MIN, score: 10, maxScore: 15 }, undefined, (r) => r.maxScore === 15],
  ];
  let npass = 0;
  for (const [name, raw, type, ok] of A) {
    try {
      const r = normalizeHandwritingResult(raw, type ? { essayType: type } : undefined);
      if (ok(r)) { npass++; console.log(`  ✅ ${name}`); }
      else console.log(`  ❌ ${name} → score=${r.score} maxScore=${r.maxScore}`);
    } catch (e) { console.log(`  ❌ ${name} → 抛错 ${e.message}`); }
  }
  console.log(`normalize 断言：${npass}/${A.length} 通过\n`);
}

// ── 合成题干与三档作文 ──
const CONT_STORY = `One Saturday morning, Tom went to the park to practice for the school running race. He had trained hard for months, but he still doubted himself. As he was running along the lake, he noticed an old man sitting on a bench, looking pale and tired. Tom stopped and asked if he was OK. The old man smiled weakly and said he had forgotten to take his medicine, which was at home far away.`;
const OPEN1 = 'Without hesitation, Tom decided to help the old man.';
const OPEN2 = 'When the old man finally took his medicine, he thanked Tom again and again.';

const CASES = type === 'practical' ? [
  {
    name: '应用文·中档（要点全+少量错误，期望 10-12）',
    params: { studentName: '测a', gradeLevel: '高三', essayType: 'practical', stage: 'senior',
      essayPrompt: '假定你是李华，你的英国朋友 Peter 来信询问你校学生体育运动情况。请你给他回信，内容包括：1. 学校的体育场馆；2. 主要的运动项目；3. 你喜欢的项目。注意：1. 词数 100 左右；2. 可以适当增加细节，以使行文连贯。',
      essayText: `Dear Peter,\n\nI'm glad to tell you about sports in our school. Our school have a big playground and two basketball courts. There is also a swimming pool in the gym. Students in our school likes playing basketball and football. Running is popular too. Every afternoon, we can see many students exercise on the playground.\n\nMy favorite sport is basketball. I play it with my friends after class. It make me strong and happy. I hope you can visit our school and play with us.\n\nYours, Li Hua` },
    expect: (s) => s >= 10 && s <= 12,
  },
] : [
  {
    name: '续写·强（情节呼应+句式多样+升华，期望 19-23）',
    params: { studentName: '测a', gradeLevel: '高三', essayType: 'continuation', stage: 'senior',
      essayPrompt: CONT_STORY, promptSummary: CONT_STORY, opening1: OPEN1, opening2: OPEN2,
      essayText: `${OPEN1} Holding his arm gently, Tom walked him slowly along the path, stopping whenever the old man needed a rest. The morning sun grew hotter, and sweat rolled down Tom's face, but he never complained. Looking at the tired old man, Tom suddenly remembered the water bottle in his backpack, which he handed over with a smile. Gradually, the old man's color returned, and his steps became steadier. What Tom didn't notice was that his running watch had recorded his longest "race" ever.\n\n${OPEN2} "You gave up your training for a stranger," the old man said, his eyes wet with gratitude. Tom shook his head, saying that helping others mattered more than winning a race. Word spread quickly, and by afternoon the whole park knew the young runner with a kind heart. On Monday, Tom stood at the starting line more confident than before, because he had already won a race that no medal could measure.` },
    expect: (s) => s >= 19 && s <= 23,
  },
  {
    // 旧版「18 分扎堆」的标准画像：情节完整稳定、语言基本无误、但只有动作+对话、无描写多样性、无升华
    name: '续写·稳定无亮点（旧 18 分画像，期望 16-18）',
    params: { studentName: '测b', gradeLevel: '高三', essayType: 'continuation', stage: 'senior',
      essayPrompt: CONT_STORY, promptSummary: CONT_STORY, opening1: OPEN1, opening2: OPEN2,
      essayText: `${OPEN1} Tom asked the old man where he lived. The old man told him his home was near the school. Tom held the old man's arm and they walked slowly along the road. The sun was big and hot. "Are you tired?" Tom asked. "A little," the old man said with a smile. They stopped two times to have a rest. After forty minutes, they got to the old man's home.\n\n${OPEN2} He said Tom was a good boy and invited him to visit next time. Tom said goodbye and went back to the park. He was late for his training, but he felt happy. He practiced running until noon and then went home for lunch.` },
    expect: (s) => s >= 14 && s <= 18, // rubric 判据「描写单一→刚达四档 16」；三/四档界 ±2 是 temp 0.5 的固有方差
  },
  {
    name: '续写·中（句式单一+时态错误多+情节平铺，期望 11-16）',
    params: { studentName: '测c', gradeLevel: '高三', essayType: 'continuation', stage: 'senior',
      essayPrompt: CONT_STORY, promptSummary: CONT_STORY, opening1: OPEN1, opening2: OPEN2,
      essayText: `${OPEN1} He help the old man to walk slowly. The old man was very tired. Tom give him some water. The old man drink the water and feel a little better. They walked and rest many times. At last, they reached the old man's home. The old man was very happy and say thank you to Tom.\n\n${OPEN2} He say Tom is a good boy. Tom was very happy too. He think helping people is more important than running race. He go back to park and practice running. He run very fast because he was happy. He believe he can win the race next week.` },
    expect: (s) => s >= 11 && s <= 16, // 三/四档边界文：rubric「四档 16=错误略多」亦成立，允许 16
  },
  {
    name: '续写·弱（情节脱轨+严重错误+词数不足，期望 ≤13）',
    params: { studentName: '测d', gradeLevel: '高三', essayType: 'continuation', stage: 'senior',
      essayPrompt: CONT_STORY, promptSummary: CONT_STORY, opening1: OPEN1, opening2: OPEN2,
      essayText: `${OPEN1} Tom is run in park every day. He like run. The old man is very old. Tom go home with the old man and play games. He is happy.\n\n${OPEN2} Tom go to school and study English. The end.` },
    expect: (s) => s <= 13, // 词数触发器兜底 15-2=13；脱轨若被严格读应 ≤10，模型常宽松读段首句衔接
  },
];

let pass = 0;
for (const c of CASES) {
  const prompt = buildHandwritingWorksheetPrompt(c.params);
  console.log(`\n=========== ${c.name} ===========`);
  const t0 = Date.now();
  try {
    const resp = await fetch(env.LLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: '请根据系统提示中的要求，为该学生生成完整学案 JSON。' },
        ],
      }),
    });
    if (!resp.ok) { console.log(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`); continue; }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const r = JSON.parse(cleaned);
    const s = typeof r.score === 'number' ? r.score : null;
    const ok = s != null && c.expect(s);
    if (ok) pass++;
    console.log(`score: ${s}/${r.maxScore}  维度: ${r.scoreBreakdown ? `${r.scoreBreakdown.content}+${r.scoreBreakdown.language}+${r.scoreBreakdown.cohesion}` : '无'}  ${ok ? '✅ 符合预期' : '❌ 不符合预期'}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    console.log(`overallComment: ${String(r.overallComment || '').slice(0, 80)}`);
    console.log(`定档句: ${/定[一二三四五]档/.test(String(r.overallComment || '')) ? '✅ 有' : '❌ 缺失'}`);
  } catch (e) {
    console.log(`失败: ${e.message}`);
  }
}
console.log(`\n==== ${pass}/${CASES.length} 通过 ====`);
