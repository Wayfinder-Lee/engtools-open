/**
 * 试卷结构行（卷别 / 部分标题 / 节标题）捕获。
 *
 * 背景：sectionParser 的第X部分锚点和 subdivide* 的节行剥离会让这些结构行
 * 从大题 content 中系统性丢失（或残留在听力 content 里被 LLM 并入说明句）。
 * 这里在切分后的块上做独立补偿：按原文行扫描结构行，按「行序归属到下一个块」
 * 的规则挂回各块，并从 content 中剥离已捕获的行（LLM 不再见到，杜绝并句）。
 */

export type StructuralType = 'volume' | 'part' | 'sub';

export interface StructuralLine {
  /** 行首在全文中的偏移 */
  at: number;
  type: StructuralType;
  /** 整行文本（trim 后） */
  line: string;
}

/** 卷别行：「第Ⅰ卷」「第 Ⅱ 卷」「第Ⅱ卷（非选择题）」 */
const VOLUME_RE = /^\s*第\s*[ⅠⅡⅢⅰⅱ一二三1-9１-９]{1,3}\s*卷\s*(?:[（(][^（）()]{0,12}[）)])?\s*$/;
/** 卷别行前缀（整行匹配失败时拆「第Ⅱ卷（非选择题）第三部分 语言运用…」这类粘连行） */
const VOLUME_PREFIX_RE = /^第\s*[ⅠⅡⅢⅰⅱ一二三1-9１-９]{1,3}\s*卷\s*(?:[（(][^（）()]{0,12}[）)])?/;
/** 部分行：「第一部分：听力理解（共两节，满分30分）」；必须带后续标题文字 */
const PART_RE = /^\s*第\s*[一二三四五六七八九十]{1,3}\s*部分\s*[：:]?\s*(\S.{0,119})$/;
/** 节行：「第一节 (共5小题；每小题1.5分，满分7.5分)」「第二节 阅读下面短文，…」（可无后续文字） */
const SUB_RE = /^\s*第\s*[一二三四五六七八九十]{1,3}\s*节\s*[：:]?\s*(.{0,159})$/;

/** 全文行扫描：返回所有结构行（含偏移，按出现顺序）。
 *  PDF 提取常残留的 \r 视为换行；「卷+部分」粘连行拆成卷、部分两条。 */
export function scanStructuralLines(text: string): StructuralLine[] {
  const hits: StructuralLine[] = [];
  let at = 0;
  for (const raw of text.split('\n')) {
    let segAt = at;
    for (const seg of raw.split('\r')) {
      const line = seg.trim();
      if (line) {
        let type: StructuralType | null = null;
        if (VOLUME_RE.test(line)) type = 'volume';
        else if (PART_RE.test(line)) type = 'part';
        else if (SUB_RE.test(line)) type = 'sub';
        if (type) {
          hits.push({ at: segAt, type, line });
        } else {
          // 粘连行：「第Ⅱ卷（非选择题）第三部分 语言知识运用（…）」→ 卷别行 + 部分行
          const vm = line.match(VOLUME_PREFIX_RE);
          if (vm) {
            const rest = line.slice(vm[0].length).trim();
            if (PART_RE.test(rest)) {
              hits.push({ at: segAt, type: 'volume', line: vm[0].trim() });
              hits.push({ at: segAt, type: 'part', line: rest });
            }
          }
        }
      }
      segAt += seg.length + 1;
    }
    at += raw.length + 1;
  }
  return hits;
}

/** 卷首说明行：「本试卷分为第Ⅰ卷（选择题）和第Ⅱ卷（非选择题）两部分。满分…考试时间…」 */
export function matchIntroLine(text: string): string | undefined {
  const m = text.slice(0, 1200).match(/^本试卷[^。\n]{0,80}两部分[^\n]{0,120}/m);
  return m ? m[0].trim() : undefined;
}

export interface SectionStructure {
  /** 大题名（段中节行切块产生的续段继承原名，导出时同名连续节只渲染一次大题标题） */
  name: string;
  /** 卷别分隔行（如「第Ⅰ卷」）；多卷试卷各节各自持有 */
  volume?: string;
  /** 部分完整标题（如「第一部分：听力理解（共两节，满分30分）」 */
  partTitle?: string;
  /** 节标题行（含分值/作答说明），按出现顺序 */
  subHeaders: string[];
  /** 已剥离结构行的 content（送 LLM） */
  content: string;
}

/**
 * 结构行按行序归属。每块三段区间：
 *   前隙 [prevEnd, start)  —— 本块被 parser 消费的卷/部分/首节锚点行 → 归本块头部字段；
 *   正文 [start, end]      —— 块 content 实际行 → 段中节行（听力的第一节/第二节）在此处
 *                             把 content 切成多段，每段自带节标题行，保证节标题在题目流原位置渲染；
 *   尾隙 (end, nextStart)  —— 下一块的锚点行（部分标题、第一节说明等）→ 归下一块头部字段。
 * 段中含节行的块会输出多于输入的段（续段只带 subHeaders）。
 * 页眉重复的同类行：序号按「当前卷」申领（第Ⅱ卷内重启部分编号的旧版试卷不误伤），
 * 首个申领保留；后出现但更完整的变体替换短版（页眉短标题先于正文完整标题时），
 * 重复行无论申领与否都从 content 剥离；定位失败的块原样透传（不挂结构行、不切块）。
 */
export function enrichSections(
  text: string,
  sections: { name: string; content: string }[],
): SectionStructure[] {
  if (sections.length === 0) return [];
  // PDF 提取残留的 \r 会把结构行和正文粘成一行：与 sectionParser.normalize 同步归一后再扫描/定位
  const norm = text.replace(/\r\n?/g, '\n');
  const lines = norm.split('\n');
  const trimmed = lines.map((l) => l.trim());

  /** 在 [from, to] 行区间内按（精确 → 前缀 → 包含）匹配针 */
  const findLine = (needleRaw: string, from: number, to: number, forward: boolean): number => {
    const needle = needleRaw.slice(0, 30);
    if (!needle) return -1;
    const exact = (i: number) => trimmed[i] === needle || (needle.length >= 30 && trimmed[i].startsWith(needle));
    const loose = (i: number) => {
      const head = needleRaw.slice(0, 12);
      return head.length >= 6 && trimmed[i].includes(head);
    };
    const range = (pred: (i: number) => boolean): number => {
      if (forward) { for (let i = from; i <= to; i++) if (pred(i)) return i; }
      else { for (let i = to; i >= from; i--) if (pred(i)) return i; }
      return -1;
    };
    return range(exact) >= 0 ? range(exact) : range(loose);
  };

  // 各块首/末行定位：针取块 content 首/末个非空行，按块序渐进推进；
  // 定位失败的块标 -1，不参与结构归属（内容原样透传，避免把结构行挂错块）
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  for (const sec of sections) {
    const secLines = sec.content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const upper = lines.length - 1;
    let s = secLines.length > 0 ? findLine(secLines[0], cursor, upper, true) : -1;
    let e = s >= 0 && secLines.length > 0 ? findLine(secLines[secLines.length - 1], s, upper, false) : -1;
    if (s < 0 || e < s) { s = -1; e = -1; }
    starts.push(s); ends.push(e);
    if (s >= 0) cursor = s;
  }
  const locatable = sections.map((_, i) => i).filter((i) => starts[i] >= 0);
  // 定位失败块的推断区间：夹在前后可定位块之间的行段（结构行可挂回该块头部，不从 content 剥离）
  const lo: number[] = [];
  const hi: number[] = [];
  {
    let prevEnd = -1;
    for (let i = 0; i < sections.length; i++) {
      if (starts[i] >= 0) { lo.push(starts[i]); hi.push(ends[i]); prevEnd = ends[i]; continue; }
      let next = lines.length - 1;
      for (let j = i + 1; j < sections.length; j++) if (starts[j] >= 0) { next = starts[j] - 1; break; }
      lo.push(prevEnd + 1); hi.push(Math.max(prevEnd, next));
    }
  }

  const hits = scanStructuralLines(norm);
  /** 各块头部字段（卷/部分/前隙节行） */
  const head: { volume?: string; partTitle?: string; subHeaders: string[] }[] =
    sections.map(() => ({ subHeaders: [] }));
  /** 段中节行（content 内的）：从流式 content 剥离，并作为切块点 */
  const cutSubs: Set<string>[] = sections.map(() => new Set<string>());
  const stripMap: Set<string>[] = sections.map(() => new Set<string>());
  const better = (a: string | undefined, b: string) => (a === undefined || b.length > a.length ? b : a);

  // 行偏移表（scanStructuralLines 的 at 是行首偏移）→ 行号二分
  const offsets: number[] = [];
  { let acc = 0; for (const l of lines) { offsets.push(acc); acc += l.length + 1; } }
  const lineOf = (offset: number): number => {
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  // 部分/卷序号按当前卷申领：key = 卷序|类型:序号，重复的页眉行不重复申领
  const claimed = new Map<string, { idx: number; line: string; type: StructuralType }>();
  let curVolume = '';
  const ordinal = (t: StructuralType, line: string): string | null => {
    const m = line.match(t === 'volume' ? /^第\s*([ⅠⅡⅢⅰⅱ一二三1-9１-９]{1,3})\s*卷/ : /^第\s*([一二三四五六七八九十]{1,3})\s*部分/);
    return m ? `${t}:${m[1]}` : null;
  };

  for (const hit of hits) {
    const ln = lineOf(hit.at);
    if (hit.type === 'volume') {
      const vo = ordinal('volume', hit.line);
      if (vo) curVolume = vo;
    }

    // 归属：先看落在哪个块的区间（可定位块 [start,end] / 定位失败块的推断区间）；否则看前/尾隙
    let idx = -1;
    for (let i = 0; i < sections.length; i++) {
      if (ln >= lo[i] && ln <= hi[i]) { idx = i; break; }
    }
    if (idx < 0) {
      for (let k = 0; k < locatable.length; k++) {
        const i = locatable[k];
        if (ln > ends[i]) {
          if (k + 1 < locatable.length && ln < starts[locatable[k + 1]]) { idx = locatable[k + 1]; break; }
          if (k + 1 === locatable.length) { idx = i; break; } // 尾隙到文末：归最后一块
        }
      }
    }
    if (idx < 0) idx = locatable.length > 0 ? (ln < starts[locatable[0]] ? locatable[0] : locatable[locatable.length - 1]) : -1;
    if (idx < 0) continue; // 无可定位块：放弃归属（保留原 content，不剥离）

    if (starts[idx] < 0 && sections[idx].content.split('\n').some((l) => l.trim() === hit.line)) {
      continue; // 定位失败块的 content 里本就有该行：透传不重复挂头部
    }
    const target = head[idx];
    const inContent = ln >= starts[idx] && ln <= ends[idx];
    if (hit.type !== 'sub') {
      const key = ordinal(hit.type, hit.line);
      if (key) {
        const full = `${curVolume}|${key}`;
        const prevClaim = claimed.get(full);
        if (!prevClaim) {
          claimed.set(full, { idx, line: hit.line, type: hit.type });
        } else if (hit.line.length > prevClaim.line.length && prevClaim.idx === idx) {
          // 页眉短版先出现、正文完整标题在后：替换头部字段，短版转入剥离表
          if (hit.type === 'volume') target.volume = hit.line;
          else target.partTitle = hit.line;
          stripMap[idx].add(prevClaim.line);
          claimed.set(full, { idx, line: hit.line, type: hit.type });
          if (inContent) stripMap[idx].add(hit.line);
          continue;
        } else {
          // 重复的页眉行：不重复申领；残留在正文中的仍要剥离（不再送 LLM）
          if (inContent) stripMap[idx].add(hit.line);
          continue;
        }
      }
    }
    if (hit.type === 'volume') target.volume = better(target.volume, hit.line);
    else if (hit.type === 'part') target.partTitle = better(target.partTitle, hit.line);
    else if (!inContent) {
      if (!target.subHeaders.includes(hit.line)) target.subHeaders.push(hit.line);
    } else {
      cutSubs[idx].add(hit.line); // 段中节行：切块点（切块时自然从流式 content 移除）
    }
    // 段中的卷/部分行（策略 2/3 未被 parser 消费时）仍需从 content 剥离
    if (hit.type !== 'sub' && inContent) stripMap[idx].add(hit.line);
  }

  // 输出：无段中节行的块单段直出；有则在各节行处切块（节行成为新段 subHeaders[0]）
  const out: SectionStructure[] = [];
  for (let i = 0; i < sections.length; i++) {
    const strips = stripMap[i];
    const contentLines = sections[i].content.split('\n');
    const kept = strips.size === 0 ? contentLines : contentLines.filter((l) => !strips.has(l.trim()));
    if (cutSubs[i].size === 0) {
      out.push({ name: sections[i].name, ...head[i], content: kept.join('\n') });
      continue;
    }
    let seg: string[] = [];
    let segHeader: string | null = null; // null = 首段（挂头部字段）
    let headPending = true; // 首个输出段未消费头部字段（首行即节行时并入该段）
    const flush = () => {
      if (seg.length === 0 && segHeader === null) return;
      out.push({
        name: sections[i].name,
        ...(segHeader === null || headPending ? head[i] : {}),
        subHeaders: segHeader === null
          ? head[i].subHeaders
          : headPending && head[i].subHeaders.length > 0
            ? [...head[i].subHeaders, segHeader]
            : [segHeader],
        content: seg.join('\n'),
      });
      headPending = false;
      seg = [];
    };
    // 同一节行重复出现（页眉重复/OCR 重影）只在首次出现处切块，后续跳过
    const usedCuts = new Set<string>();
    for (const l of kept) {
      const t = l.trim();
      if (cutSubs[i].has(t)) {
        if (!usedCuts.has(t)) { flush(); segHeader = t; usedCuts.add(t); }
        continue;
      }
      seg.push(l);
    }
    flush();
  }

  // 空内容段（节标题后紧跟下一个节标题/直接到块尾）：头部字段与节标题并入相邻段，
  // 不产生只有标题的空块（省一次按块计费的 LLM 调用）
  const compact: SectionStructure[] = [];
  // 空段累积（标量累积，避免对象自引用的流分析环）
  let pendVol: string | undefined;
  let pendPart: string | undefined;
  let pendSubs: string[] = [];
  let hasPending = false;
  for (const s of out) {
    if (!s.content.trim()) {
      pendVol = pendVol ?? s.volume;
      pendPart = pendPart ?? s.partTitle;
      pendSubs = [...pendSubs, ...s.subHeaders];
      hasPending = true;
      continue;
    }
    if (hasPending) {
      if (!s.volume) s.volume = pendVol;
      if (!s.partTitle) s.partTitle = pendPart;
      s.subHeaders = [...pendSubs.filter((h) => !s.subHeaders.includes(h)), ...s.subHeaders];
      hasPending = false; pendSubs = [];
    }
    compact.push(s);
  }
  if (hasPending) {
    if (compact.length > 0) {
      const last = compact[compact.length - 1];
      last.subHeaders = [...last.subHeaders, ...pendSubs.filter((h) => !last.subHeaders.includes(h))];
      if (!last.volume) last.volume = pendVol;
      if (!last.partTitle) last.partTitle = pendPart;
    } else {
      compact.push({ name: out[0]?.name ?? sections[0]?.name ?? '',
        volume: pendVol, partTitle: pendPart, subHeaders: pendSubs, content: '' });
    }
  }
  return compact;
}
