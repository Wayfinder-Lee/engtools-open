/**
 * 试卷题型清单（manifest）：解析前由用户声明本卷包含的大题题型与顺序，
 * 作为 LLM 大纲切块 / 逐块解析的软先验，并供题型比对守卫使用。
 * 清单是软先验——卷子与清单不符时按原文实际内容解析，守卫只提示不阻断。
 */
import type { Stage } from '../types';

/** 高中（高考）默认题型顺序 */
export const SENIOR_TYPE_DEFAULTS: readonly string[] = [
  '听力理解', '阅读理解A', '阅读理解B', '阅读理解C', '阅读理解D',
  '七选五', '完形填空', '语法填空', '应用文写作', '读后续写',
];

/** 高中备选（不默认） */
export const SENIOR_TYPE_EXTRAS: readonly string[] = ['任务型阅读', '概要写作', '单词拼写'];

/** 初中（中考）默认题型顺序（无七选五/读后续写；填空叫短文填空、写作叫书面表达） */
export const JUNIOR_TYPE_DEFAULTS: readonly string[] = [
  '听力理解', '阅读理解A', '阅读理解B', '阅读理解C',
  '完形填空', '短文填空', '补全对话', '任务型阅读', '书面表达',
];

/** 初中备选（不默认；各地叫法不一，均保留原名） */
export const JUNIOR_TYPE_EXTRAS: readonly string[] = [
  '单项选择', '选词填空', '首字母填空', '完成句子', '情景交际', '词汇运用', '综合填空', '语法填空',
];

export function defaultManifest(stage: Stage): string[] {
  return [...(stage === 'junior' ? JUNIOR_TYPE_DEFAULTS : SENIOR_TYPE_DEFAULTS)];
}

/** 左侧题型池：默认 + 备选 + 用户自定义（去重，保持加入顺序） */
export function manifestPalette(stage: Stage, customs: readonly string[]): string[] {
  const base = stage === 'junior' ? JUNIOR_TYPE_DEFAULTS : SENIOR_TYPE_DEFAULTS;
  const extras = stage === 'junior' ? JUNIOR_TYPE_EXTRAS : SENIOR_TYPE_EXTRAS;
  const known = new Set<string>([...base, ...extras]);
  return [...base, ...extras, ...customs.filter((c) => !known.has(c))];
}

/** 各地同物异名（比对守卫按组等价处理） */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['补全对话', '情景交际', '对话配对'],
  ['书面表达', '应用文写作', '英语写作'],
  ['任务型阅读', '阅读表达', '回答问题'],
  ['词汇运用', '单词拼写'],
  ['短文填空', '语篇填空', '综合填空'],
];

function synonymKey(name: string): string {
  for (const g of SYNONYM_GROUPS) if (g.includes(name)) return g[0];
  return name;
}

/** 题型名比对键：去空白 + 同义词组归并 */
export function manifestKey(name: string): string {
  return synonymKey(name.replace(/\s+/g, ''));
}

/** 题型清单 vs 实际识别到的大题比对。「阅读理解」泛称与 A–D 细分互相视作命中
 *  （清单是泛称而切块细分了 A–D，或反过来）；但字母对字母不互认——清单有 C
 *  而卷面只有 A/B 属于真实不符，必须报缺，否则清单枚举 A–D 就失去了核对意义 */
export function diffManifest(manifest: readonly string[], found: readonly string[]): { missing: string[]; extra: string[] } {
  const mKeys = new Set(manifest.map(manifestKey));
  const fKeys = new Set(found.map(manifestKey));
  const coversReading = (keys: Set<string>) => keys.has('阅读理解') || [...keys].some((k) => /^阅读理解[ABCD]$/.test(k));
  const missing = manifest.filter((m) => {
    const k = manifestKey(m);
    if (fKeys.has(k)) return false;
    if (k === '阅读理解') return !coversReading(fKeys);
    if (/^阅读理解[ABCD]$/.test(k)) return !fKeys.has('阅读理解');
    return true;
  });
  const extra = found.filter((f) => {
    const k = manifestKey(f);
    if (mKeys.has(k)) return false;
    if (k === '阅读理解') return !coversReading(mKeys);
    if (/^阅读理解[ABCD]$/.test(k)) return !mKeys.has('阅读理解');
    return true;
  });
  return { missing, extra };
}

/** 初中清单不得含七选五/读后续写（junior 路径规则）；历史恢复/跨学段恢复时剔除。
 *  异常载荷里可能混入非字符串项（null/undefined），一并滤掉，防止下游 manifestKey 抛错 */
export function sanitizeManifestForStage(manifest: readonly string[], stage: Stage): string[] {
  const strings = (Array.isArray(manifest) ? manifest : []).filter((m): m is string => typeof m === 'string');
  const cleaned = stage === 'junior' ? strings.filter((m) => !/七选五|读后续写/.test(m)) : strings;
  return cleaned;
}

// ─── 自定义题型记忆（localStorage，跨试卷保留）────────

const CUSTOM_TYPES_KEY = 'vb_exam_custom_types';

export function loadCustomTypes(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CUSTOM_TYPES_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  } catch {
    return [];
  }
}

export function rememberCustomType(name: string): void {
  const v = name.trim();
  if (!v) return;
  const cur = loadCustomTypes();
  if (!cur.includes(v)) {
    localStorage.setItem(CUSTOM_TYPES_KEY, JSON.stringify([...cur, v].slice(-20)));
  }
}

// ─── 题型 → 解析提示（逐块解析 prompt 的软先验）────────

const SECTION_KIND_HINTS: readonly { match: RegExp; hint: string }[] = [
  { match: /听力/, hint: '听力理解：对话/独白材料为 passage 块，其后紧跟对应编号的 choice 题（题干多为问题、选项为回答）；材料与题目交替出现时按原文顺序输出。' },
  { match: /^阅读理解[ABCD]?$/, hint: '阅读理解：文章为 passage 块（有独立字母标号时填 label），其后各编号题为 choice。' },
  { match: /七选五|六选五|补全[短篇]文/, hint: '七选五：正文（含 ___16___ 式空位编号）为一个 passage 块；选项集中为一个 choice 块（options A–G，number 与 stem 为空）。' },
  { match: /完形填空/, hint: '完形填空：带编号空格的正文为一个 passage 块，其后各编号空为 choice 题（选项 A–D）。' },
  { match: /语法填空|短文填空|语篇填空|综合填空|选词填空/, hint: '语篇型填空：整篇短文为【一个】blank 块（number 为空），空位以 _____ 保留并照抄括号提示词；若为方框选词，备选词照抄进 instruction。' },
  { match: /应用文|书面表达|读后续写|概要写作|写作/, hint: '写作题：完整题干（中文说明 + 英文情境 + 注意项）为一个 essay 块。' },
  { match: /任务型阅读|阅读表达|回答问题/, hint: '任务型阅读：文章为 passage 块，其后按题号输出各小题（问答/表格填空按 blank 或 other，保持原文表格文字不丢）。' },
  { match: /单项选择|单项填空|语法选择/, hint: '单项选择：每题号一题 choice。' },
  { match: /单词拼写|词汇运用|完成句子|首字母填空/, hint: '单句填空类：每题号一题，stem 为整句（含 _____ 与提示词），type=blank。' },
  { match: /补全对话|情景交际|对话配对/, hint: '补全对话：对话原文为 passage 块（空位以 _____ 保留）；备选项集中为一个 choice 块（按原文字母编号）。' },
];

/** 题型名 → 该大题的预期结构提示；识别不出返回空串（不注入） */
export function sectionKindHint(name: string): string {
  const n = name.replace(/\s+/g, '');
  for (const { match, hint } of SECTION_KIND_HINTS) {
    if (match.test(n)) return hint;
  }
  return '';
}

/** 在清单里找与块名最匹配的条目（精确 → 清单项是块名前缀/子串），返回其提示 */
export function hintForChunk(chunkName: string, manifest: readonly string[]): string {
  const direct = manifest.find((m) => m === chunkName)
    ?? manifest.find((m) => chunkName.startsWith(m) || m.startsWith(chunkName))
    ?? manifest.find((m) => chunkName.includes(m) || m.includes(chunkName));
  return sectionKindHint(direct ?? chunkName);
}
