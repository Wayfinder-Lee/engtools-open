import type { ExamQuestion, ExamQuestionType, ExamSection } from '../types';
import { stripLeadingTag, stripOptionLabel } from '../services/examDocxExport';

const VALID_TYPES: ExamQuestionType[] = ['passage', 'choice', 'blank', 'essay', 'other'];

/** 归一比对：去全部空白 + 标点形态统一（tab/空格/全半角分隔符变体不干扰逐字比较） */
const flatNorm = (s: string) => s.replace(/\s+/g, '').replace(/[.．、:：)]/g, '.');

/** 纯选项串题干（无题号、无 options，stem 形如 "A. changes\tB. captures…"）的就地拆解；
 *  形态不严格（A 起始、2–7 段、标号严格 A,B,C… 递增、每段有文案）返回 null 不动 */
function parseOptionRunStem(stem: string): { label: string; text: string }[] | null {
  if (!/^\s*[A-G]\s*[.．、:：)]/.test(stem)) return null;
  const parts = stem.split(/(?=[A-G]\s*[.．、:：)])/);
  if (parts.length < 2 || parts.length > 7) return null;
  const opts: { label: string; text: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^([A-G])\s*[.．、:：)]?\s*([\s\S]*)$/);
    if (!m || m[1] !== String.fromCharCode(65 + i) || !m[2].trim()) return null;
    opts.push({ label: m[1], text: m[2].trim() });
  }
  return opts;
}

/** LLM 输出清洗：字段强转 + 题号/选项标签提取去重 + 丢弃空题 + type 兜底 */
export function sanitizeQuestions(raw: Omit<ExamQuestion, 'id'>[]): ExamQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q) => q && ((q.stem || '').trim().length > 0 || (q.options || []).length > 0))
    .map((q) => {
      let number = String(q.number ?? '');
      let stem = String(q.stem ?? '');
      if (!number) {
        // 题号漏提时从题干开头补提（"21．What..." → number=21）
        const m = stem.match(/^\s*(\d{1,3})\s*[.．、]\s*/);
        if (m) { number = m[1]; stem = stem.slice(m[0].length); }
      } else {
        stem = stripLeadingTag(number, stem);
      }
      // 完形/七选五 stem 污染守卫（34 次真实复现中 ~41% 调用命中此家族）：
      // ① 裸题号复述（stem === "41"，渲染层会变成 "41. 41"）
      if (number && stem.trim() === number) stem = '';
      let options = Array.isArray(q.options) && q.options.length > 0
        ? q.options.filter((o) => o && (o.label || o.text)).map((o) => {
          let label = String(o.label ?? '');
          let text = String(o.text ?? '');
          if (!label) {
            // 标签漏提时从选项文本补提（"A. text"/"A text" → label=A）；必须带分隔符，避免剥掉正文首字母
            const m = text.match(/^\s*([A-G])(\s*[.．、:：)]\s*|\s+)/);
            if (m) { label = m[1]; text = text.slice(m[0].length); }
          } else {
            text = stripOptionLabel(label, text);
          }
          return { label, text };
        })
        : undefined;
      // ② 选项行复述（LLM 把原始选项整行连 tab 逐字抄进 stem、又正确拆出 options）：
      //    stem 归一后逐字等于 options 拼接 → 清空 stem（合法题干是疑问句/补全句，不可能逐字等于选项行）
      if (options && options.length >= 2) {
        const rebuilt = options.map((o) => `${o.label}.${o.text ?? ''}`).join('');
        if (stem.trim() && flatNorm(stem) === flatNorm(rebuilt)) stem = '';
      }
      // ③ 无题号 + 无 options + 纯选项串题干：就地拆解为 options（type 补 choice）
      let forcedChoice = false;
      if (!number && !options) {
        const run = parseOptionRunStem(stem);
        if (run) { options = run; stem = ''; forcedChoice = true; }
      }
      return {
        id: crypto.randomUUID(),
        type: forcedChoice ? 'choice' as ExamQuestionType : (VALID_TYPES.includes(q.type) ? q.type : 'other'),
        number,
        stem,
        label: q.label ? String(q.label) : undefined,
        options,
        answer: String(q.answer ?? ''),
      };
    })
    // 空壳题过滤：七选五等大题的空位编号内嵌在正文（___16___），LLM 偶尔仍会为编号
    // 输出 stem 只剩数字/下划线、无 options 的条目——保真排版下是纯噪音，丢弃。
    // 完形填空的逐空 choice（stem 空但有 options）不受影响。
    .filter((q) => (q.options && q.options.length > 0) || /[a-zA-Z\u4e00-\u9fff]/.test(q.stem));
}

/** essay \u9898\u5e72\u9010\u5b57\u590d\u8ff0\u5927\u9898\u8bf4\u660e\uff08\u8bfb\u540e\u7eed\u5199\u88ab\u5288\u5757\u65f6\u7684\u5e7b\u5f71\u5f62\u6001\uff09\uff1a\u8be5\u9898\u65e0\u72ec\u7acb\u5185\u5bb9\uff0c
 *  \u4fdd\u7559\u4f1a\u8ba9\u8bf4\u660e\u6e32\u67d3\u4e24\u904d + \u51ed\u7a7a\u591a\u51fa\u4e00\u7ec4\u7b54\u9898\u7ebf\u3002\u8bf4\u660e\u4e3a\u7a7a\u4e0d\u89e6\u53d1\u3002 */
export function dropInstructionEcho(questions: ExamQuestion[], instruction: string): ExamQuestion[] {
  const instr = (instruction ?? '').replace(/\s+/g, '');
  if (!instr) return questions;
  return questions.filter((q) => !(q.type === 'essay' && (q.stem ?? '').replace(/\s+/g, '') === instr));
}

/** 合并后的阅读题按篇标号分块归位：以带 A–D 标号的 passage 为块首分组、按标号稳定排序，
 *  无标号的前导内容保持最前。重试补回的阅读块（如 B）不再被追加到 D 之后。 */
function orderReadingBlocks(questions: ExamQuestion[]): ExamQuestion[] {
  const blocks: { label: string; qs: ExamQuestion[] }[] = [];
  for (const q of questions) {
    const lbl = q.type === 'passage' && q.label && /^[A-D]$/.test(q.label) ? q.label : null;
    if (lbl) blocks.push({ label: lbl, qs: [q] });
    else if (blocks.length > 0) blocks[blocks.length - 1].qs.push(q);
    else blocks.push({ label: '', qs: [q] });
  }
  // 标号有重复时（一份文档贴两套卷、各含 A–D；超大块切分的同名续块），
  // 全局按字母排序会把两卷内容交叉穿插——保持原序（纯追加语义），仅标号唯一时才归位。
  const labels = blocks.map((b) => b.label).filter(Boolean);
  if (new Set(labels).size !== labels.length) return questions;
  return blocks
    .map((b, i) => ({ b, i }))
    .sort((x, y) =>
      (x.b.label ? x.b.label.charCodeAt(0) : -1) - (y.b.label ? y.b.label.charCodeAt(0) : -1) || x.i - y.i)
    .flatMap(({ b }) => b.qs);
}



/** 「阅读理解A/B/C/D」各块合并为一个「阅读理解」大题，并给每块的首篇文章补 A–D 篇标号。
 *  纯函数：绝不修改入参（setPaper 更新器可能在 StrictMode 下双调，变异入参会重复并入题目） */
export function mergeReadingSections(sections: ExamSection[]): ExamSection[] {
  const out: ExamSection[] = [];
  for (const sec of sections) {
    const m = sec.title.match(/^阅读理解\s*([A-D])$/);
    if (!m) { out.push(sec); continue; }
    const withLabel = sec.questions.map((q) => (q.type === 'passage' && !q.label ? { ...q, label: m[1] } : q));
    const i = out.findIndex((s) => s.title === '阅读理解');
    if (i < 0) {
      out.push({ ...sec, title: '阅读理解', questions: withLabel });
      continue;
    }
    const prev = out[i];
    out[i] = {
      ...prev,
      questions: orderReadingBlocks([...prev.questions, ...withLabel]),
      // 重试补齐的阅读块自带节标题等结构行：去重后并入（此前会被整个丢弃）
      subHeaders: [...(prev.subHeaders ?? []), ...(sec.subHeaders ?? []).filter((h) => !(prev.subHeaders ?? []).includes(h))],
      partTitle: prev.partTitle ?? sec.partTitle,
      volumeDivider: prev.volumeDivider ?? sec.volumeDivider,
    };
  }
  return out;
}
