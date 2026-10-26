/**
 * 试卷组卷纯函数（ExamPaper.tsx 抽出，供组件与 headless e2e 管线共用）：
 * - splitOversizedChunk：超大块按题号行边界二次切分
 * - extractExamMeta：卷头信息正则提取（不走 LLM）
 * - assemblePaper：解析成功的块组装成卷
 */
import type {
  ExamPaper, ExamPaperMeta, ExamSectionParseResult, Stage,
} from '../types';
import { matchIntroLine, type SectionStructure } from './examStructure';
import { mergeReadingSections, sanitizeQuestions, dropInstructionEcho } from './examSanitize';

/** 待解析的大题块（structure = 原文捕获的卷/部分/节结构行，content 已剥离这些行） */
export interface Chunk extends SectionStructure { name: string; }

/** 超大块（听力原文等）按题号行边界二次切分，避免单次输出超限被截断；结构行只随首段 */
export function splitOversizedChunk(sec: Chunk, maxWords = 1500): Chunk[] {
  const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
  if (countWords(sec.content) <= maxWords) return [sec];
  const lines = sec.content.split('\n');
  const parts: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  for (const line of lines) {
    const w = countWords(line);
    if (currentWords > 0 && currentWords + w > maxWords && /^\s*\d{1,2}\s*[.．]/.test(line)) {
      parts.push(current.join('\n'));
      current = [];
      currentWords = 0;
    }
    current.push(line);
    currentWords += w;
  }
  if (current.length) parts.push(current.join('\n'));
  return parts.map((content, i) => (i === 0
    ? { ...sec, content }
    : { name: sec.name, subHeaders: [], content }));
}

/** 从粘贴原文头部用正则提取试卷头信息（不走 LLM） */
export function extractExamMeta(text: string, stage: Stage = 'senior'): ExamPaperMeta {
  const head = text.slice(0, 800);
  const lines = head.split('\n').map((l) => l.trim()).filter(Boolean);
  const skip = /班级|姓名|考号|准考证|注意|满分|考试时间|分钟|命题|审题|制卷/;
  const watermark = /公众号|微信|扫码|关注|获取|整理|QQ/;
  // 卷头横幅：首个部分/节/题号行之前的短横幅行（校名 + 场次名，如「山西大学附中」
  // 「2026-2027学年第一学期高三8月模块诊断」）——取前两条合成标题，不再只认「试卷/试题」字样
  const bodyStart = lines.findIndex((l) => /^(第[一二三四五六七八九十\d]+部分|[一二三四五六七八九十]+、|\d{1,2}\s*[.．])/.test(l));
  const headLines = bodyStart > 0 ? lines.slice(0, bodyStart) : [];
  const banners = headLines.filter((l) => !skip.test(l) && !watermark.test(l) && l.length >= 4 && l.length <= 40);
  let title = banners.length > 0 ? banners.slice(0, 2).join('　　') : '';
  if (!title) {
    for (const line of lines) {
      if (/试卷|试题|考试/.test(line) && !skip.test(line) && line.length <= 40) { title = line; break; }
    }
  }
  if (!title) {
    for (const line of lines) {
      if (!skip.test(line) && !watermark.test(line) && line.length >= 4 && line.length <= 40) { title = line; break; }
    }
  }
  // 分值/时长只在卷头横幅区找（bodyStart 之前）：正文节行「第一节完形填空（…满分15分）」
  // 会把单节分值误当全卷满分（北京卷实测）。无部分行结构的卷子退回整个 head。
  const metaHead = bodyStart > 0 ? lines.slice(0, bodyStart).join('\n') : head;
  const score = metaHead.match(/(?:满分|分值)[：:]?\s*(\d+)\s*分?/);
  const duration = metaHead.match(/(\d{2,3})\s*分钟/);
  const GAP = '　　'; // 两个全角空格（转义写法避免 eslint no-irregular-whitespace）
  // 原卷自带的考查信息行整行优先（「考查时间：120分钟满分：150分考查内容：综合」——
  // 合成句会丢掉「考查内容」等字段）；否则卷首完整说明句，最后由分数/时长合成。
  // 「试卷分值100」等变体也算（北京卷卷头写法）
  const rawInfo = lines.find((l) => /满分|分值/.test(l) && /分钟|时间/.test(l) && l.length <= 60 && !watermark.test(l));
  const intro = matchIntroLine(text);
  // 各地中考满分不一（120/150/100 分均有），兜底值初中取常见的 120 分
  const fallback = stage === 'junior' ? '满分：120分' : '满分：150分';
  const subTitle = rawInfo ?? intro ?? (score && duration
    ? `满分：${score[1]}分${GAP}考试时间：${duration[1]}分钟`
    : `${fallback}${GAP}考试时间：120分钟`);
  // 注意事项块：「注意：…」行后跟的编号行（1. … 2. …）一并收进来
  const notices: string[] = [];
  for (const l of lines) {
    if (/^注意/.test(l) || (notices.length > 0 && /^[（(]?\d{1,2}\s*[.．、）)]/.test(l))) {
      notices.push(l);
    } else if (notices.length > 0) {
      break; // 注意块结束
    }
  }
  return { title: title || '英语试卷', subTitle, notices };
}

/** 解析成功的块组装成卷 */
export function assemblePaper(chunks: (Chunk & { data: ExamSectionParseResult; ci: number })[], inputText: string, stage: Stage = 'senior'): ExamPaper {
  const sections = mergeReadingSections(chunks.map((c) => ({
    id: crypto.randomUUID(),
    title: c.name,
    chunkIndex: c.ci, // 单块重试后按原切块序插回原位
    ...(c.volume ? { volumeDivider: c.volume } : {}),
    ...(c.partTitle ? { partTitle: c.partTitle } : {}),
    ...(c.subHeaders.length > 0 ? { subHeaders: c.subHeaders } : {}),
    instruction: (c.data.instruction || '').trim() || undefined,
    // essay 题干逐字复述大题说明的幻影题（读后续写被劈块形态）在此过滤，
    // 否则说明渲染两遍 + 凭空多一组答题线
    questions: dropInstructionEcho(sanitizeQuestions(c.data.questions), (c.data.instruction || '').trim()),
  })));
  return { meta: extractExamMeta(inputText, stage), sections };
}
