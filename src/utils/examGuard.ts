/**
 * 试卷解析守卫：题号 diff。
 * 输入侧（大题块原文的行首题号）与输出侧（LLM 解析出的题目题号）比对：
 * 缺号 = 疑似漏题（LLM 省略/输出截断），多出 = 疑似幻觉编号。
 * 仅提示不阻断；原文没有可识别题号（<3 个）的块（如整篇语篇填空）跳过。
 */
export interface QuestionGuard {
  missing: number[];
  extra: number[];
}

/**
 * 行首题号识别（1–2 位数字 + .／．／、分隔）。排除与例外：
 *  - 含空位横线的行（语篇填空 "56. ___" 的内嵌编号不是独立题）
 *  - 解析版解释行（【答案】【解析】【详解】【分析】开头内容）
 *  - 光秃数字行（数字后无内容，多为页码）——例外分几形态：
 *    · 秃号连排（一号一行的听力图片题，docx 提取剥掉图片后只剩秃号）：前后
 *      非空行（跳过图片占位行）是秃号且与本题号差 1（连排真题号逐题递增；
 *      页脚数字即使被占位行桥进两秃号之间，差值也远大于 1）
 *    · 下一非空行是听力材料指令（「听第10段材料，回答第11至12题。」「听下面
 *      一段对话，回答第8至9题。」）：图片选项题的收尾形态，指令行是中文但
 *      不是页码伴生行
 *    · 块尾秃号（后面再无内容）：前一非空行是秃号或选项行 = 听力末题计入，
 *      但按孤号记（块尾也可能是末页页脚，前邻恰为选项行，待离群剔除裁决）
 *    · 其余独行秃号：下一非空行是选项行或英文题干行时计入（听力题干在音频里，
 *      卷面只排「1．」+ 下行 A．B．C．；也有「21．」独行、题干换行排的卷面）；
 *      下一行像页码伴生行（分卷/大题标题/解析行/纯中文横幅）时跳过；
 *      非选项行路径收入的孤号最后按连通带裁决剔除（见尾部注释）
 *  - 一行多秃号（「6.   7.   8.   9.   10.」听力图片题排）：整行只由
 *    题号 token 组成且 ≥2 个时全部收（页码不会这样排）
 */
/** 图片占位行：OCR/转录文本用「(图1)」「[图片]」「图 1」等代替图片本身。找秃号相邻行时
 *  视为透明（图片题的秃号与前后秃号/选项常被占位行隔开），也绝不是页码伴生行 */
const IMG_PLACEHOLDER_RE = /^[（([【]?\s*[图照]\s*片?\s*\d{0,2}\s*[）)\]】]?$/;
/** 选项行（行首 A. 起排，或行内 A. … B. … C. … 并排）：秃号相邻行的常见真题形态。
 *  行内并排形态须 A、B、C 三个标号齐备——真实选项行一排至少三项，而叙述句提成绩
 *  「Tom got an A. Jack got a B.」只有 A、B 两处字母标号；三档成绩叙述「got an A.
 *  … a B. … a C.」标号齐备，但 A 前驱是字母词（an/a）——真选项的 A 前是行首/
 *  标点/中文，故 A 标号前驱排除拉丁字母。A 前驱判据会误杀「题干+行内选项」同排行
 *  （「Who will go to the party A. Tom. B. Jack. C. Lucy.」，party 以拉丁字母收尾），
 *  补第三臂：各选项内容以句末标点收尾再接下一标号（「A. Tom. B. Jack. C. Lucy.」）——
 *  叙述句的标号嵌在句中，前一标号与 B/C 之间是「got a」类无标点续文，形态上不可混同 */
function isOptionRow(line: string): boolean {
  return /^[A-D][.．、]/.test(line)
    || (/(^|(?<=[^A-Za-z])\s)A[.．、]\s*\S/.test(line) && /\sB[.．、]/.test(line) && /\sC[.．、]/.test(line))
    || /\sA[.．、]\s*\S.{0,30}?[.。]\s*B[.．、]\s*\S.{0,30}?[.。]\s*C[.．、]/.test(line);
}

/** 独行秃号的下一行若像这些形态，判为页码伴生行（页码后紧跟的是分卷/大题标题/说明，不是题） */
function pageLikeLine(line: string): boolean {
  if (line === '') return true;
  if (/^\d{1,2}\s*[.．、]?\s*$/.test(line)) return true; // 相邻秃号（连排分支漏判时兜底）
  if (/^[-－—–·•・]\s*\d{1,3}\s*[-－—–·•・]$/.test(line)) return true; // 中点/夹线页码「· 8 ·」「- 8 -」
  if (/^[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){1,3}$/.test(line) && !/[.。?？!！]$/.test(line)) return true; // 英文页眉（全词首字母大写短行、无句末标点）
  if (/【答案|【解析|【详解|【分析/.test(line)) return true;
  if (/^第\s*[0-9０-９ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴ一二三四五六七八九十]{1,3}\s*[部分卷节]/.test(line)) return true;
  if (/^(Part|Section|Paper)\s/i.test(line)) return true;
  if (/^[一二三四五六七八九十]+[、.．]/.test(line)) return true;
  // 纯中文行（卷头横幅/注意事项/中文说明）：英语试卷的题干与选项不会是纯中文
  return !/[A-Za-z]/.test(line) && /[一-鿿]/.test(line);
}

export function extractQuestionNumbers(text: string): number[] {
  const nums = new Set<number>();
  const lines = text.split('\n').map((l) => l.trim());
  const nextLine = (from: number): string => {
    for (let i = from + 1; i < lines.length; i++) {
      if (lines[i] && !IMG_PLACEHOLDER_RE.test(lines[i])) return lines[i];
    }
    return '';
  };
  const prevLine = (from: number): string => {
    for (let i = from - 1; i >= 0; i--) {
      if (lines[i] && !IMG_PLACEHOLDER_RE.test(lines[i])) return lines[i];
    }
    return '';
  };
  const bareNum = /^\d{1,2}\s*[.．、]?\s*$/;
  const nextIdx = (from: number): number => {
    for (let i = from + 1; i < lines.length; i++) {
      if (lines[i] && !IMG_PLACEHOLDER_RE.test(lines[i])) return i;
    }
    return -1;
  };
  const prevIdx = (from: number): number => {
    for (let i = from - 1; i >= 0; i--) {
      if (lines[i] && !IMG_PLACEHOLDER_RE.test(lines[i])) return i;
    }
    return -1;
  };
  /** 两行之间是否存在图片占位行（连排 ±2 缺号的合法性依据：缺号行与图片一起被剥） */
  const imgBetween = (a: number, b: number): boolean => {
    for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i++) {
      if (lines[i] && IMG_PLACEHOLDER_RE.test(lines[i])) return true;
    }
    return false;
  };
  const bareVal = (l: string): number | null => {
    if (!bareNum.test(l)) return null;
    const d = l.match(/\d{1,2}/);
    return d ? Number(d[0]) : null;
  };
  // 孤号（凭较弱证据收入的秃号——下行不像页码伴生行 / 块尾前邻选项行）：可能混入
  // 页中断页码或块尾页脚，收集完按连通带裁决剔除
  const lone = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\d{1,2})\s*[.．、]/);
    if (!m) continue;
    if (/_{2,}/.test(line)) continue;
    if (/【答案|【解析|【详解|【分析/.test(line)) continue;
    // 整行仅由「题号+分隔符」token 组成（秃号行/听力图片题的多号一行排）
    const tokens = line.match(/\d{1,2}\s*[.．、]/g) ?? [];
    const onlyNumbers = tokens.length > 0 && line.replace(/\d{1,2}\s*[.．、]|\s+/g, '').length === 0;
    if (onlyNumbers) {
      if (tokens.length >= 2) {
        for (const t of tokens) nums.add(Number(t.replace(/\D/g, '')));
        continue;
      }
      const n = Number(m[1]);
      const next = nextLine(i);
      const prev = prevLine(i);
      // 秃号连排（一号一行的听力图片题，可被图片占位行隔开）：相邻秃号与本题号差 1，
      // 或差 2（单行被静默剥离——号行与图片同失时幸存秃号与邻号差 2；连排首号只有
      // 单侧邻居，不放宽会把首号连锁丢弃成假「幻觉编号」警报），或差 3 且两行之间
      // 夹图片占位行（连剥两行时至少留下邻图占位）。页脚数字即使被占位行桥进两秃号
      // 之间，差值多在 3 以上且无占位行相伴；恰以 ±2/±3 邻接裸号的号带内页码属已接受边界
      const nv = bareVal(next);
      const pv = bareVal(prev);
      const runOK = (j: number, v: number | null): boolean => {
        if (v === null) return false;
        const d = Math.abs(v - n);
        return d === 1 || d === 2 || (d === 3 && j >= 0 && imgBetween(i, j));
      };
      if (runOK(nextIdx(i), nv) || runOK(prevIdx(i), pv)) { nums.add(n); continue; }
      // 下一行是听力材料指令（「听第10段材料，回答第11至12题。」「听下面一段对话，
      // 回答第8至9题。」「听第1段对话，回答第11、12题」「听对话，回答以下小题。」「听
      // 下面的独白，回答以下小题。」「听第 2 段录音，回答第 11 至 12 题。」（真实语料：
      // 英语月考试题模板.docx，段对象含录音）——凡指明具体段落/题号的才是材料级指令；
      // 「听下面5段对话，选择最佳选项」类节级说明不含「回答」，不在此列）：图片选项题收尾
      const isMaterialIntro = /^听第.{1,4}段(材料|对话|独白|录音)/.test(next)
        || (/^听.{0,6}段?(材料|对话|独白|录音)/.test(next) && /回答/.test(next));
      if (isMaterialIntro) { nums.add(n); continue; }
      // 块尾秃号（后面再无内容）：前一非空行是秃号或选项行 = 听力末题。证据较弱
      // （阅读块末页的页脚也恰好是块尾、前邻选项行），记孤号待剔除
      if (next === '' && (bareNum.test(prev) || isOptionRow(prev))) { nums.add(n); lone.add(n); continue; }
      // 选项行/英文题干行跟排：题号计入；走完仍不像页码伴生行的记为孤号（待剔除）
      if (isOptionRow(next)) { nums.add(n); continue; }
      if (!pageLikeLine(next)) { nums.add(n); lone.add(n); }
      continue;
    }
    nums.add(Number(m[1]));
  }
  // 占位行推断：秃号 run 中/尾的「(图N)」——图片题的题号行偶与图片一起被剥掉，占位行的
  // 数字即题号（听音选图小节的图片序号与题号一致）。仅整行占位、邻秃号本身被计入且
  // 推断值与邻秃号连续（= 邻号 ±1）时采信——OCR 把「图9」误读成「图3」时不连号，不采；
  // 「如图1所示」类正文引用不受影响。所凭的邻秃号还须是可信号（非孤号）：阅读配图
  // 的序号与题号无关（页脚 7 + 阅读插图 (图8) 恰连号时会凭一枚孤号页脚洗白出成对
  // 假号 {7,8}，且推断号计入为可信号、带裁决无法剔除）；孤页脚不作推断锚
  for (let i = 0; i < lines.length; i++) {
    if (!IMG_PLACEHOLDER_RE.test(lines[i])) continue;
    const pm = lines[i].match(/(\d{1,2})/);
    const pv = bareVal(prevLine(i));
    const nx = bareVal(nextLine(i));
    const reliable = (v: number | null): number | null => (v !== null && nums.has(v) && !lone.has(v) ? v : null);
    if (pm) {
      const n = Number(pm[1]);
      const pa = reliable(pv);
      const na = reliable(nx);
      if ((pa !== null && n === pa + 1) || (na !== null && n === na - 1)) nums.add(n);
    }
  }
  // 离群孤号剔除：全部已收号按相邻差 ≤5 连成带，孤号仅当所在带含可信号（非孤号）
  // 或带内 ≥3 个号时保留。按连通带而非「最近邻距」判定：同一块的页中断页码 7 与
  // 块尾页脚 8 恰好互为最近邻（距离 1），最近邻距会让两枚假孤号互相保活；按带裁决
  // 则 {7,8} 带内既无可信号又不足 3 个，双双剔除。混排版大题（连排 mains 只占号带
  // 前段、换行排秃号全走孤号路径）的孤号与 mains 同带，不受影响。残余：三枚连排
  // 页脚 {7,8,9} 因带内 ≥3 保活——与号带内页码同属已接受的不可分边界
  const all = [...nums].sort((a, b) => a - b);
  if (all.length >= 2 && lone.size > 0) {
    const keep = new Set<number>();
    let start = 0;
    for (let k = 1; k <= all.length; k++) {
      if (k === all.length || all[k] - all[k - 1] > 5) {
        const band = all.slice(start, k);
        if (band.some((x) => !lone.has(x)) || band.length >= 3) for (const x of band) keep.add(x);
        start = k;
      }
    }
    for (const n of lone) if (!keep.has(n)) nums.delete(n);
  }
  return [...nums].sort((a, b) => a - b);
}

/** LLM 输出题号（字符串转数字，容忍 "21." / "56．" 等尾随标点） */
export function parsedQuestionNumbers(questions: readonly { number?: string }[]): number[] {
  const nums = new Set<number>();
  for (const q of questions) {
    const m = (q.number ?? '').trim().match(/^(\d{1,2})\b/);
    if (m) nums.add(Number(m[1]));
  }
  return [...nums].sort((a, b) => a - b);
}

export function diffQuestionNumbers(expected: readonly number[], got: readonly number[]): QuestionGuard {
  const e = new Set(expected);
  const g = new Set(got);
  return {
    missing: expected.filter((n) => !g.has(n)),
    extra: got.filter((n) => !e.has(n)),
  };
}

/** 对单个大题块跑守卫；无异常或无可比性时返回 null（UI 不显示） */
export function runQuestionGuard(chunkText: string, questions: readonly { number?: string }[]): QuestionGuard | null {
  const expected = extractQuestionNumbers(chunkText);
  if (expected.length < 3) return null;
  const guard = diffQuestionNumbers(expected, parsedQuestionNumbers(questions));
  if (guard.missing.length === 0 && guard.extra.length === 0) return null;
  return guard;
}
