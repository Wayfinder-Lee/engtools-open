/**
 * 试卷分节解析器
 *
 * 将高考/中考英语试卷文本拆分为独立的 section（阅读理解 A/B/C/D、七选五、
 * 完形填空、语法填空、听力理解、应用文写作、读后续写等；中考卷另有
 * 单项选择、任务型阅读、短文填空、词汇运用、书面表达等题型）。
 * 纯客户端 regex 实现，零 API 调用。
 */

import type { Stage } from '../types';

export interface Section {
  /** 如 "阅读理解C"、"七选五"、"完形填空" */
  name: string;
  /** 该 section 的完整文本 */
  content: string;
}

/**
 * 标准化文本：统一换行、去除首尾空白
 */
function normalize(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── 标记匹配工具 ──────────────────────────────────

interface Marker {
  index: number;
  length: number;
  name: string;
}

/** 在文本中查找所有匹配 pattern 的位置 */
function findAllMarkers(content: string, pattern: RegExp, getName: (m: RegExpMatchArray) => string): Marker[] {
  const markers: Marker[] = [];
  const globalPattern = new RegExp(pattern.source, 'gm');
  for (const m of content.matchAll(globalPattern)) {
    markers.push({ index: m.index!, length: m[0].length, name: getName(m) });
  }
  return markers;
}

/** 已知的中文 section 标题 → 规范化名称映射（高中卷式） */
const CN_SECTION_MAP: { pattern: RegExp; name: string }[] = [
  // Listening
  { pattern: /听力[理解]*/, name: '听力理解' },
  // Reading comprehension — match section headers like "第二部分 阅读理解"
  // Standalone A/B/C/D markers are handled by passage-level subdivision, so here
  // we only need a generic "阅读理解" pattern to mark the section boundary.
  // IMPORTANT: use [ \t]* (horizontal whitespace only), NOT \s* (which matches \n).
  // Otherwise "阅读理解\nA" would match "阅读理解A" and prevent subdivision.
  { pattern: /阅读[理解]*[ \t]*A\b/, name: '阅读理解A' },
  { pattern: /阅读[理解]*[ \t]*B\b/, name: '阅读理解B' },
  { pattern: /阅读[理解]*[ \t]*C\b/, name: '阅读理解C' },
  { pattern: /阅读[理解]*[ \t]*D\b/, name: '阅读理解D' },
  // Generic fallback for papers that use "二、阅读理解" style headers
  // where A/B/C/D appear as standalone lines later
  { pattern: /阅读理解/, name: '阅读理解' },
  { pattern: /七选五|七个选项|多余选项|补全[短篇]文/, name: '七选五' },
  // Language section (完形填空 + 语法填空) — explicitly listed for Strategy 2
  { pattern: /语言运用|语言知识|英语知识运用/, name: '语言运用' },
  // Cloze
  { pattern: /完形填空/, name: '完形填空' },
  // Grammar fill
  { pattern: /语法填空|短文填空|语篇填空/, name: '语法填空' },
  { pattern: /单句语法填空|单句填空|单句语填/, name: '单句语填' },
  // Writing
  { pattern: /应用文[写作]*|书面表达|你是李华|写作[^\S\n]*第一节/, name: '应用文写作' },
  { pattern: /读后续写|续写/, name: '读后续写' },
];

/** 中考卷式题型映射：单项选择/任务型阅读/短文填空/选词填空/词汇运用/完成句子/情景交际/书面表达等 */
const CN_SECTION_MAP_JUNIOR: { pattern: RegExp; name: string }[] = [
  { pattern: /听力[理解]*/, name: '听力理解' },
  { pattern: /情景交际|补全对话|对话配对/, name: '情景交际' },
  { pattern: /单项选择|单项填空|语法选择|基础知识/, name: '单项选择' },
  { pattern: /完形填空/, name: '完形填空' },
  { pattern: /阅读[理解]*[ \t]*A\b/, name: '阅读理解A' },
  { pattern: /阅读[理解]*[ \t]*B\b/, name: '阅读理解B' },
  { pattern: /阅读[理解]*[ \t]*C\b/, name: '阅读理解C' },
  { pattern: /阅读[理解]*[ \t]*D\b/, name: '阅读理解D' },
  { pattern: /任务型阅读|阅读表达|回答问题/, name: '任务型阅读' },
  { pattern: /阅读理解/, name: '阅读理解' },
  // 各地中考对语篇型填空的叫法不一，保留原题型名（不归并为「语法填空」）
  { pattern: /语法填空|语篇填空/, name: '语法填空' },
  { pattern: /短文填空/, name: '短文填空' },
  { pattern: /选词填空/, name: '选词填空' },
  { pattern: /综合填空/, name: '综合填空' },
  { pattern: /单词拼写|词汇运用/, name: '词汇运用' },
  { pattern: /完成句子/, name: '完成句子' },
  // 中考写作题通称「书面表达」
  { pattern: /书面表达|应用文[写作]*|英语写作|你是李华/, name: '书面表达' },
];

/** 按学段取题型映射表 */
function getSectionMap(stage: Stage): { pattern: RegExp; name: string }[] {
  return stage === 'junior' ? CN_SECTION_MAP_JUNIOR : CN_SECTION_MAP;
}

/** 任意大题名归一为当前学段的规范题型名（LLM 大纲输出的名称与清单对齐用）；
 *  阅读理解X 精确保留字母；识别不出映射时原样返回（自定义题型合法）。 */
export function canonicalSectionName(raw: string, stage: Stage): string {
  const s = raw.replace(/\s+/g, '');
  const rd = s.match(/^阅读理解([A-D])$/);
  if (rd) return `阅读理解${rd[1]}`;
  return matchCnSection(s, getSectionMap(stage)) || raw.trim();
}

/** 尝试匹配中文 section 标题，返回规范化名称 */
function matchCnSection(header: string, map: { pattern: RegExp; name: string }[]): string | null {
  for (const { pattern, name } of map) {
    if (pattern.test(header)) return name;
  }
  return null;
}

/** 判断文本是否包含某类内容关键词 */
function containsKeyword(text: string, keywords: string[]): boolean {
  const lower = text.slice(0, 300).toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Content-based detection: does the body look like a 语言运用 section
 * (完形填空 or 语法填空) rather than a 阅读理解 section?
 *
 * Detects structural patterns unique to cloze/grammar:
 *   - Numbered blanks with ABCD options (e.g. "41．A．looking")
 *   - Numbered blanks with word prompts in brackets (e.g. "56. ______ (conduct)")
 *   - Contains explicit "完形填空" or "语法填空" keywords
 */
function looksLikeLanguageSection(content: string): boolean {
  const head = content.slice(0, 600);
  // Cloze pattern: numbered items (41-55) with A/B/C/D options
  // Matches formats like: 41．A．...  or  41. A. ...  or  41．A) ...
  if (/\d{1,2}[．.．]\s*[ABCD][．.．)]/.test(head)) return true;
  // Grammar fill pattern: numbered blanks with word in parentheses
  // Matches: 56. ______ (conduct)  or  56．________(give)
  if (/\d{1,2}[．.．]\s*_{2,}[^(]*\([a-zA-Z]+\)/.test(head)) return true;
  // Explicit keywords
  if (containsKeyword(head, ['完形填空', '语法填空', '短文填空', '语篇填空'])) return true;
  return false;
}

/**
 * 将 markers 按 index 排序后，提取每对相邻 marker 之间的文本作为 section
 */
function extractSectionsFromMarkers(content: string, markers: Marker[], minLength = 50): Section[] {
  if (markers.length === 0) return [];

  const sorted = [...markers].sort((a, b) => a.index - b.index);
  const sections: Section[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].index + sorted[i].length;
    const end = i + 1 < sorted.length ? sorted[i + 1].index : content.length;
    const body = content.slice(start, end).trim();
    if (body.length >= minLength) {
      sections.push({ name: sorted[i].name, content: body });
    }
  }

  return sections;
}

// ─── 策略 1：按"第X部分"格式拆分 ──────────────────

const PART_HEADER = /第[一二三四五六七八]\s*部分[^\n]*\n?/;

/** 识别 "第X部分" 的类型关键字 */
function identifyPartType(header: string): string | null {
  const h = header.toLowerCase();
  if (containsKeyword(h, ['听力', 'listening'])) return 'listening';
  // IMPORTANT: check language BEFORE reading.
  // "语言运用" section bodies often start with "阅读下面短文" (cloze instructions),
  // which would falsely match the "阅读" keyword if reading is checked first.
  if (containsKeyword(h, ['语言运用', '语言知识', '知识运用', '英语知识', '英语运用', 'language'])) return 'language';
  if (containsKeyword(h, ['阅读理解', '阅读', 'reading'])) return 'reading';
  if (containsKeyword(h, ['写作', '书面表达', 'writing'])) return 'writing';
  return null;
}

function strategy1Parts(normalized: string, map: { pattern: RegExp; name: string }[], stage: Stage): Section[] | null {
  const partMarkers = findAllMarkers(normalized, PART_HEADER, (m) => m[0].trim());
  if (partMarkers.length === 0) return null;

  const parts = extractSectionsFromMarkers(normalized, partMarkers, 30);
  if (parts.length === 0) return null;

  const sections: Section[] = [];
  for (const part of parts) {
    // Sample the HEADER line (back to prev 100 chars) plus a small peek into body (80 chars).
    // We deliberately limit the body peek to avoid pulling in cloze instructions like
    // "阅读下面短文" that would confuse identifyPartType.
    // Header line first: 第X部分 行自身的题型词最可靠；peek 只在标题无题型词时兜底
    // （否则「写作」部的第一节题干较短时，peek 会扫到第二节的「阅读下面材料」而误判为阅读）。
    const headerStart = Math.max(0, normalized.indexOf(part.name) - 100);
    const headerEnd = normalized.indexOf(part.name) + part.name.length + 80;
    const typeStr = normalized.slice(headerStart, headerEnd);
    let type = identifyPartType(part.name) ?? identifyPartType(typeStr);

    // Content-based correction: if header-based classification says "reading" but the
    // body starts with cloze/grammar-fill patterns, reclassify as language.
    if (type === 'reading' && looksLikeLanguageSection(part.content)) {
      type = 'language';
    }

    // 题型独立成部的卷式（中考常见：第X部分 短文填空/任务型阅读/情景交际 等自带题型名）：
    // 部标题本身就是具体题型名时直接以此命名输出，不再套用 阅读理解/语言运用 的泛化拆分。
    // 「XX知识运用」类部标题是多个题型的集合，不算具体题型，照常走子拆分。
    if (type === null || type === 'reading') {
      const partName = sectionNameFromHeader(part.name, map, '');
      if (partName && !/[知识语言英语]{2}运用|基础知识/.test(part.name)) {
        sections.push({ name: partName, content: part.content.trim() });
        continue;
      }
    }

    switch (type) {
      case 'listening':
        sections.push({ name: '听力理解', content: part.content });
        break;
      case 'reading':
        sections.push(...subdivideReading(part.content, map, stage));
        break;
      case 'language':
        sections.push(...subdivideLanguage(part.content, map, stage));
        break;
      case 'writing':
        sections.push(...subdivideWriting(part.content, stage));
        break;
      default:
        // 尝试直接用关键词判断
        if (part.content.trim().length > 50) {
          const name = matchCnSection(part.content.slice(0, 300), map);
          sections.push({ name: name || '试卷', content: part.content.trim() });
        }
    }
  }

  return sections.length > 0 ? sections : null;
}

// ─── 子拆分函数 ────────────────────────────────────

/** 泛称题型名（从「第X节」标题行推断题型时应排除，避免把泛称误当具体题型） */
const GENERIC_SECTION_NAMES = new Set(['阅读理解', '语言运用', '听力理解', '试卷']);

/**
 * 从「第X节」标题行推断具体题型名：标题行本身命中题型关键词时采用其规范化名
 * （如「第二节 任务型阅读」→ 任务型阅读），否则回退到 fallback（按学段给默认）。
 */
function sectionNameFromHeader(headerLine: string, map: { pattern: RegExp; name: string }[], fallback: string): string {
  const m = matchCnSection(headerLine, map);
  return m && !GENERIC_SECTION_NAMES.has(m) ? m : fallback;
}

/** 取文本中第一个非空行（节匹配串以 \n 开头，直接 split[0] 会拿到空串） */
function firstNonEmptyLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/** 在阅读部分内拆分 A/B/C/D 各篇 + 第二节（高中七选五 / 初中任务型阅读等） */
function subdivideReading(body: string, map: { pattern: RegExp; name: string }[], stage: Stage): Section[] {
  const sections: Section[] = [];

  // Guardrail: if the body content looks like a cloze/grammar section
  // (numbered blanks 41-55 with ABCD options), don't treat it as reading.
  // This catches cases where identifyPartType misclassified a language section.
  if (looksLikeLanguageSection(body)) {
    return subdivideLanguage(body, map, stage);
  }

  // 先处理第二节 — 高中通常是七选五，初中通常是任务型阅读，以标题行实际题型名为准
  const sec2Match = body.match(/(?:^|\n)\s*第二节[\s\S]*/);
  const sec1Body = sec2Match
    ? body.slice(0, sec2Match.index!).trim()
    : body;

  // 在第一节（或全文）中按 A/B/C/D 独立行标记拆分
  const passageMarkers = findAllMarkers(
    sec1Body,
    /(?:^|\n)\s*([ABCD])\s*(?:\n|$)/,
    (m) => `阅读理解${m[1]}`,
  );

  if (passageMarkers.length >= 2) {
    const passages = extractSectionsFromMarkers(sec1Body, passageMarkers, 50);
    sections.push(...passages);
  } else if (sec1Body.trim().length > 50) {
    // 回退：看是否能匹配到 阅读理解A/B/C/D 中文标签
    const cnLabel = matchCnSection(sec1Body.slice(0, 300), map);
    sections.push({ name: cnLabel || '阅读理解', content: sec1Body.trim() });
  }

  // 处理第二节：先看标题行写的是什么题型（任务型阅读/七选五/…），识别不出再按学段回退
  if (sec2Match) {
    const headerLine = firstNonEmptyLine(sec2Match[0]);
    const sec2Body = sec2Match[0].replace(/^\s*第二节[^\n]*\n?/, '').trim();
    if (sec2Body.length > 50) {
      const name = sectionNameFromHeader(headerLine, map, stage === 'junior' ? '任务型阅读' : '七选五');
      sections.push({ name, content: sec2Body });
    }
  }

  return sections;
}

/** 在语言运用部分内拆分完形填空/单项选择 + 语法填空/短文填空等 */
function subdivideLanguage(body: string, map: { pattern: RegExp; name: string }[], stage: Stage): Section[] {
  const sections: Section[] = [];

  // Try explicit "第一节"/"第二节" boundaries first
  const sec1Match = body.match(/(?:^|\n)\s*第一节[\s\S]*?(?=(?:^|\n)\s*第二节|$)/);
  const sec2Match = body.match(/(?:^|\n)\s*第二节[\s\S]*/);

  if (sec1Match) {
    const headerLine = firstNonEmptyLine(sec1Match[0]);
    const clean = sec1Match[0].replace(/^\s*第一节[^\n]*\n?/, '').trim();
    if (clean.length > 30) {
      // 标题行写明题型（如初中「第一节 单项选择」）时用实际名称，否则默认完形填空
      const name = sectionNameFromHeader(headerLine, map, '完形填空');
      sections.push({ name, content: clean });
    }
  }
  if (sec2Match) {
    const headerLine = firstNonEmptyLine(sec2Match[0]);
    const clean = sec2Match[0].replace(/^\s*第二节[^\n]*\n?/, '').trim();
    if (clean.length > 30) {
      // 标题行优先：写明 短文填空/选词填空/综合填空/语法填空 等就直接用（初中各地叫法不一，保留原名）
      const headerName = sectionNameFromHeader(headerLine, map, '');
      if (headerName) {
        sections.push({ name: headerName, content: clean });
      } else if (stage === 'junior' && containsKeyword(clean, ['短文填空'])) {
        sections.push({ name: '短文填空', content: clean });
      } else if (stage === 'junior' && containsKeyword(clean, ['选词填空'])) {
        sections.push({ name: '选词填空', content: clean });
      } else if (stage === 'junior' && containsKeyword(clean, ['综合填空'])) {
        sections.push({ name: '综合填空', content: clean });
      } else {
        // Content-based disambiguation: 第二节 could be 语法填空 or 七选五
        // 语法填空: numbered blanks with word prompts like "56. ____(conduct)"
        // 七选五: has options A-G listed at the end with "多余选项" marker（初中无七选五）
        const looksLikeGrammar = (
          /\d{1,2}[．.．]\s*_{2,}[^(]*\([a-zA-Z]+\)/.test(clean.slice(0, 500)) ||
          containsKeyword(clean, ['语法填空', '短文填空', '语篇填空', '空白处', '括号内单词'])
        );
        const looksLike7of5 = (
          containsKeyword(clean, ['七选五', '七个选项', '多余选项', '补全短文']) ||
          /[A-G][.．]\s/.test(clean.slice(-300))  // options at end
        );

        if (stage === 'senior' && looksLike7of5 && !looksLikeGrammar) {
          sections.push({ name: '七选五', content: clean });
        } else {
          // Default: in 语言运用 section, 第二节 is 语法填空
          sections.push({ name: '语法填空', content: clean });
        }
      }
    }
  }

  // fallback: no explicit 第一节/第二节 — try content-based detection
  if (sections.length === 0 && body.trim().length > 50) {
    if (looksLikeLanguageSection(body)) {
      // Further classify: is it cloze or grammar fill?
      const head = body.slice(0, 500);
      if (/\d{1,2}[．.．]\s*[ABCD][．.．)]/.test(head)) {
        sections.push({ name: '完形填空', content: body.trim() });
      } else if (/\d{1,2}[．.．]\s*_{2,}[^(]*\([a-zA-Z]+\)/.test(head)) {
        sections.push({ name: '语法填空', content: body.trim() });
      } else if (containsKeyword(body, ['完形', 'cloze'])) {
        sections.push({ name: '完形填空', content: body.trim() });
      } else if (containsKeyword(body, ['语法填空', 'grammar', '填空'])) {
        sections.push({ name: '语法填空', content: body.trim() });
      } else {
        sections.push({ name: '语言运用', content: body.trim() });
      }
    } else if (containsKeyword(body, ['完形', 'cloze'])) {
      sections.push({ name: '完形填空', content: body.trim() });
    } else if (containsKeyword(body, ['语法填空', 'grammar', '填空'])) {
      sections.push({ name: '语法填空', content: body.trim() });
    } else {
      sections.push({ name: '语言运用', content: body.trim() });
    }
  }

  return sections;
}

/** 在写作部分内拆分应用文 + 读后续写（初中统称「书面表达」，无读后续写） */
function subdivideWriting(body: string, stage: Stage): Section[] {
  const sections: Section[] = [];
  const writingName = stage === 'junior' ? '书面表达' : '应用文写作';
  const sec1Match = body.match(/(?:^|\n)\s*第一节[\s\S]*?(?=(?:^|\n)\s*第二节|$)/);
  const sec2Match = body.match(/(?:^|\n)\s*第二节[\s\S]*/);

  if (sec1Match) {
    const clean = sec1Match[0].replace(/^\s*第一节[^\n]*\n?/, '').trim();
    if (clean.length > 20) sections.push({ name: writingName, content: clean });
  }
  if (sec2Match) {
    const clean = sec2Match[0].replace(/^\s*第二节[^\n]*\n?/, '').trim();
    if (clean.length > 50) sections.push({ name: stage === 'junior' ? writingName : '读后续写', content: clean });
  }

  if (sections.length === 0 && body.trim().length > 50) {
    if (stage !== 'junior' && containsKeyword(body, ['续写', 'paragraph', '段落开头', '首句'])) {
      sections.push({ name: '读后续写', content: body.trim() });
    } else {
      sections.push({ name: writingName, content: body.trim() });
    }
  }

  return sections;
}

// ─── 策略 2：按中文 section 标题拆分（无"第X部分"的试卷）───

/** 查找所有已知中文 section 标题的行 */
function findCnSectionMarkers(content: string, map: { pattern: RegExp; name: string }[]): Marker[] {
  const markers: Marker[] = [];
  for (const { pattern, name } of map) {
    for (const m of content.matchAll(new RegExp(pattern.source, 'gim'))) {
      markers.push({ index: m.index!, length: m[0].length, name });
    }
  }
  // 去重：如果有 阅读理解 和 阅读理解A 在同一位置，保留更具体的（阅读理解A）
  // 按 index 排序，合并相邻的同 index 标记
  markers.sort((a, b) => a.index - b.index);
  const deduped: Marker[] = [];
  for (const m of markers) {
    const prev = deduped[deduped.length - 1];
    // 如果和上一个位置很近（<20 chars），且名称更具体，替换
    if (prev && m.index - prev.index < 30 && m.name.length > prev.name.length) {
      deduped[deduped.length - 1] = m;
    } else if (!prev || m.index - prev.index >= 30) {
      deduped.push(m);
    }
  }
  return deduped;
}

function strategy2CnHeaders(normalized: string, map: { pattern: RegExp; name: string }[], stage: Stage): Section[] | null {
  const markers = findCnSectionMarkers(normalized, map);
  if (markers.length < 2) return null; // 至少2个才有拆分的意义

  const sections = extractSectionsFromMarkers(normalized, markers, 50);
  if (sections.length < 2) return null;

  // 后处理：合并同一 section name 的重复块（某些试卷会在标题中重复出现关键词）
  const merged: Section[] = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.name === s.name) {
      // 同名字合并内容
      merged[merged.length - 1] = { name: prev.name, content: prev.content + '\n\n' + s.content };
    } else {
      merged.push(s);
    }
  }

  // Subdivide generic sections that need further splitting
  const subdivided: Section[] = [];
  for (const s of merged) {
    if (s.name === '语言运用') {
      // Further split into 完形填空 + 语法填空
      subdivided.push(...subdivideLanguage(s.content, map, stage));
    } else if (s.name === '阅读理解' || s.name.startsWith('阅读理解') && !/[A-D]$/.test(s.name)) {
      // Generic reading section → split into A/B/C/D + 七选五/任务型阅读
      subdivided.push(...subdivideReading(s.content, map, stage));
    } else {
      subdivided.push(s);
    }
  }

  return subdivided.length >= 2 ? subdivided : null;
}

// ─── 策略 3：纯英文/混合格式 — 按独立行 A/B/C/D + section 标题拆分 ──

function strategy3StandaloneLetters(normalized: string, stage: Stage): Section[] | null {
  // 找所有可能的 section 边界
  const boundaries: Marker[] = [];

  // 独立行上的 A/B/C/D（阅读篇章）
  for (const m of normalized.matchAll(/(?:^|\n)\s*([ABCD])\s*\n/g)) {
    boundaries.push({ index: m.index!, length: m[0].length, name: `阅读理解${m[1]}` });
  }

  // 第二节 英文格式（高中为七选五，初中最接近的是任务型阅读）
  for (const m of normalized.matchAll(/(?:^|\n)\s*Section\s*(?:II|2|Two)[^\n]*/gi)) {
    boundaries.push({ index: m.index!, length: m[0].length, name: stage === 'junior' ? '任务型阅读' : '七选五' });
  }

  if (boundaries.length < 2) return null;

  const sections = extractSectionsFromMarkers(normalized, boundaries, 50);
  return sections.length >= 2 ? sections : null;
}

// ─── 主解析函数 ────────────────────────────────────

/**
 * 将高考/中考英语试卷文本解析为独立的 section 数组。
 *
 * 三级策略（依次尝试，第一个返回 >=2 section 的结果生效）：
 *   Strategy 1 — 按"第X部分"拆分（最标准的中文试卷格式）
 *   Strategy 2 — 按中文 section 标题拆分（无"第X部分"但有中文标题）
 *   Strategy 3 — 按独立行 A/B/C/D 标记拆分（英文格式试卷）
 *   Fallback  — 整篇当作一个 section
 *
 * stage='junior' 时使用中考题型映射（单项选择/任务型阅读/短文填空/词汇运用/
 * 情景交际/书面表达等），写作题统称「书面表达」，不出读后续写。
 */
export function parseSections(text: string, stage: Stage = 'senior'): Section[] {
  const normalized = normalize(text);
  const map = getSectionMap(stage);

  // 策略 1：按"第X部分"
  const s1 = strategy1Parts(normalized, map, stage);
  if (s1 && s1.length >= 2) return s1;
  // 即使只有1个也保留（可能内部已经被 subdivide 拆过了）
  if (s1 && s1.length === 1 && s1[0].name !== '试卷') return s1;

  // 策略 2：中文 section 标题
  const s2 = strategy2CnHeaders(normalized, map, stage);
  if (s2 && s2.length >= 2) return s2;

  // 策略 3：独立行 A/B/C/D
  const s3 = strategy3StandaloneLetters(normalized, stage);
  if (s3 && s3.length >= 2) return s3;

  // Fallback：整篇
  return [{ name: '试卷', content: normalized }];
}
