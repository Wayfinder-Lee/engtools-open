import type { FieldSelection, Stage, VocabLevel, WordLevel } from '../types';

function getLevelRule(level: VocabLevel, stage: Stage): string {
  if (stage === 'junior') {
    switch (level) {
      case 'basic':
        return `## 词汇等级：基础级
- 筛选范围：课标二级 505 词 + 七、八年级教材核心词（中考底线要求，学生默认已学过但基础薄弱生未必掌握）
- 难度上限：只保留 A2（初级）及以下难度的词汇
- 跳过：B1 及以上难度的词、九年级新增词、各地增补主题词
- 适合学生：基础薄弱，词汇量明显落后于中考要求`;

      case 'core':
        return `## 词汇等级：核心级
- 筛选范围：初中新增 1095 词中的**中考高频词**（真题考频口径约 487-500 词，完形填空和阅读理解的核心考查对象）
- 难度上限：A2–B1（初级到中级）难度的词汇
- 包含：中考高频实词、常见词组搭配、易混词
- 跳过：超出课标三级词汇表的生僻词、学术性过强的词
- 适合学生：中等层次，正冲刺中考得分率的学生`;

      case 'extended':
        return `## 词汇等级：拓展级
- 筛选范围：初中 1095 词中的低频词 + 各地增补的 100-300 主题词 + 高考动词/介词/形容词短语
- 难度上限：B1（中级）
- 包含：近年中考真题中出现过的较难词汇、地道表达、重点短语
- 跳过：高中词汇、过于专业的术语
- 适合学生：中上层次，冲刺高分的学生`;

      case 'advanced':
        return `## 词汇等级：拔高级
- 筛选范围：三级+ 拓展词（约 1800-2000 词，学有余力）+ 地方考纲词 + 全部较低等级词汇
- 难度上限：B1+（课标三级词汇为主，可含少量初高中衔接词）
- 包含：熟词生义、易混词辨析、中考真题干扰项中的进阶词、少量初高中衔接词
- 适合学生：冲刺中考高分/满分的学生`;
    }
  }

  switch (level) {
    case 'basic':
      return `## 词汇等级：基础级
- 筛选范围：课标必修词汇（新课标 1500–2000 基础词范围）
- 难度上限：只保留 B1（中级）及以下难度的词汇
- 跳过：B2 及以上难度的词、大学四级词汇、学术词汇
- 适合学生：基础薄弱，英语成绩在 90 分以下`;

    case 'core':
      return `## 词汇等级：核心级
- 筛选范围：高考高频核心词（完形填空和阅读理解中的核心考察对象）
- 难度上限：B1–B2（中级到中高级）难度的词汇
- 包含：课标选修词汇、熟词生义、重要词组搭配
- 跳过：大学六级及以上词汇、学术性过强的词
- 适合学生：中等层次，英语成绩在 90–120 分之间`;

    case 'extended':
      return `## 词汇等级：拓展级
- 筛选范围：真题中的进阶词汇，大学四级过渡词
- 难度上限：B2（中高级）
- 包含：近 5 年真题中出现过的较难词汇、地道表达
- 跳过：过于专业的学术术语
- 适合学生：中上层次，英语成绩在 120–135 分之间`;

    case 'advanced':
      return `## 词汇等级：拔高级
- 筛选范围：高分冲刺词汇 + 全部较低等级词汇
- 难度上限：C1（高级）及以下
- 包含：熟词生义、学术词汇、地道短语、易混淆词、干扰项中的生僻正确词
- 适合学生：追求高分，英语成绩 135 分以上`;
  }
}

function getWordLevelRule(wl: WordLevel, stage: Stage): string {
  const examWord = stage === 'junior' ? '中考高频词' : '高考高频词';
  switch (wl) {
    case 'fewer':
      return `## 选词量：更少\n- 只提取最核心的${examWord}和关键搭配（约 4–8 个）\n- 优先挑选文中反复出现、题目直接考查的词汇\n- 宁缺毋滥，不确定重要性的词汇直接跳过`;
    case 'moderate':
      return `## 选词量：适中\n- 提取中等数量的重点词汇（约 6–13 个）\n- 平衡覆盖面与深度，包含主要高频词和部分进阶词`;
    case 'more':
      return `## 选词量：更多\n- 尽可能全面地提取文中值得学习的词汇（约 12–18 个）\n- 包含高频词、进阶词、地道短语和潜在考点词\n- 不遗漏任何可能对学生有帮助的表达`;
  }
}

export function buildVocabExtractionPrompt(level: VocabLevel, wordLevel: WordLevel, fields?: FieldSelection, sectionName?: string, stage: Stage = 'senior'): string {
  const f = fields ?? { phonetic: true, definition: true, collocations: true, memoryAid: true, examFrequency: true, originalSentence: true, extraExample: true };
  const skipFields: string[] = [];
  if (!f.phonetic) skipFields.push('phonetic');
  if (!f.definition) skipFields.push('definition');
  if (!f.collocations) skipFields.push('collocations');
  if (!f.memoryAid) skipFields.push('memoryAid');
  if (!f.examFrequency) skipFields.push('examFrequency');
  if (!f.originalSentence) skipFields.push('originalSentence');
  if (!f.extraExample) skipFields.push('extraExample');

  const skipNote = skipFields.length > 0
    ? `\n## 字段精简\n以下字段用户不需要，请在 JSON 中将它们设为空字符串 "" ：\n${skipFields.map(s => `- ${s}`).join('\n')}\n`
    : '';

  const scopeNote = sectionName
    ? `\n## 试卷范围\n你正在处理的是试卷的**${sectionName}**部分。只需从这部分文本中提取词汇，不要超出这个范围。\n`
    : '';

  // ── 根据 section 类型确定来源标注规则 ──
  const { sourceRules, originalSentenceNote } = getSectionSourceRules(sectionName || '', stage);

  const persona = stage === 'junior'
    ? `你是一位资深的初中英语教学专家，熟悉《义务教育英语课程标准（2022年版）》和中考命题规律，擅长根据中考试卷分析学生需要掌握的重点词汇。

## 你的任务
分析用户提供的中考英语试卷内容，从中提取初中学生需要掌握的**重点词汇**。

## 课标词汇分级参考
依据《义务教育英语课程标准（2022年版）》三级词汇表：约 1600 词（二级 505 词 + 初中新增 1095 词），各地可增补 100-300 主题词，学有余力者可拓展至三级+ 约 1800-2000 词：
- 二级 505 词与初中 1095 词中的高频词（七八年级教材核心词、中考高频词）：spellingRequired 设为 true（须会拼写）
- 地方增补主题词、三级+拓展词、中考真题阅读中的超纲词：spellingRequired 设为 false（仅需认读）
- 课标词的构词法派生词（-tion / -ly / -ful / -less / un- / re- 等）与专有名词（人名/地名/节日/组织缩写）**不算超纲**
请据此合理设置 spellingRequired 字段。`
    : `你是一位资深的高中英语教学专家，擅长根据高考试卷分析学生需要掌握的重点词汇。

## 你的任务
分析用户提供的高考英语试卷内容，从中提取学生需要掌握的**重点词汇**。

## 课标词汇分级参考
依据《普通高中英语课程标准（2020修订版）》词汇表：
- 义务教育阶段词汇（1500词）：无标记，学生已掌握，spellingRequired 设为 true
- 高中必修词汇（500词，标*）：高考核心，spellingRequired 设为 true
- 选择性必修词汇（1000词，标**）：高考扩展，spellingRequired 设为 false（仅需认读）
请据此合理设置 spellingRequired 字段。`;

  const examName = stage === 'junior' ? '中考' : '高考';
  const studentName = stage === 'junior' ? '初中生' : '高中生';

  // 示例词条：初中用课标三级基础词（careful），高中沿用 measure；示例会强烈引导输出难度，必须同学段
  const exampleEntry = stage === 'junior'
    ? `{
      "id": 1,
      "word": "careful",
      "phonetic": "/ˈkeəfl/",
      "examFrequency": "★★★★☆",
      "source": "evidence",
      "sourceLabel": "第2题依据句",
      "definition": "adj. ① 仔细的，小心的 ｜ doing things with attention to detail ② 细致的，认真的 ｜ making sure to avoid mistakes",
      "originalSentence": "Tom is a **careful** boy, and he always checks his answers before handing in his paper. （汤姆是个**细心的**男孩，交卷前总是检查答案。）",
      "collocations": "be careful with sth. 对某事仔细小心; be careful to do sth. 小心谨慎地做某事",
      "memoryAid": "构词法：care（小心）+ -ful（充满……的）→ careful（小心的）。反义词 careless（粗心的）= care + -less（没有）。同根副词 carefully（仔细地）。",
      "extraExample": "Please be **careful** with fire when you cook in the kitchen. （在厨房做饭时请**小心**用火。）",
      "spellingRequired": true
    }`
    : `{
      "id": 1,
      "word": "measure",
      "phonetic": "/ˈmeʒər/",
      "examFrequency": "★★★★☆",
      "source": "evidence",
      "sourceLabel": "第2题依据句",
      "definition": "n. / v. ① 措施，方法 ｜ an action taken to achieve a particular effect ② 测量，衡量 ｜ to find the size, amount, or degree of something",
      "originalSentence": "Effective **measures** should be taken to protect the environment. （应当采取有效**措施**来保护环境。）",
      "collocations": "take measures to do sth. 采取措施做某事; safety measures 安全措施",
      "memoryAid": "词根：meas（测量）→ measure（测量/措施），同根词 measurement（测量结果）、measurable（可衡量的）。注意作「措施」时常以复数 measures 出现。",
      "extraExample": "The government has introduced new **measures** to reduce air pollution in urban areas. （政府出台了新**措施**以减少城市地区的空气污染。）",
      "spellingRequired": true
    }`;
  const boldExample = stage === 'junior' ? '如「**小心的**」对应 careful' : '如「**措施**」对应 measures';
  const collocExample = stage === 'junior'
    ? '「be careful with sth. 对某事仔细小心; be careful to do sth. 小心谨慎地做某事」'
    : '「take measures to do sth. 采取措施做某事; safety measures 安全措施」';

  return `${persona}
${scopeNote}

${getLevelRule(level, stage)}
${getWordLevelRule(wordLevel, stage)}
${skipNote}

## 词汇形式规则（重要）
- **word 字段必须输出词典原形/词条形式（lemma/dictionary form），不能输出变形**
- 名词 → 单数原形（如原句是 measures，输出 measure）
- 动词 → 不带 to 的不定式（如原句是 took，输出 take；原句是 strengthened，输出 strengthen）
- 形容词/副词 → 原级（如原句是 more significant，输出 significant）
- 原句中加粗的词应指向被替换为原形的对应位置
- 不需要在 word 字段中标注原句中的实际变形

## 词汇来源约束
${sourceRules}

- 跳过过于基础的词汇：冠词、常见介词、人称代词、be 动词、A1 级别基础词
${originalSentenceNote}
## 输出格式
你必须返回一个严格的 JSON 对象。以下是每个词汇条目的字段规范：

{
  "vocabularies": [
    ${exampleEntry}
  ]
}

## 各字段编写规范

### definition（词性 + 双语释义）
- 必须**包含词性**在最前面，格式：「词性 ① 中文释义 ｜ English ② 中文释义 ｜ English」
- 如果有多个重要义项，用 ①②③ 编号分行列出，${studentName}不常用的义项可以不列
- 每个义项格式：「中文释义 ｜ English definition」
- 优先列出在试卷中使用的那一个义项
- 义项控制在 1–3 个

### examFrequency（${examName}频次）
- **仅显示星级**，不要附加任何文字说明
- ★★★★★   ★★★★☆   ★★★☆☆   ★★☆☆☆   ★☆☆☆☆   ⚪（潜在考点）
- 示例：正确「★★★★☆」  错误「★★★★☆ 较高（近5年${examName}出现约8次）」

### originalSentence（文中原句）
- 用 **word** 将目标单词加粗
- **中文翻译中对应的汉语词也用 **加粗****（${boldExample}）
- 句末用括号（）附上中文翻译

### extraExample（额外例句）
- 另找一个与该词在试卷中不同义项/语境的例句
- 用 **word** 加粗目标单词
- 中文翻译中的对应汉语词也加粗
- 句末用括号（）附上中文翻译
- 例句难度必须贴合${studentName}的水平，不得超出${examName}考查范围${stage === 'junior' ? `
- **超纲词处理**：确需超出 1600 词表的实词每篇不超过 1-3 个，一律括号加注中文（如 solar power（太阳能）），全篇生词率控制在 3% 以内；已加注中文、课标词构词法可推导、专有名词三类不算超纲` : ''}

### spellingRequired（考纲拼写要求）
- true：该词属于${examName}考纲要求拼写的词汇（课标核心词、高频写作词）
- false：该词仅需认读，不要求拼写（如较难的学术词、低频词、超纲词），默写时只要求写出中文意思

### collocations（常用搭配）
- 列出 2–4 个${examName}中常考的搭配
- 每个搭配附带中文意思，搭配中注明 sth. / sb. 等搭配成分
- 格式：${collocExample}

### memoryAid（辅助记忆）
- **简化原则**：不写${studentName}不认识的拉丁词根或希腊词根，用中文能懂的方式解释
- 优先顺序：
  1. **常见词根/前缀/后缀**（只使用${studentName}接触过的，如 -tion, re-, un-, -able）
  2. **构词分解**（复合词拆分，如 greenhouse = green + house）
  3. **联想记忆**（谐音、形象联想）
  4. **对比辨析**（近义词/形近词对比）
  5. **用法提醒**（常考搭配、语法注意点）
- 开头标明方法：「词根：」「构词：」「联想：」「辨析：」「用法：」
- **禁止**使用拉丁语源、希腊语源等${studentName}看不懂的术语
- 控制在 2–3 句，简明扼要

## 来源标注规范
${sourceRules}

同一个单词在多个来源中出现时，选择最重要的那一个标注。

请严格按照 JSON 格式返回，不要包含任何额外的解释文字。`;
}

/**
 * 根据 section 名称推导该 section 的来源标注规则。
 * 不同题型有不同的有效来源类型和 sourceLabel 格式。
 */
function getSectionSourceRules(sectionName: string, stage: Stage): {
  sourceRules: string;
  originalSentenceNote: string;
} {
  if (!sectionName) {
    // 无 section 信息：使用通用规则
    return {
      sourceRules: `- 主旨句 → source: "main_idea"，sourceLabel: "主旨句"
- 依据句 → source: "evidence"，sourceLabel: "第X题依据句"
- 题干 → source: "question_stem"，sourceLabel: "第X题题干"
- 选项 → source: "option"，sourceLabel: "第X题选项A"（标注具体选项字母）`,
      originalSentenceNote: '',
    };
  }

  if (sectionName.startsWith('听力')) {
    return {
      sourceRules: `- 只能从听力题目中提取词汇，**不区分**主旨句/题干/选项
- source 统一使用 "question_stem"
- sourceLabel 格式："听力第X题"（X 为题号）
- **不要**使用主旨句、依据句等分类`,
      originalSentenceNote: '\n## originalSentence 特殊规则\n- 如果词汇来自听力**选项**文本（非题目正文），则 originalSentence 输出空字符串 ""\n- 其他情况正常填写\n',
    };
  }

  if (sectionName.startsWith('阅读理解')) {
    const prefix = sectionName; // e.g. "阅读理解C"
    return {
      sourceRules: `- 主旨句 → source: "main_idea"，sourceLabel: "${prefix}主旨句"
- 依据句 → source: "evidence"，sourceLabel: "${prefix}第X题依据句"
- 题干 → source: "question_stem"，sourceLabel: "${prefix}第X题题干"
- 选项 → source: "option"，sourceLabel: "${prefix}第X题选项A"（标注具体选项字母）`,
      originalSentenceNote: '',
    };
  }

  if (stage === 'senior' && sectionName.startsWith('七选五')) {
    return {
      sourceRules: `- 从七选五的文章和选项中提取词汇
- 来源只有两种情况：
  - 词汇来自文章中的句子 → source: "evidence"，sourceLabel: "七选五第X题附近"
  - 词汇来自选项 → source: "option"，sourceLabel: "七选五选项A"（标注 A/B/C/D/E/F/G）
- **不要**使用主旨句、题干等分类`,
      originalSentenceNote: '\n## originalSentence 特殊规则\n- 如果词汇来自七选五**选项**文本（选项A/B/C/D/E/F/G），则 originalSentence 输出空字符串 ""\n- 其他情况正常填写\n',
    };
  }

  if (sectionName.startsWith('完形填空')) {
    return {
      sourceRules: `- 从完形填空的文章段落和选项中提取词汇
- 来源只有两种情况：
  - 词汇来自文章段落 → source: "main_idea"，sourceLabel: "完形填空第X段"
  - 词汇来自选项 → source: "option"，sourceLabel: "完形填空第X题选项"（X 为题号）
- **不要**使用主旨句、题干等分类`,
      originalSentenceNote: '\n## originalSentence 特殊规则\n- 如果词汇来自完形填空**选项**文本（选项词），则 originalSentence 输出空字符串 ""\n- 其他情况正常填写（如文章段落中的词汇）\n',
    };
  }

  if (sectionName.startsWith('语法填空') || sectionName.startsWith('短文填空') || sectionName.startsWith('选词填空') || sectionName.startsWith('综合填空')) {
    return {
      sourceRules: `- 从${sectionName}的短文中提取词汇
- source 统一使用 "evidence"
- sourceLabel 格式："${sectionName}第X题附近"（X 为与该词相关的题号）
- **不要**使用主旨句、题干、选项等分类`,
      originalSentenceNote: '',
    };
  }

  if (stage === 'senior' && sectionName.startsWith('读后续写')) {
    return {
      sourceRules: `- 从读后续写的原文故事中提取词汇（**不提取**续写段落首句）
- source 统一使用 "main_idea"
- sourceLabel 格式："读后续写原文第X段"（X 为段落序号）
- **不要**使用依据句、题干、选项等分类`,
      originalSentenceNote: '',
    };
  }

  if (stage === 'junior') {
    // ── 中考专属题型 ──
    if (sectionName.startsWith('单项选择')) {
      return {
        sourceRules: `- 从单项选择的题干和选项中提取词汇
- 来源只有两种情况：
  - 词汇来自题干句子 → source: "question_stem"，sourceLabel: "单项选择第X题题干"
  - 词汇来自选项 → source: "option"，sourceLabel: "单项选择第X题选项"（X 为题号）
- **不要**使用主旨句、依据句等分类`,
        originalSentenceNote: '\n## originalSentence 特殊规则\n- 如果词汇来自单项选择**选项**文本，则 originalSentence 输出空字符串 ""\n- 其他情况正常填写（题干句子中的词汇）\n',
      };
    }

    if (sectionName.startsWith('任务型阅读')) {
      return {
        sourceRules: `- 从任务型阅读的文章和题目中提取词汇
- 来源只有两种情况：
  - 词汇来自文章中的句子 → source: "evidence"，sourceLabel: "任务型阅读第X题附近"
  - 词汇来自题目（题干/表格/回答要求） → source: "question_stem"，sourceLabel: "任务型阅读第X题"
- **不要**使用主旨句等分类`,
        originalSentenceNote: '',
      };
    }

    if (sectionName.startsWith('词汇运用') || sectionName.startsWith('完成句子')) {
      return {
        sourceRules: `- 从${sectionName}的题目中提取词汇
- source 统一使用 "question_stem"
- sourceLabel 格式："${sectionName}第X题"
- **不要**使用主旨句、依据句、选项等分类`,
        originalSentenceNote: '',
      };
    }

    if (sectionName.startsWith('情景交际')) {
      return {
        sourceRules: `- 从情景交际的对话文本中提取词汇
- source 统一使用 "question_stem"
- sourceLabel 格式："情景交际第X题"
- **不要**使用主旨句、依据句、选项等分类`,
        originalSentenceNote: '',
      };
    }

    if (sectionName.startsWith('书面表达')) {
      return {
        sourceRules: `- 从书面表达的题目要求（中文提示、英文引导句）中提取可用于写作的词汇
- source 统一使用 "main_idea"
- sourceLabel 格式："书面表达题目要求"
- **不要**使用依据句、题干、选项等分类`,
        originalSentenceNote: '',
      };
    }
  }

  // fallback
  return {
    sourceRules: `- 主旨句 → source: "main_idea"，sourceLabel: "${sectionName}主旨句"
- 依据句 → source: "evidence"，sourceLabel: "${sectionName}第X题依据句"
- 题干 → source: "question_stem"，sourceLabel: "${sectionName}第X题题干"
- 选项 → source: "option"，sourceLabel: "${sectionName}第X题选项A"（标注具体选项字母）`,
    originalSentenceNote: '',
  };
}

/**
 * 构建语法填空检测题的 System Prompt
 * 输入词汇列表，输出高考/中考风格的语法填空题
 */
export function buildClozePrompt(vocabList: { word: string; definition: string; originalSentence: string }[], stage: Stage = 'senior'): string {
  const wordList = vocabList
    .map((v, i) => `${i + 1}. ${v.word} — ${v.definition}\n   原句：${v.originalSentence.replace(/\*\*/g, '')}`)
    .join('\n');

  if (stage === 'junior') {
    return `你是一位中考英语命题专家。根据以下词汇列表，为每个词命制一道单句填空题。

## 词汇列表
${wordList}

## 出题要求（重要）
- 为列表中的**每一个词**出一道题（共 ${vocabList.length} 道）
- 题型：给词填空（中考语法填空/短文填空题型），句末括号内给出提示词
- 句子可以仿照原句语境，但**不能完全照搬原句**

## 提示词设计规则（关键）
- **提示词（hint）必须与答案（answer）词形不同**，不能直接给出答案形式
- 这是为了让学生分析句子结构、判断所需词性/形式，而非简单照抄
- 正确示例：
  ✅ 答案 happily（副词）→ 提示词 happy（形容词）— 考察形容词→副词转换
  ✅ 答案 measures（名词复数）→ 提示词 measure（动词原形）— 考察动词→名词转换
  ✅ 答案 to learn（不定式）→ 提示词 learning（动名词）— 考察非谓语基础用法
  ✅ 答案 went（过去时）→ 提示词 go — 考察一般过去时（**时间状语需明确提示过去时间**）
  ✅ 答案 carefully（副词）→ 提示词 careful（形容词）— 考察形容词→副词转换
- 错误示例：
  ❌ 答案 measures → 提示词 measure — 太简单，照抄即可（没有语境支撑词形判断）

## 考点设计要求（对齐中考考点）
- 时态变化（一般现在时/一般过去时/现在进行时等）是中考核心考点，**可以出**，但句中必须有明确的时间状语或语境线索（如 yesterday, now, every day, last week）
- 优先考察以下考点：
  1. **词性转换**：形容词↔副词、动词↔名词、形容词↔名词
  2. **名词单复数**：根据上下文（如 there are, many, several）判断
  3. **谓语时态**：句中有明确时间状语线索时考察时态变化
  4. **非谓语基础用法**：不定式作宾语（want to do / decide to do）、动名词（enjoy doing / finish doing）
  5. **形容词/副词比较级最高级**
  6. **固定搭配中的词形**：如 be good at doing, look forward to doing
- **不要**考察超出中考范围的语法（分词作状语、倒装、虚拟语气等）
- 被动语态可考一般现在/一般过去/一般将来三种（is done / was done / will be done）；情态动词被动与完成时被动**不考**
- 句子难度匹配中考水平，用词限于课标三级词汇（约 1600 词）
- 每道题句子长度 10-20 词

## 输出格式
严格的 JSON：
{
  "items": [
    {
      "sentence": "Listen to the teacher __________ in class, or you will miss something important. (careful)",
      "hint": "careful",
      "answer": "carefully"
    },
    {
      "sentence": "Last Sunday, we __________ to the museum and learned a lot about history. (go)",
      "hint": "go",
      "answer": "went"
    }
  ]
}

- sentence：含 __________ 留空的完整句子，句末括号里写提示词（与答案不同形式，或时态题有明确时间线索）
- hint：提示词（必须与 answer 词形不同）
- answer：正确答案

请严格按照 JSON 格式返回，不要包含任何额外的解释文字。`;
  }

  return `你是一位高考英语命题专家。根据以下词汇列表，为每个词命制一道单句语法填空题。

## 词汇列表
${wordList}

## 出题要求（重要）
- 为列表中的**每一个词**出一道题（共 ${vocabList.length} 道）
- 题型：给词填空（高考语法填空第二节），句末括号内给出提示词
- 句子可以仿照原句语境，但**不能完全照搬原句**

## 提示词设计规则（关键）
- **提示词（hint）必须与答案（answer）词形不同**，不能直接给出答案形式
- 这是为了让学生分析句子结构、判断所需词性/形式，而非简单照抄
- 正确示例：
  ✅ 答案 automation（名词）→ 提示词 automatic（形容词）— 考察形容词→名词转换
  ✅ 答案 measures（名词复数）→ 提示词 measure（动词原形）— 考察动词→名词转换
  ✅ 答案 to protect（不定式）→ 提示词 protection（名词）— 考察名词→非谓语
  ✅ 答案 strengthening（动名词）→ 提示词 strong（形容词）— 考察形容词→动名词
  ✅ 答案 significance（名词）→ 提示词 significant（形容词）— 考察形容词→名词
- 错误示例：
  ❌ 答案 measures → 提示词 measure — 太简单，照抄即可
  ❌ 答案 took → 提示词 take — 仅考察过去时变化，过于简单

## 考点设计要求
- **禁止**纯粹的动词过去时变化（如 take→took），这太简单
- 优先考察以下考点：
  1. **词性转换**：形容词↔名词、动词↔名词、形容词↔副词
  2. **非谓语动词**：不定式(to do)、动名词(-ing)、分词(-ed/-ing)的选择
  3. **谓语时态语态**：需要分析句子时间状语和主被动关系才能判断
  4. **名词单复数**：需要根据上下文（如 there are, many, several）判断
  5. **形容词/副词比较级最高级**
  6. **固定搭配中的词形**：如 suggest doing, avoid being done
- 句子难度匹配高考全国卷语法填空水平
- 每道题句子长度 15-25 词

## 输出格式
严格的 JSON：
{
  "items": [
    {
      "sentence": "The factory has introduced high-level __________ to replace manual labor. (automatic)",
      "hint": "automatic",
      "answer": "automation"
    },
    {
      "sentence": "It is of great __________ to protect these endangered species from extinction. (significant)",
      "hint": "significant",
      "answer": "significance"
    }
  ]
}

- sentence：含 __________ 留空的完整句子，句末括号里写提示词（与答案不同形式）
- hint：提示词（必须与 answer 词形不同）
- answer：正确答案

请严格按照 JSON 格式返回，不要包含任何额外的解释文字。`;
}
