// ─── 应用文助手 Prompt ─────────────────────────────

import type { Stage, WritingLevel } from '../types';

function getLevelRule(level: WritingLevel): string {
  switch (level) {
    case 'basic':
      return `## 质量层次：基础级
- 句式正确、结构清晰、语法无误
- 覆盖题干全部要点，不遗漏
- 使用基础的连接词和常见表达即可
- 避免使用复杂的高分句式导致出错
- 适合需要保底分数的学生（8-11分/15分）`;
    case 'formula':
      return `## 质量层次：套路级
- **大量使用**高中英语高分句式，越丰富越好：
  - 非谓语作状语（V-ing/V-ed/To do..., 主句）
  - 定语从句（..., which/who/where...）
  - 倒装句（Not only did I..., but also I... / Only in this way can we...）
  - 强调句（It is... that...）
  - 形式主语句（It is universally acknowledged that... / It is advisable that...）
  - 虚拟语气（I would appreciate it if you could...）
  - with 复合结构
  - 被动语态
- 这些套路句式的密集使用是得分关键，即使有些表达不够贴切自然
- 适合冲刺高分的学生（12-14分/15分）`;
    case 'advanced':
      return `## 质量层次：拔高级
- 语言**地道自然**，选词精准贴切，而不是堆砌套路句式
- 语感流畅，像母语者写作
- 可以使用一些不一定被高中阅卷老师偏好的地道表达
- 但仍然保证要点齐全、结构合理
- ⚠️ 不适用于高考备考，适合培养真实英语写作能力`;
  }
}

/** 初中（中考书面表达）质量层次：对齐中考一档文「准确度优先、亮点句式 2-4 处」的评分实情 */
function getLevelRuleJunior(level: WritingLevel): string {
  switch (level) {
    case 'basic':
      return `## 质量层次：基础级（目标 7-12 分/15 分）
- 以简单句和并列句为主体，句式正确、语法零错误是第一目标
- 覆盖题干全部要点，不遗漏；词数达标（80-100 词）
- 时态限于一般现在时、一般过去时、一般将来时
- 连接词仅用 and / but / or / so / because / first / then / finally
- 避免使用复杂句式导致出错
- 适合需要保底分数的学生`;
    case 'formula':
      return `## 质量层次：套路级（目标 13-15 分/15 分）
- 三段式结构 + 分体裁公式句：开头 I'm writing to... / I'm glad to...，主体 First... What's more... Finally...，结尾 I'm looking forward to...
- 在公式句之上正确使用 1-2 处宾语从句、It is + adj. + to do、so...that / if / although 状语从句、感叹句、not only...but also
- 连接词分级：顺序类（first of all / next / after that / at last）至少 3 处，递进或因果（besides / what's more / as a result）至少 1 处
- **亮点句式全文 2-4 处为宜**：定语从句全文最多 1 处且仅限 that / which / who 限定性；堆砌复杂句反而扣分，准确度优先
- 适合冲刺高分的学生`;
    case 'advanced':
      return `## 质量层次：拔高级（一档顶格 14-15 分/15 分）
- 在套路级基础上叠加 2-4 处亮点：so...that / if / although 状语从句、What a...! / How...! 感叹句、1 处被动语态、1 处限定性定语从句（that / which / who）、the more... the more...
- 高分连接词：however / therefore / on the other hand / in a word（同层不重复堆砌）
- 细节扩展 + 情感升华，语言自然流畅
- 仍须限于初中语法与词汇范围，保证要点齐全、全篇仅容 1-2 处小错（中考一档文标准）`;
  }
}

export function buildPracticalWritingPrompt(userInput: string, level: WritingLevel = 'formula', stage: Stage = 'senior'): string {
  if (stage === 'junior') {
    return `你是一位资深的初中英语写作教学专家，熟悉《义务教育英语课程标准（2022年版）》三级词汇表（约 1600 词，含二级 505 词 + 初中新增 1095 词；各地可增补 100-300 主题词）和中考书面表达评分标准，专门辅导中考英语写作。

## 任务
根据用户提供的书面表达题目题干，生成一份完整的写作教学学案。

${getLevelRuleJunior(level)}

## 范文格式要求（极其重要）

### 段落结构：三段式，总词数 80-100 词（中考标准）
- **Paragraph 1（开头段·短）**：1-2 句话，点明写作目的或背景，简洁明了。
- **Paragraph 2（主体段·长）**：3-5 句话，用衔接词（First / Besides / What's more / Finally）逐条展开，充分覆盖题干要点。
- **Paragraph 3（结尾段·短）**：1-2 句话，表达总结、感谢、希望或期待回复等内容。

### 数组格式与词数
- essay 是字符串数组，**必须恰好 3 个元素**：essay[0] = Paragraph 1, essay[1] = Paragraph 2, essay[2] = Paragraph 3
- 每句前标序号：①②③...
- 总词数控制在 **80-100 词**（不含称呼与落款），主流中考要求 80 词左右；北京不少于 50 词、上海 60-100 词、河南/武汉 100 词左右——以题目要求和当地中考考试说明为准
- 题目已给出的开头句/结尾句**不计入总词数**；词数不足或超出过多都会被扣分

### 语言难度约束（重要）
- 全部词汇限于课标三级词汇（约 1600 词）以内，**不得出现高中词汇**；课标词的构词法派生词（-ly / -ful / -less / -tion 等）与专有名词不算超纲
- 句式限于初中语法范围：简单句、并列句、宾语从句、状语从句、基础定语从句、被动语态、比较级最高级、不定式、动名词基础用法（enjoy doing / finish doing）、感叹句
- **禁止**使用倒装、虚拟语气、非谓语动词作状语、独立主格、with 复合结构等高中句式
- 定语从句全文最多 1 处且仅限 that / which / who 限定性

### 硬性约束
- 时态符合体裁：日记/记叙经历用一般过去时，建议/计划类用一般现在时或一般将来时
- 范文中不得出现真实姓名、校名、地名（部分地区中考违者判零分）
- 书信不写地址与日期；日记体裁第一行必须有日期和天气
- 不得照抄试卷阅读材料中的句子

### 信件格式（按体裁区分，学案导出依赖此格式自动提行）
- **书信体裁**（邀请信/感谢信/建议信/介绍信/询问信/道歉信等）：
  - essay[0] 必须以 "Dear 称呼," 开头（写在段首，① 序号放在 Dear 之前），称呼后接正文第一句
  - essay[2] 必须以落款 "Yours sincerely, Li Hua" 结尾（紧接最后一句写在本段末，导出时会自动提行右对齐；若题目给了署名则用题目署名）
- **非书信体裁**（话题作文、介绍人物/地方、通知、发言稿等）：**不要**出现 Dear 称呼，也**不要**任何 Yours/署名落款，直接以正文开头、正文收尾

## 用户题干
${userInput}

## 话题素材原创性要求（极其重要）
- vocabSections 中的 words、phrases、sentences 必须全部重新创作，**严禁摘抄或简单改写范文中已出现的单词、短语和句子**
- 这些素材的定位是"可迁移的万能积累"：学生写同体裁的其他题目时也能直接使用，而不是本题范文的词汇摘录
- 优先选择通用性高、适用面广、脱离本题题干依然成立的中考高频表达；仅适用于本题特定内容的素材不要选
- 话题优先级（课标三大范畴高频子主题）：核心高频=学习方法/学校生活/朋友家人/日常计划/建议观点/中华传统文化；次高频=健康运动/节日文化/旅行/环保/安全自救/劳动教育；可少量涉及 AI 与学习/睡眠健康/航天科技等新趋势；避免国际政治、经济类抽象议题
- 注意：dictationSentences 仍然从范文逐句拆分，两者用途不同，不要混淆

## 输出格式
严格的 JSON 对象：

{
  "essay": [
    "① Dear Peter, I'm glad to hear from you. ② Now let me tell you something about the sports in our school.",
    "③ Our school has a big playground and a new gym. ④ There are many kinds of sports for us, such as basketball, football and table tennis. ⑤ We usually play different sports together after class every afternoon. ⑥ I think doing sports can keep us healthy and make us relaxed.",
    "⑦ I hope you can come and play with us one day. ⑧ I'm looking forward to your reply. Yours sincerely, Li Hua"
  ],
  "analysis": {
    "genre": "介绍信",
    "genreEn": "Letter of Introduction",
    "tone": "半正式",
    "structure": "开头问候点题-主体介绍学校体育活动-结尾表达期待",
    "keyPoints": ["要点1", "要点2", "要点3"]
  },
  "vocabSections": [
    {
      "title": "夺人眼球开头",
      "description": "开头段问候、点明写作目的的通用素材",
      "words": [
        { "en": "pleased", "cn": "高兴的" },
        { "en": "excited", "cn": "兴奋的" },
        { "en": "lucky", "cn": "幸运的" },
        { "en": "friendly", "cn": "友好的" },
        { "en": "busy", "cn": "忙碌的" },
        { "en": "wonderful", "cn": "极好的" }
      ],
      "phrases": [
        { "en": "hear from sb.", "cn": "收到某人的来信" },
        { "en": "be glad to do sth.", "cn": "很高兴做某事" },
        { "en": "tell sb. about sth.", "cn": "告诉某人关于某事" },
        { "en": "would like to do sth.", "cn": "想要做某事" },
        { "en": "ask sb. for help", "cn": "向某人求助" },
        { "en": "introduce ... to ...", "cn": "向……介绍……" },
        { "en": "say thanks to sb.", "cn": "向某人道谢" },
        { "en": "welcome to ...", "cn": "欢迎来到……" }
      ],
      "sentences": [
        { "en": "I'm very glad to tell you something about my school life.", "cn": "我很高兴告诉你一些关于我学校生活的事。", "note": "be glad to do 固定搭配" },
        { "en": "Thank you for telling me about your family.", "cn": "谢谢你告诉我你家的情况。", "note": "动名词作介词宾语" },
        { "en": "I would like to invite you to visit our school next week.", "cn": "我想邀请你下周参观我们学校。", "note": "would like to do + 不定式作宾补" }
      ]
    },
    {
      "title": "亮点出彩篇中",
      "description": "主体段展开说明、介绍的通用素材",
      "words": [
        { "en": "favorite", "cn": "最喜欢的" },
        { "en": "popular", "cn": "受欢迎的" },
        { "en": "interesting", "cn": "有趣的" },
        { "en": "important", "cn": "重要的" },
        { "en": "helpful", "cn": "有帮助的" },
        { "en": "healthy", "cn": "健康的" }
      ],
      "phrases": [
        { "en": "all kinds of", "cn": "各种各样的" },
        { "en": "be good for", "cn": "对……有益" },
        { "en": "take part in", "cn": "参加" },
        { "en": "be interested in", "cn": "对……感兴趣" },
        { "en": "help sb. (to) do sth.", "cn": "帮助某人做某事" },
        { "en": "spend ... doing sth.", "cn": "花费……做某事" },
        { "en": "learn from", "cn": "向……学习" },
        { "en": "not only ... but also ...", "cn": "不仅……而且……" }
      ],
      "sentences": [
        { "en": "There are many kinds of activities in our school, such as singing and dancing.", "cn": "我们学校有各种各样的活动，比如唱歌和跳舞。", "note": "there be 句型 + such as 举例" },
        { "en": "I think doing sports can keep us healthy.", "cn": "我认为做运动能使我们保持健康。", "note": "宾语从句 + 动名词作主语" },
        { "en": "If you come to our school, you will like it.", "cn": "如果你来我们学校，你会喜欢它的。", "note": "if 引导的条件状语从句" }
      ]
    },
    {
      "title": "韵味无穷结尾",
      "description": "结尾段总结、致谢、期待回复的通用素材",
      "words": [
        { "en": "hope", "cn": "希望" },
        { "en": "sure", "cn": "确信的" },
        { "en": "sorry", "cn": "抱歉的" },
        { "en": "kind", "cn": "好心的" },
        { "en": "great", "cn": "好极了" },
        { "en": "best", "cn": "最好的" }
      ],
      "phrases": [
        { "en": "look forward to doing sth.", "cn": "期待做某事" },
        { "en": "write back soon", "cn": "尽快回信" },
        { "en": "best wishes", "cn": "最美好的祝愿" },
        { "en": "keep in touch", "cn": "保持联系" },
        { "en": "wait for", "cn": "等待" },
        { "en": "have a good time", "cn": "玩得开心" },
        { "en": "come true", "cn": "实现" },
        { "en": "in a word", "cn": "总之" }
      ],
      "sentences": [
        { "en": "I'm looking forward to your reply.", "cn": "我期待着你的回信。", "note": "look forward to doing 固定搭配" },
        { "en": "I hope you can come to China one day.", "cn": "我希望有一天你能来中国。", "note": "宾语从句" },
        { "en": "What a wonderful time we will have together!", "cn": "我们一起度过的时光将会多么美好啊！", "note": "what 引导的感叹句" }
      ]
    }
  ],
  "template": [
    "Dear ___, 开头问候句 + 写作目的，用 ___ 留空关键表达",
    "First, ___ / What's more, ___ / Finally, ___ 主体段模板",
    "结尾段模板 + Yours sincerely, Li Hua"
  ],
  "dictationSentences": [
    { "cn": "我认为做运动对我们的健康有好处。", "en": "I think sports are good for our health.", "pattern": "宾语从句" },
    { "cn": "如果我们每天锻炼，我们就会更健康。", "en": "If we do exercise every day, we will be healthier.", "pattern": "if 条件状语从句" }
  ]
}

## 各字段要求
- essay：字符串数组，每个元素一个独立段落。三段式：开头(1-2句)→主体(3-5句)→结尾(1-2句)，**总词数 80-100 词**。每句前标①②③
- analysis：分析体裁、语气、结构和信息点覆盖；genre 为中文体裁名，genreEn 为其常用英文名（如 "Letter of Invitation"/"Letter of Thanks"），用作学案副标题
- vocabSections：按文章结构分为 3 个分区（夺人眼球开头、亮点出彩篇中、韵味无穷结尾），每个分区包含：
  - title：分区名称
  - description：该分区功能简述（1句话）
  - words：6-8 个单个重点单词（必须是单个单词而非短语），优先中考高频话题词和初中范围内的升级替换词（如 good→wonderful、happy→pleased/excited），附中文释义；**禁止**高考味替换词（如 comprehensive、facilitate、anticipation）
  - phrases：8-10 个通用短语，附中文释义
  - sentences：4-5 个高分句式，每个附带完整英文例句、中文翻译、note（初中语法标注，如"宾语从句""if 条件状语从句"）
  - 每个分区内 words/phrases/sentences 的数量都**不得低于上述下限**（供教师筛选后使用）
  - 所有素材词汇必须限于课标三级词汇（约 1600 词）以内，句式限于初中语法范围
- template：字符串数组，每个元素一个段落（开头/主体/结尾），用 ___ 留空关键位置。与 essay 一样分 3 段
- dictationSentences：从范文逐句拆分，每句附带句式名称提示

请严格按照 JSON 格式返回，不要包含任何额外的解释文字。`;
  }

  return `你是一位资深的高中英语写作教学专家，专门辅导高考英语应用文写作。

## 任务
根据用户提供的应用文题目题干，生成一份完整的写作教学学案。

${getLevelRule(level)}

## 范文格式要求（极其重要）

### 段落结构：短-长-短 三段式（高考标准）
- **Paragraph 1（开头段·短）**：1-2 句话，简洁有力。用非谓语、介词短语等紧凑结构交代背景和目的。不要展开细节。
- **Paragraph 2（主体段·长）**：3-5 句话，详细展开。使用衔接词（Firstly/Besides/Moreover）+ 不同高级句式（定语从句、倒装、强调、虚拟、Not only...but also 等），每种句式尽量不重复。充分覆盖题干要点。
- **Paragraph 3（结尾段·短）**：1-2 句话，收束全文。表达总结、评价、希望、邀请或祝愿等内容。

### 数组格式
- essay 是字符串数组，**必须恰好 3 个元素**：essay[0] = Paragraph 1, essay[1] = Paragraph 2, essay[2] = Paragraph 3
- 每句前标序号：①②③...
- **禁止**使用过于简单的句式，如 Let's do...、You can do... 等口语化表达

### 信件格式（按体裁区分，学案导出依赖此格式自动提行）
- **书信体裁**（求助信/建议信/邀请信/感谢信/道歉信/申请信/询问信/推荐信等）：
  - essay[0] 必须以 "Dear 称呼," 开头（写在段首，① 序号放在 Dear 之前），称呼后接正文第一句
  - essay[2] 必须以落款 "Yours sincerely, Li Hua" 结尾（紧接最后一句写在本段末，导出时会自动提行右对齐；若题目给了署名则用题目署名）
- **非书信体裁**（通知、发言稿、新闻报道、倡议书、志愿者招募、海报文案等）：**不要**出现 Dear 称呼，也**不要**任何 Yours/署名落款，直接以正文开头、正文收尾

## 用户题干
${userInput}

## 话题素材原创性要求（极其重要）
- vocabSections 中的 words、phrases、sentences 必须全部重新创作，**严禁摘抄或简单改写范文中已出现的单词、短语和句子**
- 这些素材的定位是"可迁移的万能积累"：学生写同体裁的其他题目时也能直接使用，而不是本题范文的词汇摘录
- 优先选择通用性高、适用面广、脱离本题题干依然成立的经典高分表达；仅适用于本题特定内容的素材不要选
- 注意：dictationSentences 仍然从范文逐句拆分，两者用途不同，不要混淆

## 输出格式
严格的 JSON 对象：

{
  "essay": [
    "① Dear Peter, I'm glad to receive your letter. ② Here are some details about our school's sports activities.",
    "③ Our school boasts excellent sports facilities, including a modern stadium and several basketball courts. ④ A wide range of sports are offered, such as basketball and football. ⑤ Not only do these activities keep us physically fit, but they also help relieve academic stress.",
    "⑥ Personally, I am fond of playing basketball. ⑦ I hope you can come and join me one day. ⑧ Looking forward to your reply. Yours sincerely, Li Hua"
  ],
  "analysis": {
    "genre": "建议信",
    "genreEn": "Letter of Suggestion",
    "tone": "半正式",
    "structure": "开头寒暄-主体展开建议-结尾祝愿",
    "keyPoints": ["要点1", "要点2", "要点3"]
  },
  "vocabSections": [
    {
      "title": "夺人眼球开头",
      "description": "开头段礼貌说明写信目的、交代背景的通用素材",
      "words": [
        { "en": "informed", "cn": "知悉的（be informed of 得知）" },
        { "en": "delighted", "cn": "欣喜的" },
        { "en": "regarding", "cn": "关于" },
        { "en": "scheduled", "cn": "已安排的" },
        { "en": "intended", "cn": "计划的；打算的" },
        { "en": "thrilled", "cn": "非常兴奋的" }
      ],
      "phrases": [
        { "en": "be scheduled to do sth.", "cn": "定于做某事" },
        { "en": "in reply to", "cn": "答复……" },
        { "en": "on behalf of", "cn": "代表……" },
        { "en": "be intended for", "cn": "面向/专为……" },
        { "en": "feel it an honor to do sth.", "cn": "做某事深感荣幸" },
        { "en": "have the privilege of doing", "cn": "有幸做某事" },
        { "en": "with regard to", "cn": "关于……" },
        { "en": "extend a warm welcome to", "cn": "向……表示热烈欢迎" }
      ],
      "sentences": [
        { "en": "I am writing to inquire about the details of the summer camp advertised on your website.", "cn": "我写信咨询您网站上宣传的夏令营的详情。", "note": "不定式作目的状语" },
        { "en": "Learning that you are interested in Chinese culture, I would like to recommend a course to you.", "cn": "得知你对中国文化感兴趣，我想向你推荐一门课程。", "note": "现在分词短语作原因状语" },
        { "en": "On behalf of our school, I feel it an honor to invite you to the coming Art Festival.", "cn": "我谨代表学校，荣幸地邀请您参加即将到来的艺术节。", "note": "介词短语作状语 + 形式宾语" },
        { "en": "I would appreciate it if you could offer me some practical advice on how to prepare for the contest.", "cn": "如果您能就如何备赛给我一些实用建议，我将不胜感激。", "note": "虚拟语气 + 形式宾语" }
      ]
    },
    {
      "title": "亮点出彩篇中",
      "description": "主体段展开说明、论述的通用素材",
      "words": [
        { "en": "comprehensive", "cn": "全面的" },
        { "en": "facilitate", "cn": "促进" },
        { "en": "beneficial", "cn": "有益的" },
        { "en": "available", "cn": "可获得的" },
        { "en": "appealing", "cn": "吸引人的" },
        { "en": "rewarding", "cn": "值得的；有回报的" }
      ],
      "phrases": [
        { "en": "a wide range of", "cn": "各种各样的" },
        { "en": "cater to one's needs", "cn": "满足某人的需求" },
        { "en": "equip sb. with sth.", "cn": "使某人具备……" },
        { "en": "broaden one's horizons", "cn": "开阔视野" },
        { "en": "serve as a platform to do", "cn": "作为……的平台" },
        { "en": "gain a deeper insight into", "cn": "更深入地了解……" }
      ],
      "sentences": [
        { "en": "Not only can the activity broaden our horizons, but it also enriches our after-class life.", "cn": "这次活动不仅能开阔视野，还能丰富课余生活。", "note": "Not only 部分倒装" },
        { "en": "What impresses me most is that every participant can find something to his taste.", "cn": "给我印象最深的是每位参与者都能各取所需。", "note": "主语从句 + 表语从句" }
      ]
    },
    {
      "title": "韵味无穷结尾",
      "description": "结尾段总结、致谢、期待回复的通用素材",
      "words": [
        { "en": "grateful", "cn": "感激的" },
        { "en": "anticipation", "cn": "期待" },
        { "en": "meaningful", "cn": "有意义的" },
        { "en": "fruitful", "cn": "富有成效的" },
        { "en": "memorable", "cn": "难忘的" },
        { "en": "sincere", "cn": "真诚的" }
      ],
      "phrases": [
        { "en": "look forward to doing sth.", "cn": "期待做某事" },
        { "en": "take sth. into consideration", "cn": "把……考虑在内" },
        { "en": "be highly appreciated", "cn": "不胜感激" },
        { "en": "make a difference", "cn": "产生影响" },
        { "en": "at your earliest convenience", "cn": "在您方便的最早时候" },
        { "en": "in return", "cn": "作为回报" }
      ],
      "sentences": [
        { "en": "I would appreciate it if you could take my suggestion into consideration.", "cn": "如果您能考虑我的建议，我将不胜感激。", "note": "虚拟语气" },
        { "en": "Your timely reply will be highly appreciated.", "cn": "如蒙及时回复，将不胜感激。", "note": "被动语态" }
      ]
    }
  ],
  "template": [
    "Dear ___, 开头寒暄句，用 ___ 留空关键表达",
    "主体段模板，用衔接词 + 句型框架 + ___ 留空",
    "结尾段模板，Yours sincerely, Li Hua"
  ],
  "dictationSentences": [
    { "cn": "对我们来说立即采取行动是必要的。", "en": "It is essential for us to take immediate action.", "pattern": "形式主语句" }
  ]
}

## 各字段要求
- essay：字符串数组，每个元素一个独立段落。短-长-短三段式：开头(1-2句)→主体(3-5句)→结尾(1-2句)。每句前标①②③
- analysis：分析体裁、语气、结构和信息点覆盖；genre 为中文体裁名，genreEn 为其常用英文名（如 "Letter of Invitation"/"Letter of Request"），用作学案副标题
- vocabSections：按文章结构分为 3 个分区（夺人眼球开头、亮点出彩篇中、韵味无穷结尾），每个分区包含：
  - title：分区名称
  - description：该分区功能简述（1句话）
  - words：6-8 个单个高分单词（必须是单个单词而非短语），优先话题核心词和高级替换词，附中文释义
  - phrases：8-10 个通用短语，附中文释义
  - sentences：4-5 个高分句式，每个附带完整英文例句、中文翻译、note（语法标注）
  - 每个分区内 words/phrases/sentences 的数量都**不得低于上述下限**（供教师筛选后使用）
- template：字符串数组，每个元素一个段落（开头/主体/结尾），用 ___ 留空关键位置。与 essay 一样分 3 段
- dictationSentences：从范文逐句拆分，每句附带句式名称提示

请严格按照 JSON 格式返回，不要包含任何额外的解释文字。`;
}

// ─── 读后续写助手 Prompt ───────────────────────────

function getContLevelRule(level: WritingLevel): string {
  switch (level) {
    case 'basic':
      return `## 质量层次：基础级
- 情节上能合理承接前文，逻辑通顺即可
- 句式以简单句和并列句为主，语法正确
- 动作、情绪描写使用基础的形容词和副词即可
- 不需要复杂的描写句式，但要保证无语法错误
- 适合需要保底分数（15-18分/25分）的学生`;
    case 'formula':
      return `## 质量层次：套路级
- **大量使用**读后续写高分描写句式，越丰富越好：
  - 动作描写公式：主+谓, doing sth / Doing sth, 主+谓+独立主格 / 主+谓1,谓2 and 谓3+with复合结构
  - 情绪描写公式：A feeling of + 情绪名词 + washed over sb / 情绪形容词1 and 情绪形容词2, 主+谓 / A wave of + 情绪名词 + swept over sb
  - 语言描写公式：sb said excitedly/sadly, "..." / sb replied in high/low spirits
  - 主题升华句型：强调句、倒装句、It dawned on sb that...、sb came to realize that...
  - 非谓语作状语、with复合结构、独立主格、形容词作状语
- 这些描写句式的密集使用是得分关键
- 适合冲刺高分（20-23分/25分）的学生`;
    case 'advanced':
      return `## 质量层次：拔高级
- 语言**地道自然**，叙事流畅，不堆砌套路句式
- 情感推进细腻，通过细节和环境烘托而非直接陈述情绪
- 可以适当使用一些超出高中套路的自然表达
- 情节设计更有层次感和文学性
- ⚠️ 不适用于高考备考，适合培养真实英语写作能力（23-25分/25分）`;
  }
}

export function buildContinuationWritingPrompt(userInput: string, continuationHints: string, level: WritingLevel = 'formula'): string {
  return `你是一位资深的高中英语写作教学专家，专门辅导高考英语读后续写。

## 任务
根据用户提供的读后续写前文（含两段续写段落的首句），生成一份完整的续写教学学案。

${getContLevelRule(level)}

## 前文内容
${userInput}

${continuationHints ? `## 题干补充\n${continuationHints}` : ''}

## 输出格式
严格的 JSON 对象：

{
  "continuation": {
    "paragraph1": "续写第一段（承接原文+第一段首句，约75词）",
    "paragraph2": "续写第二段（承接第一段+第二段首句，约75词）"
  },
  "characterAnalysis": {
    "characters": [
      { "name": "人物名", "traits": ["性格词1", "性格词2"], "role": "角色（主角/配角/反派等）" }
    ],
    "relationships": "人物关系概述（1-2句话）"
  },
  "conflictAnalysis": {
    "mainConflict": "故事的主要矛盾（1句话概括）",
    "emotionalArc": "情感弧线，从何种情绪到何种情绪",
    "turningPoint": "故事的转折点在哪里"
  },
  "tenSentenceMethod": {
    "overview": "整体构思概述：读完前文后，情节走向如何设计，情感脉络如何推进（2-3句）",
    "paragraph1": {
      "sentence1": { "en": "衔接原文最后一句的过渡句", "function": "衔接上文" },
      "sentence2": { "en": "描写句（动作/神情/心理/语言/环境）", "function": "动作描写" },
      "sentence3": { "en": "描写句（动作/神情/心理/语言/环境）", "function": "心理描写" },
      "sentence4": { "en": "描写句（动作/神情/心理/语言/环境）", "function": "环境描写" },
      "sentence5": { "en": "为第二段做铺垫的句子", "function": "衔接后文" }
    },
    "paragraph2": {
      "sentence6": { "en": "承接第一段结尾的过渡句", "function": "衔接上文" },
      "sentence7": { "en": "描写句（动作/神情/心理/语言/环境）", "function": "动作描写" },
      "sentence8": { "en": "描写句（动作/神情/心理/语言/环境）", "function": "语言描写" },
      "sentence9": { "en": "故事结局", "function": "故事结局" },
      "sentence10": { "en": "主旨升华/点题/感悟", "function": "主旨升华" }
    }
  },
  "commonPatterns": [
    {
      "category": "动作描写",
      "patterns": [
        { "formula": "主+谓, doing sth  /  Doing sth, 主+谓, 独立主格", "example": "Grinning from ear to ear, she rushed into the room, heart beating wildly.", "cn": "她咧着嘴笑着冲进房间，心脏狂跳。", "note": "现在分词作伴随状语+独立主格" },
        { "formula": "主+谓1, 谓2 and 谓3 + with复合结构", "example": "He rose from his chair, walked to the window and peered out with a puzzled look on his face.", "cn": "他从椅子上站起来，走到窗边，一脸困惑地向外看。", "note": "with复合结构" }
      ]
    },
    {
      "category": "情绪描写",
      "patterns": [
        { "formula": "A feeling of + 情绪名词 + washed over sb", "example": "A feeling of joy washed over her when seeing her favorite pet.", "cn": "看到她心爱的宠物时，一股喜悦感涌上她的心头。", "note": "无灵主语句" },
        { "formula": "情绪形容词1 and 情绪形容词2, 主语+谓语, doing sth", "example": "Happy and excited, she jumped up and down, clapping her hands.", "cn": "她又高兴又兴奋，跳上跳下拍着手。", "note": "形容词作状语" }
      ]
    },
    {
      "category": "语言描写",
      "patterns": [
        { "formula": "sb said excitedly/sadly/surprisingly, '...'", "example": "He said surprisingly, 'Is that true?'", "cn": "他惊讶地说：'这是真的吗？'", "note": "副词修饰对话" }
      ]
    },
    {
      "category": "主题升华",
      "patterns": [
        { "formula": "It was... that...（强调句）", "example": "It was the firm belief in dreams that enabled him to overcome all the obstacles.", "cn": "正是对梦想的坚定信念使他克服了所有障碍。", "note": "强调句" },
        { "formula": "It dawned on sb that... / sb came to realize that...", "example": "It dawned on me that a small act of kindness may make a huge difference.", "cn": "我突然明白，一个小小的善举可能带来巨大的改变。", "note": "主旨升华句式" }
      ]
    }
  ],
  "dictationSentences": [
    { "cn": "从 commonPatterns 例句或续写范文中选取的中文句子", "en": "对应英文" }
  ]
}

## 十句五定法说明
- 两个段落共 12 句话，除去给出的开头，答题者写10句话，每段 5 句
- **五定**：5 个固定叙事功能位置（句1/5/6/9/10）句1承接续写第一段第一句，句5引出续写第二段第一句，句6承接续写第二段第一句，句9为故事结局，句10为主旨升华句
- 其余 5 句为描写过渡句，选择动作/神情/心理/语言/环境 5 类，尽量不重复类型，但可以一句中包含两个要素

## 句式分类规则（重要）
- commonPatterns 必须分为 5 个分类：动作描写、情绪描写、语言描写、环境描写、主题升华，或者前5类的组合如：情绪+动作描写
- 每个分类 2-4 个公式
- **例句必须从你自己写的续写范文中选取**，不能使用泛泛的套话例句
- formula 是该句式的模板公式（中文描述+英文模板），example 是从范文摘取的具体句子
- note 标注语法结构名称（如"独立主格""强调句""with复合结构"）

## 篇幅要求（极其重要）
- **每段必须至少 75 词**，不能少于此值。高考读后续写评分标准中篇幅不足会直接扣分
- 请写完后自己数一下每段词数，确保第一段 ≥ 75 词，第二段 ≥ 75 词
- 可以通过增加环境描写、心理活动、动作细节来充实篇幅
- 两段合计应在 150-170 词左右

## 要求
- continuation：情节合理承接前文，**每段至少 75 词**
- characterAnalysis：准确提炼原文人物，性格词用中文
- tenSentenceMethod：十句骨架英文句子 15-25 词，连贯流畅
- commonPatterns：4 个分类，每类 2-4 个公式，例句来自范文
- dictationSentences：从 commonPatterns 和范文选取 8-10 句

请严格按照 JSON 格式返回，不要包含任何额外的解释文字。`;
}

// ─── M1 块级重新生成 ────────────────────────────────

/**
 * 段落级「换一个」（R1）：重写目标段落 + 同步刷新整篇的分句默写，单次调用返回。
 * fullEssay 用于让模型把握全文语境，currentDictation 用于在原文基础上增删改。
 */
export function buildParagraphRewritePrompt(opts: {
  paragraph: string;
  /** 目标段落在全文中的序号（1 起） */
  index: number;
  fullEssay: string[];
  context: string;
  levelLabel: string;
  currentDictation: { cn: string; en: string }[];
}): string {
  return `下面是一篇英语作文的全部段落。请只重写【第${opts.index}段】，并同步更新分句默写：
- 第${opts.index}段：保持功能、主题、人称与时态框架不变，用不同的词汇和句式重新表达，与原文同等水平（${opts.levelLabel}），长度与原段相当
- 其他段落原样保留
- 分句默写：基于重写后的全文重新给出 5-8 个「中文句子 → 英文句子」的默写条目，覆盖全文关键句式（英文句中的目标词不用加粗）
- 上下文参考：${opts.context || '（无）'}

全文段落：
${opts.fullEssay.map((p, i) => `【第${i + 1}段】\n${p}`).join('\n\n')}

当前分句默写：
${opts.currentDictation.map((d) => `- ${d.cn} → ${d.en}`).join('\n') || '（无）'}

返回严格 JSON：
{ "paragraph": "重写后的第${opts.index}段英文段落", "dictationSentences": [{ "cn": "中文句子", "en": "English sentence" }] }`;
}

/** 整篇范文「换难度重写」（R1）：全部段落 + 分句默写一次重出。 */
export function buildEssayLevelRewritePrompt(opts: {
  paragraphs: string[];
  context: string;
  levelRule: string;
  levelLabel: string;
  currentDictation: { cn: string; en: string }[];
}): string {
  return `请把下面的英语范文整体重写为「${opts.levelLabel}」水平，并同步更新分句默写：
${opts.levelRule}
- 保持段落数量与每段的功能不变，逐段对应重写
- 分句默写：基于重写后的全文给出 5-8 个「中文 → 英文」默写条目，覆盖全文关键句式
- 题材与要点上下文：${opts.context || '（无）'}

原文各段（按顺序）：
${opts.paragraphs.map((p, i) => `【第${i + 1}段】\n${p}`).join('\n\n')}

当前分句默写：
${opts.currentDictation.map((d) => `- ${d.cn} → ${d.en}`).join('\n') || '（无）'}

返回严格 JSON：
{ "paragraphs": ["第1段", "第2段", ...], "dictationSentences": [{ "cn": "中文句子", "en": "English sentence" }] }，段数必须与原文一致。`;
}

/** 段落改写系统提示（M1「换一个」共用）。 */
export const PARAGRAPH_REWRITE_SYSTEM = '你是一位中国中学英语教学专家，擅长用准确、地道的英语改写教学范文段落。只输出 JSON，不要输出任何其他内容。';

/** 整篇重写系统提示（M1「换层次重写」共用）。 */
export const ESSAY_REWRITE_SYSTEM = '你是一位中国中学英语教学专家，擅长按指定难度层次重写英语教学范文。只输出 JSON，不要输出任何其他内容。';

// ─── M4 难度自检 ────────────────────────────────────

export const LEVEL_CHECK_SYSTEM = `你是一位熟悉中国中学英语课标的教学专家。请检查给定英语范文是否匹配指定学段要求：
- 高中：高考 3500 词范围，可合理使用非谓语/定语从句/倒装等
- 初中：义务教育课标三级词汇（约1600词），禁用非谓语作状语、倒装、虚拟语气、独立主格、with 复合结构、强调句
返回严格 JSON：
{ "verdict": "ok" 或 "warn", "summary": "一句话总评（中文，30字内）", "warnings": ["超纲词/语法点：说明（位置）", "..."] }
warnings 每条指出具体超纲点并给出更简单的替换建议；完全匹配时 warnings 为空数组。`;

export function buildLevelCheckPrompt(opts: { stage: Stage; promptText: string; paragraphs: string[] }): string {
  const stageReq = opts.stage === 'junior' ? '初中（中考）' : '高中（高考）';
  return `目标学段：${stageReq}
题目/题干：${opts.promptText.slice(0, 300) || '（无）'}

范文：
${opts.paragraphs.join('\n\n')}

请按系统要求返回 JSON。`;
}
