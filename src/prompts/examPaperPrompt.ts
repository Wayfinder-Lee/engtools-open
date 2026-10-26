/**
 * 试卷排版助手：大题结构化解析 prompt。
 * 输入是大题块原文（sectionParser 切分），输出 {instruction, questions} JSON。
 * 核心原则：逐字保真，只做结构识别与重组，绝不改写/作答。
 */
import type { Stage } from '../types';

export function buildExamParsePrompt(sectionTitle: string, stage: Stage = 'senior', typeHint?: string): string {
  const persona = stage === 'junior'
    ? '你是一个高精度的初中英语试卷（中考及平时测验）结构化解析引擎。'
    : '你是一个高精度的高中英语试卷结构化解析引擎。';
  const examName = stage === 'junior' ? '中考' : '高考';
  const essayRule = stage === 'junior'
    ? '- essay：写作题（书面表达，初中没有读后续写），完整中文+英文题干放 stem（含所给开头/结尾句），多段用 \\n 分隔。'
    : '- essay：写作题（应用文/读后续写），完整中文+英文题干放 stem（含所给段首句），多段用 \\n 分隔。';
  const blankRule = stage === 'junior'
    ? '- blank：语篇型填空整篇短文是【一道题】：type=blank，number 为 ""，stem 为完整短文原文（段用 \\n 分隔），句中空位原样保留（横线统一为 5 个下划线 _____，空位自带的题号数字与括号提示词/选词提示照抄，如 "___56___ (go)"）。初中此类大题常见名称为语法填空/短文填空/选词填空/综合填空，均按本规则处理：绝对禁止按空位拆分成多题、禁止给每个空单独输出一题。'
    : '- blank：语法填空（语篇型）整篇短文是【一道题】：type=blank，number 为 ""，stem 为完整短文原文（段用 \\n 分隔），句中空位原样保留（横线统一为 5 个下划线 _____，空位自带的题号数字与括号提示词照抄，如 "___56___ (go)"）。绝对禁止按空位拆分成多题、禁止给每个空单独输出一题。';
  const sentenceBlankRule = stage === 'junior'
    ? '- 单句填空（非语篇、每句独立题号，如单词拼写/完成句子/词汇运用/选词补全短文的单句形式）才每句一题：number 为该句题号，stem 为整句（含 _____ 与提示词）。'
    : '- 单句填空（非语篇、每句独立题号）才每句一题：number 为该句题号，stem 为整句（含 _____ 与提示词）。';
  const choiceRule = stage === 'junior'
    ? '- choice：带题号的选择题，每个题号一题，选项按 A/B/C/D 拆入 options。听力每个编号、单项选择、完形填空、阅读理解的选择题同样按 choice 处理。'
    : '- choice：带题号的选择题，每个题号一题，选项按 A/B/C/D（七选五为 A–G）拆入 options。听力每个编号同样按 choice 处理。';

  const hintLine = typeHint && typeHint.trim()
    ? `\n本大题的预期题型与结构（用户声明的先验，仅供参考；与原文实际不符时以原文为准）：${typeHint.trim()}`
    : '';

  return `${persona}你的任务是把一段试卷原文（可能从 Word/PDF 复制而来，换行、页码、格式混乱）转换为结构化 JSON，用于后续排版。本段内容属于大题「${sectionTitle}」（仅供理解上下文，无需输出标题）。${hintLine}

## 任务
逐字保留原文内容，只做结构识别与重组，绝不改写、翻译、纠错、增删内容。仅允许两类清理：合并被硬换行打断的句子；删除页眉页脚/页码/水印行（如「第X页（共X页）」、装订线提示、重复的试卷名横幅）。

## 题型判定规则
- passage：没有题号的文章正文、对话或独白。阅读理解的文章、完形填空的正文${stage === 'senior' ? '、七选五的正文' : ''}、听力的对话材料都是 passage。
${choiceRule}
${blankRule}
${sentenceBlankRule}
- 空位编号内嵌在正文标记中（如 ___16___、___41___）时，这些编号不是独立题号：禁止为它们单独输出任何 stem 只含数字/下划线而无实际内容、也没有 options 的空壳条目（如 {number:"16", stem:"16"}）。
${essayRule}
- other：以上都无法归类的内容，按出现顺序输出，不得丢弃任何输入文字。

## 输出格式
严格 JSON 对象，只含 instruction 与 questions 两个字段：

{
  "instruction": "大题标题下的中文说明句，如：阅读下列短文，从每题所给的A、B、C、D四个选项中选出最佳选项。没有则为空字符串",
  "questions": [
    { "type": "passage", "number": "", "label": "A", "stem": "It was a cold winter evening...\\n第二段...", "answer": "" },
    { "type": "choice", "number": "1", "stem": "What did the author do after dinner?", "options": [ { "label": "A", "text": "He stayed home." }, { "label": "B", "text": "He went out." }, { "label": "C", "text": "..." }, { "label": "D", "text": "..." } ], "answer": "" },
    { "type": "blank", "number": "", "stem": "China has made significant progress toward the vision of ___56___ (explore) space.\\nOn December 13, the space ecosystem ____ (carry) out its mission.", "answer": "56. exploring  57. was carried" },
    { "type": "essay", "number": "67", "stem": "假定你是李华……\\n注意：1. ${stage === 'junior' ? '词数80-100' : '词数100左右'}；", "answer": "" },
    { "type": "other", "number": "", "stem": "……", "answer": "" }
  ]
}

## 各字段要求
- number：原卷题号原样输出为字符串，禁止重新编号或推算编号；无编号内容 number 为 ""。
- instruction：大题标题下的中文说明句必须逐字保留（含「选项中有两项为多余选项」等关键作答条件），禁止省略、改写或并入正文；没有说明句时为空字符串。
- passage 块必须排在其所属题目之前，保持原文顺序。
- label：仅当原文有独立的字母标号（阅读理解 A–D）时填写，否则省略该字段。
${stage === 'senior' ? '- 七选五：正文（含句中 ___ 与空位编号，如 ___16___）为一个 passage 块；7 个选项输出为一个 number 与 stem 均为 "" 的 choice 块，options 为 A–G。空位编号（如 16–20）只存在于正文空格标记中，绝对禁止再为它们生成题目条目。' : '- 选词填空（方框选词补全短文）：方框内的备选词照抄进 instruction 或独立 other 块（保持原位置），正文为一个 blank 块，空位以 _____ 保留。'}
- 完形填空：正文（含编号空格）为一个 passage 块，其后各题为 choice；各 choice 题的 stem 必须为空字符串（题干就是正文空位，禁止把 "41. A. changes B. …" 选项整行或题号复述抄进 stem，选项只进 options）。
- 语法填空${stage === 'junior' ? '/短文填空/综合填空（语篇型）' : ''}：整篇短文只输出一个 blank 块（number 为 ""）；原卷给出的答案合并写入该块的 answer，格式如 "56. exploring  57. was carried"；答案未给出则 answer 为 ""。
- answer：仅当输入文本中明确给出该题答案时填写；否则一律空字符串。绝对不要自己作答。
- stem 中段落用 \\n 分隔，换行必须转义，确保 JSON 合法。
- 不要输出任何 JSON 以外的文字。本试卷为${examName}范畴试卷，识别题型时以对应学段的题型习惯为准。

请严格按照 JSON 格式返回。`;
}

/**
 * 附录答案提取 prompt：输入是试卷文末附录（参考答案/答案详解等）原文，输出按题号的
 * {number, answer} 清单。复用 parseExamSection 管线（shape 兼容 ExamSectionParseResult），
 * 无需新增 API 函数。
 */
export function buildExamAnswerKeyPrompt(): string {
  return `你是试卷答案提取器。输入是一份试卷文末附录的原文（参考答案 / 答案详解 / 答案速查等，从 Word/PDF 复制而来，格式混乱）。请把其中给出的答案逐题提取成结构化 JSON。

## 任务
逐字保留答案内容，绝不改写、翻译、纠错，更**绝对禁止自己作答**——只提取原文明确给出的答案。
仅允许的清理：删除页眉页脚/页码/水印行（如「第X页（共X页）」、{#{…}#} 串、公众号/扫码推广行），包括与答案粘连在同一行内的水印串（如 "BACDB{#QQ…}#" → 只留 "BACDB"）。

## 提取规则
- 每个题号一条：{ "type": "other", "number": 题号, "stem": "", "answer": 答案 }。
- 选择题填选项字母（"B"；组合如 "AB" 原样保留）。
- **区间压缩形式必须展开成逐题条目**："1-5 BACCA" → 5 条（1=B, 2=A, 3=C, 4=C, 5=A）；"C: 27-30 DABB"、"七选五阅读： 35-39 FBCGA" 同理逐题展开。
- 按空位给答案的（语法填空 "56. exploring  57. was carried"、听力填表等）**每个空位一条**：number 为该空位号，answer 为该空的答案。
- 写作题范文：number 为该写作题题号，answer 为范文完整原文（多段用 \\n 分隔），逐字保留。
- 【解析】【详解】等讲解文字一律丢弃，只留答案本身。
- 没有题号的行（附录标题、说明行）丢弃；无法确定题号的条目丢弃。
- 题号原样输出为字符串，禁止重新编号或推算。

## 输出格式
严格 JSON 对象，只含 instruction（恒为 ""）与 questions 两个字段：
{"instruction":"","questions":[{"type":"other","number":"1","stem":"","answer":"B"},{"type":"other","number":"56","stem":"","answer":"exploring"}]}

请严格按照 JSON 格式返回。`;
}
