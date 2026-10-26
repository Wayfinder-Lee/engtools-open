export type VocabSource = 'main_idea' | 'evidence' | 'question_stem' | 'option' | 'custom';

/** 词汇等级 */
export type VocabLevel = 'basic' | 'core' | 'extended' | 'advanced';

/** 每段选词量 */
export type WordLevel = 'fewer' | 'moderate' | 'more';

export const WORD_LEVELS: { value: WordLevel; label: string }[] = [
  { value: 'fewer', label: '更少选词' },
  { value: 'moderate', label: '适中选词' },
  { value: 'more', label: '更多选词' },
];

/** 词汇等级配置（按学段取用：getVocabLevels(stage)） */
export const VOCAB_LEVELS: { value: VocabLevel; label: string; description: string }[] = [
  {
    value: 'basic',
    label: '基础级',
    description: '课标必修词汇，高考底线要求。适合基础薄弱、及格边缘的学生（90分以下）',
  },
  {
    value: 'core',
    label: '核心级',
    description: '高考高频核心词，完形/阅读重点考察对象。适合中等层次学生（90–120分）',
  },
  {
    value: 'extended',
    label: '拓展级',
    description: '真题中的进阶词汇，四级过渡词。适合中上层次学生（120–135分）',
  },
  {
    value: 'advanced',
    label: '拔高级',
    description: '高分冲刺词汇，含熟词生义和学术表达。适合追求高分的学生（135分以上）',
  },
];

/** 初中（中考）词汇等级：锚定《义务教育英语课程标准（2022年版）》三级词汇（约1600词） */
export const VOCAB_LEVELS_JUNIOR: { value: VocabLevel; label: string; description: string }[] = [
  {
    value: 'basic',
    label: '基础级',
    description: '课标三级以内基础词（七、八年级核心词），中考底线要求。适合基础薄弱、及格边缘的学生',
  },
  {
    value: 'core',
    label: '核心级',
    description: '中考高频核心词，完形/阅读重点考查对象。适合中等层次的学生',
  },
  {
    value: 'extended',
    label: '拓展级',
    description: '中考真题中的进阶词汇和重点短语。适合中上层次、冲刺高分的学生',
  },
  {
    value: 'advanced',
    label: '拔高级',
    description: '高分冲刺词汇，含熟词生义、易混词辨析和少量初高中衔接词。适合冲刺满分的学生',
  },
];

/** 按学段取词汇等级配置 */
export function getVocabLevels(stage: Stage) {
  return stage === 'junior' ? VOCAB_LEVELS_JUNIOR : VOCAB_LEVELS;
}

/** 提取选项 */
export interface ExtractionOptions {
  level: VocabLevel;
  count: number;
}

/** 单条词汇条目 */
export interface VocabItem {
  id: number;
  word: string;
  phonetic: string;
  partOfSpeech: string;
  /** 双语释义：中文在前，英文在后，如「措施，方法｜an action taken to achieve an effect」 */
  definition: string;
  /** 文中原句，重点单词加粗（**word**），含中文翻译 */
  originalSentence: string;
  source: VocabSource;
  sourceLabel: string;
  /** 常用搭配 */
  collocations: string;
  /** 额外例句，重点单词加粗（**word**），含中文翻译 */
  extraExample: string;
  /** 辅助记忆：词根词缀、谐音联想、构词分解、故事记忆等灵活方式 */
  memoryAid: string;
  /** 高考频次：★ 星级表示，如 ★★★★☆，含简短文字说明 */
  examFrequency: string;
  /** 是否为高考考纲要求拼写的词汇（false 则表示仅需认读，默写时只要求写出中文意思） */
  spellingRequired?: boolean;
  /** 题目来源段落，如 "阅读理解A"、"完形填空"、"语法填空" 等 */
  sectionName?: string;
}

/** 可选字段开关 */
export interface FieldSelection {
  /** 音标 */
  phonetic: boolean;
  /** 词性+双语释义 */
  definition: boolean;
  /** 常用搭配 */
  collocations: boolean;
  /** 辅助记忆 */
  memoryAid: boolean;
  /** 高考频次（星级） */
  examFrequency: boolean;
  /** 文中原句 */
  originalSentence: boolean;
  /** 额外例句 */
  extraExample: boolean;
}

export const DEFAULT_FIELD_SELECTION: FieldSelection = {
  phonetic: true,
  definition: true,
  collocations: false,
  memoryAid: false,
  examFrequency: false,
  originalSentence: false,
  extraExample: false,
};

/** API 配置 */
export interface ApiConfig {
  endpoint: string;
  apiKey: string;
}

/** 登录会话（后端签发） */
/** 学段：高中（高考）/ 初中（中考）。初中模式下隐藏读后续写，所有 prompt 按中考标准生成 */
export type Stage = 'senior' | 'junior';

/** 主题偏好：显式亮/暗，或跟随系统（默认） */
export type ThemePreference = 'light' | 'dark' | 'system';

/** 学段切换选项 */
export const STAGE_OPTIONS: { value: Stage; label: string }[] = [
  { value: 'junior', label: '初中' },
  { value: 'senior', label: '高中' },
];

export interface Session {
  /** JWT */
  token: string;
  /** 用户邮箱 */
  email: string;
  /** 当前剩余额度（快照，可能滞后于服务端） */
  quota: number;
  /** M6 免验证注册后为 false：验证邮箱后才解锁兑换与正式赠送额度（旧会话缺省视为 true） */
  emailVerified: boolean;
}

// ─── 模型选择（各模块独立）───────────────────────

/** 可用模型选项 */
export const MODEL_OPTIONS = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'qwen-plus', label: 'Qwen Plus' },
  { value: 'gpt-4o', label: 'GPT-4o' },
] as const;

/** 词汇提取模块默认模型 */
export const VOCAB_DEFAULT_MODEL = 'gemini-2.5-flash';

/** 写作模块（应用文 + 读后续写）默认模型 */
export const WRITING_DEFAULT_MODEL = 'gemini-3.5-flash';

/** 语法填空条目 */
export interface ClozeItem {
  /** 题干（含 ______ 留空） */
  sentence: string;
  /** 提示词（括号中的原形） */
  hint: string;
  /** 正确答案 */
  answer: string;
}

/** LLM 返回的原始结构（提取结果外层） */
export interface ExtractionResult {
  vocabularies: VocabItem[];
}

/** Docx 导出板块选择 */
export interface DocxExportOptions {
  selfTest: boolean;
  vocabTable: boolean;
  cloze: boolean;
  wordList: boolean;
  dictation: boolean;
  /** M2：教师卷（含答案）/ 学生卷（语法填空不含参考答案） */
  variant?: 'teacher' | 'student';
  /** M2：紧凑模式（字号 86% + 收紧页边距，页数预估更少） */
  compact?: boolean;
}

export const DEFAULT_DOCX_OPTIONS: DocxExportOptions = {
  selfTest: false,
  vocabTable: false,
  cloze: false,
  wordList: true,
  dictation: true,
  variant: 'teacher',
  compact: false,
};

// ─── 应用文助手类型 ────────────────────────────────

/** 话题词汇与句式分区 */
export interface VocabSection {
  /** 分区标题，如 "夺人眼球开头" */
  title: string;
  /** 分区简述，如 "简述活动的时间、地点、人物和事件" */
  description: string;
  /** 单词列表（单个高分/话题单词）。旧数据可能缺失，使用时须 ?? [] */
  words?: { en: string; cn: string; selected?: boolean }[];
  /** 短语列表；selected=false 表示教师取消勾选，导出 Docx 时排除 */
  phrases: { en: string; cn: string; selected?: boolean }[];
  /** 句式列表，note 为语法标注（如"过去分词短语作目的状语"）；selected=false 同上 */
  sentences: { en: string; cn: string; note?: string; selected?: boolean }[];
}

export interface PracticalWritingResult {
  /** 范文段落数组 */
  essay: string[];
  analysis: {
    genre: string;
    /** 体裁常用英文名，用作学案副标题，如 "Letter of Request"；旧数据可能缺失 */
    genreEn?: string;
    tone: string;
    structure: string;
    keyPoints: string[];
  };
  /** 话题词汇与句式（分区组织） */
  vocabSections: VocabSection[];
  /** 写作模板段落数组 */
  template: string[];
  dictationSentences: { cn: string; en: string; pattern?: string }[];
}

/** 写作质量层次 */
export type WritingLevel = 'basic' | 'formula' | 'advanced';

/** 应用文写作层次（高中） */
export const PW_LEVELS: { value: WritingLevel; label: string; description: string }[] = [
  { value: 'basic', label: '基础级', description: '句式正确、结构清晰、要点齐全。以语法正确和覆盖要点为主，不追求复杂句式。适合需要保底的学生（8-11分/15分）' },
  { value: 'formula', label: '套路级', description: '大量使用高分句式（非谓语、定语从句、倒装、强调、It句式等），表达丰富多样。以密集的高级句式为得分手段。适合冲刺高分的学生（12-14分/15分）' },
  { value: 'advanced', label: '拔高级', description: '以地道自然的表达为主，语言贴切流畅，不堆砌套路。注重语感和文笔，适合培养真实写作能力。⚠️ 不适用于高考备考' },
];

/** 应用文写作层次（初中·中考书面表达） */
export const PW_LEVELS_JUNIOR: { value: WritingLevel; label: string; description: string }[] = [
  { value: 'basic', label: '基础级', description: '简单句+并列句为主体，时态限一般现在/过去/将来，连接词用 and/but/so/because/first/then/finally。要点全覆盖、零语法错误（目标 7-12 分/15 分）' },
  { value: 'formula', label: '套路级', description: '三段式+分体裁公式句，1-2 处宾语从句、It is adj. to do、状语从句等亮点句式 2-4 处，定语从句最多 1 处。准确度优先（目标 13-15 分/15 分）' },
  { value: 'advanced', label: '拔高级', description: '在套路级之上叠加 2-4 处亮点（感叹句、被动、限定性定从、the more...the more），配 however/therefore 等高分连接词，细节扩展+情感升华（一档顶格 14-15 分/15 分）' },
];

/** 按学段取应用文写作层次 */
export function getPwLevels(stage: Stage) {
  return stage === 'junior' ? PW_LEVELS_JUNIOR : PW_LEVELS;
}

/** 读后续写层次 */
export const CW_LEVELS: { value: WritingLevel; label: string; description: string }[] = [
  { value: 'basic', label: '基础级', description: '情节合理承接前文，句式以简单句和并列句为主，语法正确。描写使用基础词汇即可。适合需要保底的学生（15-18分/25分）' },
  { value: 'formula', label: '套路级', description: '大量使用读后续写高分描写句式（动作/情绪/语言描写公式、非谓语、独立主格、with结构、强调倒装、主题升华句型）。描写句式的密集使用是得分关键。适合冲刺高分的学生（20-23分/25分）' },
  { value: 'advanced', label: '拔高级', description: '语言地道自然，叙事流畅，情感推进细腻。不堆砌套路句式，通过细节和环境烘托情绪。情节有层次感和文学性，适合培养真实写作能力。⚠️ 不适用于高考备考' },
];

// ─── 读后续写助手类型 ──────────────────────────────

export interface ContinuationWritingResult {
  continuation: {
    paragraph1: string;
    paragraph2: string;
  };
  characterAnalysis: {
    characters: { name: string; traits: string[]; role: string }[];
    relationships: string;
  };
  conflictAnalysis: {
    mainConflict: string;
    emotionalArc: string;
    turningPoint: string;
  };
  tenSentenceMethod: {
    overview: string;
    paragraph1: {
      sentence1: { en: string; function: string };
      sentence2: { en: string; function: string };
      sentence3: { en: string; function: string };
      sentence4: { en: string; function: string };
      sentence5: { en: string; function: string };
    };
    paragraph2: {
      sentence6: { en: string; function: string };
      sentence7: { en: string; function: string };
      sentence8: { en: string; function: string };
      sentence9: { en: string; function: string };
      sentence10: { en: string; function: string };
    };
  };
  commonPatterns: PatternCategory[];
  dictationSentences: { cn: string; en: string }[];
}

/** 读后续写句式分类 */
export interface PatternCategory {
  /** 分类名，如 "动作描写" "情绪描写" "语言描写" "主题升华" */
  category: string;
  patterns: {
    /** 公式模板 */
    formula: string;
    /** 从续写范文中选取的例句 */
    example: string;
    /** 中文翻译 */
    cn: string;
    /** 语法标注，如"独立主格""强调句" */
    note?: string;
  }[];
}

/** LLM 返回的语法填空结果 */
export interface ClozeResult {
  items: ClozeItem[];
}

// ─── 书面表达个性化学案类型 ──────────────────────────

/** 作文类型 */
export type EssayType = 'practical' | 'continuation';

export const ESSAY_TYPES: { value: EssayType; label: string }[] = [
  { value: 'practical', label: '应用文写作' },
  { value: 'continuation', label: '读后续写' },
];

/** 作文类型的学段叫法：初中书面表达（应用文），高中应用文写作/读后续写 */
export function getEssayTypeLabel(stage: Stage, essayType: EssayType): string {
  if (stage === 'junior' && essayType === 'practical') return '书面表达（应用文）';
  return ESSAY_TYPES.find((t) => t.value === essayType)?.label ?? '应用文写作';
}

/** 年级（学段内取用：GRADE_LEVELS[stage]） */
export type GradeLevel = '初一' | '初二' | '初三' | '高一' | '高二' | '高三';

export const GRADE_LEVELS: Record<Stage, GradeLevel[]> = {
  junior: ['初一', '初二', '初三'],
  senior: ['高一', '高二', '高三'],
};

/** 学段默认年级（毕业班） */
export function defaultGradeLevel(stage: Stage): GradeLevel {
  return stage === 'junior' ? '初三' : '高三';
}

/** 词汇清单/默写清单的段落排序（VocabTable 与 docxExport 共用，勿在组件内重复定义） */
export function getSectionOrder(stage: Stage): string[] {
  return stage === 'junior'
    ? ['听力理解', '情景交际', '单项选择', '完形填空', '阅读理解A', '阅读理解B', '阅读理解C', '阅读理解D', '阅读理解', '任务型阅读', '语法填空', '短文填空', '选词填空', '综合填空', '词汇运用', '完成句子', '书面表达']
    : ['听力理解', '阅读理解A', '阅读理解B', '阅读理解C', '阅读理解D', '七选五', '完形填空', '语法填空', '读后续写'];
}

/** 个性化学案生成结果（9 大模块 + 审题分析） */
export interface HandwritingWorksheetResult {
  studentName: string;
  /** 审题分析：是否偏题、要点覆盖情况 */
  promptAnalysis: {
    isOffTopic: boolean;
    offTopicDetail: string;
    coveredPoints: string[];
    missedPoints: string[];
    overallComment: string;
  };
  /** 一、作文总评（含评分） */
  overallComment: string;
  /** 参考分数（应用文1-15，读后续写1-25） */
  score?: number;
  /** 满分 */
  maxScore?: number;
  /** 评分维度分解（先分维度后总分的产物；旧存档无此字段，消费端须判空） */
  scoreBreakdown?: ScoreBreakdown;
  /** 读后续写专项分析（仅 essayType='continuation' 时有值） */
  continuationAnalysis?: {
    /** 第二段续写是否衔接了给出的段首句 */
    p1ConnectsToOpening: boolean;
    /** 第一段末尾是否能自然过渡到第二段段首句 */
    p1EndConnectsToP2: boolean;
    /** 文章末尾是否有主旨升华 / 主题点题 */
    hasThemeHighlight: boolean;
    /** 学生是否只写了 2 段（没有自行额外分段） */
    onlyTwoParagraphs: boolean;
    /** 续写分析详细说明（2-3 句） */
    detail: string;
    /** 描写多样性分析 */
    descriptionDiversity: {
      action: boolean;
      dialogue: boolean;
      emotion: boolean;
      environment: boolean;
      comment: string;
    };
  };
  /** 二、错误分类诊断 */
  errorDiagnosis: {
    grammar: { original: string; corrected: string; explanation: string }[];
    vocabulary: { original: string; suggestion: string; explanation: string }[];
    sentence: { original: string; improvement: string; explanation: string }[];
    logic: { issue: string; explanation: string }[];
  };
  /** 三、重点语法突破（仅规则讲解，不含练习） */
  grammarBreakthrough: {
    rules: { title: string; explanation: string; examples: { en: string; cn: string }[] }[];
  };
  /** 四、词汇升级训练（仅升级对照，无造句练习） */
  vocabularyUpgrade: {
    items: { original: string; upgrades: { word: string; context: string }[] }[];
  };
  /** 五、句式提升工坊（仅句子改写展示，无仿写练习） */
  sentenceImprovement: {
    items: { original: string; analysis: string; improved: string; highlights: string }[];
  };
  /** 六、范文升级版（应用文 string / 读后续写 table） */
  modelEssay: string | ModelEssayTable;
  /** 七、巩固练习（范文默写：中文翻译 + 句式提示 → 英文） */
  consolidationExercises: { cn: string; pattern: string; en: string }[];
}

/** 评分维度分解：内容 / 语言 / 衔接（结构）。读后续写 10+10+5，应用文与书面表达 6+6+3 */
export interface ScoreBreakdown {
  content: number;
  language: number;
  cohesion: number;
}

/** 个性化学案评分维度满分（types 单一真源，UI 展示与 normalize 钳制共用） */
export function getScoreDimensions(essayType: EssayType) {
  return essayType === 'continuation'
    ? { content: 10, language: 10, cohesion: 5, total: 25 }
    : { content: 6, language: 6, cohesion: 3, total: 15 };
}

/** 第三维度的展示名（续写=衔接，应用文/书面表达=结构）；讲评报告各出口共用，防口径漂移 */
export function getCohesionLabel(essayType: EssayType): string {
  return essayType === 'continuation' ? '衔接' : '结构';
}

/** 维度分展示行（续写「衔接 x/5」/ 应用文「结构 x/3」）；breakdown 缺失或 maxScore 非 15/25（老师自改分制）时返回 null */
export function formatScoreBreakdown(r: Pick<HandwritingWorksheetResult, 'scoreBreakdown' | 'maxScore'>): string | null {
  const b = r.scoreBreakdown;
  if (!b) return null;
  if (r.maxScore === 25) return `内容 ${b.content}/10 · 语言 ${b.language}/10 · 衔接 ${b.cohesion}/5`;
  if (r.maxScore === 15) return `内容 ${b.content}/6 · 语言 ${b.language}/6 · 结构 ${b.cohesion}/3`;
  return null;
}

/** 五档区间表（bandOf 档位徽章与班级讲评报告统计共用的单一真源）。
 *  返回顺序下标 0=五档（最高，如 25 分制 21-25）… 4=一档（最低）；非 15/25 分制返回 null */
export function getBandRanges(maxScore: number | undefined): [number, number][] | null {
  if (maxScore === 25) return [[21, 25], [16, 20], [11, 15], [6, 10], [1, 5]];
  if (maxScore === 15) return [[13, 15], [10, 12], [7, 9], [4, 6], [1, 3]];
  return null;
}

/** 档位下标（0=五档 … 4=一档）；非 15/25 分制或分数越界返回 null */
export function bandIndexOf(maxScore: number | undefined, score: number): number | null {
  const bands = getBandRanges(maxScore);
  if (!bands) return null;
  const idx = bands.findIndex(([lo, hi]) => score >= lo && score <= hi);
  return idx >= 0 ? idx : null;
}

/** 范文升级版表格中的单个句子（读后续写） */
export interface ModelEssaySentence {
  /** 英文句子（不含【xxx】批注） */
  sentence: string;
  /** 功能 + 技法批注，如 "动作描写（现在分词作状语）"、"主旨升华（Not until 倒装句）" */
  function: string;
}

/** 范文升级版表格（读后续写），分两段，不含题目给出的段首句 */
export interface ModelEssayTable {
  paragraph1: ModelEssaySentence[];
  paragraph2: ModelEssaySentence[];
}

/** 判断范文是否为表格结构（读后续写） */
export function isModelEssayTable(v: HandwritingWorksheetResult['modelEssay']): v is ModelEssayTable {
  return typeof v === 'object' && v !== null && Array.isArray((v as ModelEssayTable).paragraph1) && Array.isArray((v as ModelEssayTable).paragraph2);
}

/** 学案生成默认模型 */
export const WORKSHEET_DEFAULT_MODEL = 'gemini-2.5-flash';

/** 手写 OCR 识别模型选项（需要视觉能力） */
export const OCR_MODEL_OPTIONS = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash（推荐）' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'qwen-vl-max', label: 'Qwen VL Max' },
  { value: 'qwen-vl-plus', label: 'Qwen VL Plus' },
] as const;

export const OCR_DEFAULT_MODEL = 'gemini-2.5-flash';

/** 续写题目摘要 */
export interface PromptSummary {
  summary: string;
  opening1: string;
  opening2: string;
}

/** 学案打印设置 */
export interface PrintSettings {
  title: string;
  subtitle: string;
}

export function defaultPrintSettings(essayTypeLabel: string): PrintSettings {
  return {
    title: '个性化书面表达提升学案',
    subtitle: `———  ${essayTypeLabel}  ———`,
  };
}

// ─── 保存/历史系统 ──────────────────────────────────

export type ModuleKey = 'vocab' | 'practical' | 'continuation' | 'handwriting' | 'copybook' | 'exampaper';

export interface SavedItem<T> {
  id: string;
  name: string;
  /** LLM 生成的存档标题（免费辅助 op auto_title），显示在 name 之后；旧记录无此字段 */
  autoTitle?: string;
  savedAt: string;
  data: T;
}

export const MODULE_LABELS: Record<ModuleKey, string> = {
  vocab: '词汇提取',
  practical: '应用文学案',
  continuation: '读后续写学案',
  handwriting: '书面表达个性化学案',
  copybook: '衡水体字帖',
  exampaper: '试卷排版助手',
};

/** Per-module save state types */

export interface VocabState {
  inputText: string;
  level: VocabLevel;
  fieldSelection: FieldSelection;
  vocabList: VocabItem[] | null;
  model: string;
}

export interface PracticalState {
  prompt: string;
  level: WritingLevel;
  result: PracticalWritingResult | null;
  model: string;
  /** R4：生成要求补充（可选），旧数据缺失 */
  extraReq?: string;
}

export interface ContinuationState {
  text: string;
  hints: string;
  level: WritingLevel;
  result: ContinuationWritingResult | null;
  model: string;
}

/** HandwritingWorksheet student snapshot (no imageDataUrl) */
export interface StudentSnapshot {
  id: string;
  filename: string;
  studentName: string;
  ocrText: string;
  ocrError?: string;
  result: HandwritingWorksheetResult | null;
  genError?: string;
}

export interface HandwritingState {
  essayType: EssayType;
  essayPrompt: string;
  gradeLevel: GradeLevel;
  printSettings: PrintSettings;
  students: StudentSnapshot[];
  promptSummary?: PromptSummary | null;
  /** 班级讲评报告快照（2026-10 新增）；旧存档缺失 → 恢复时置 null */
  classReport?: ClassFeedbackReport | null;
}

// ─── 班级讲评报告（个性化学案 ④ 讲评报告）──────────────

/** 共性问题错例：来自真实学生原文；展示规则 = 匿名（「有同学写道…」，绝不出现姓名） */
export interface ClassReportExample {
  /** 学生原句（英文，含错误） */
  quote: string;
  /** 修正 / 改进后的句子 */
  corrected: string;
  /** 一句话点评（中文） */
  note: string;
}

/** 共性问题（LLM 生成，3-6 条，按频次×严重度降序） */
export interface ClassReportProblem {
  /** 问题标题（中文短语，如「一般过去时动词未变形」） */
  title: string;
  /** 现象 + 影响 + 频次依据（2-4 句中文，须与客观统计口径一致） */
  description: string;
  severity: 'high' | 'medium' | 'low';
  /** 1-3 条真实学生例句（匿名） */
  examples: ClassReportExample[];
}

/** 亮点展示：高分学生原文好句 + 具名点评（表扬允许点名） */
export interface ClassReportHighlight {
  studentName: string;
  /** 引用的学生原句（英文，须为原文逐字摘录） */
  sentence: string;
  /** 好在哪里 + 可迁移的技法（1-2 句中文） */
  comment: string;
}

/** 班级讲评报告 LLM 叙事快照。客观统计（ClassStats）不在其中——那部分永远由
 *  当前学生数据实时现算；本对象是生成时刻的快照，随历史存档持久化。 */
export interface ClassFeedbackReport {
  /** ISO 时间戳（客户端生成后写入，非 LLM 输出） */
  generatedAt: string;
  essayType: EssayType;
  /** 生成时参与统计的学生数（快照元信息；实时数字以 ClassStats 为准） */
  studentCount: number;
  /** 生成时的指纹（学生成绩/学案被编辑后与实时指纹不一致 → UI 提示「报告已过期」） */
  fingerprint: string;
  commonProblems: ClassReportProblem[];
  /** 建设性意见：面向下一轮训练的具体可操作建议（3-5 条） */
  suggestions: string[];
  highlights: ClassReportHighlight[];
  /** 评讲课建议：课堂环节安排（4-6 条，每条含建议时长） */
  lessonPlan: string[];
}

/** 班级客观统计（客户端从当前学生数据确定性计算，永远实时；不持久化） */
export interface ClassStats {
  /** 参与统计人数（已生成学案且无 genError 的学生） */
  studentCount: number;
  /** 生成失败被排除的人数（有 genError） */
  excludedCount: number;
  /** 已上传但尚未生成的人数（不影响统计，措辞与 excludedCount 严格区分） */
  pendingCount: number;
  /** 有参考分数的人数 */
  scoredCount: number;
  avgScore: number | null;
  maxScore: number | null;
  minScore: number | null;
  /** 分制（15/25）；取全班首个非空 maxScore，仅供展示口径提示 */
  scoreScale: number | null;
  /** 五档人数分布，下标 0=一档（最低）… 4=五档（最高，图表直用）；非 15/25 分制为 null */
  bandDistribution: number[] | null;
  /** 分项均分（内容/语言/结构(衔接)），只统计有 scoreBreakdown 的学生 */
  avgBreakdown: { content: number | null; language: number | null; cohesion: number | null };
  /** 四类错误频次（errorDiagnosis 各类条数合计） */
  errorCounts: { grammar: number; vocabulary: number; sentence: number; logic: number };
  /** 遗漏要点总条数（missedPoints 长度合计） */
  missedPointCount: number;
  /** 偏题人数 */
  offTopicCount: number;
}

// ─── 衡水体字帖类型 ──────────────────────────────────

/** 线格类型 */
export type CopybookLineType = 'fourLine' | 'doubleLine' | 'singleLine';

/** 生成模式 */
export type CopybookMode = 'trace' | 'interleaved' | 'blank';

export const COPYBOOK_LINE_TYPES: { value: CopybookLineType; label: string; description: string }[] = [
  { value: 'fourLine', label: '四线三格', description: '四线三格，规范字母上下高度' },
  { value: 'doubleLine', label: '两线', description: '一实一虚，统一字母主体高度' },
  { value: 'singleLine', label: '单线', description: '单条基线，模拟考试卷面' },
];

export const COPYBOOK_MODES: { value: CopybookMode; label: string; description: string }[] = [
  { value: 'trace', label: '描红', description: '每行淡色字，供描摹' },
  { value: 'interleaved', label: '隔行临摹', description: '材料行 + 空白行交替，供临写' },
  { value: 'blank', label: '纯空白字帖', description: '只给线不给字，抄写/默写用' },
];

/** 字帖排版参数 */
export interface CopybookConfig {
  /** 要排版的英文内容（换行 = 硬换行） */
  text: string;
  lineType: CopybookLineType;
  mode: CopybookMode;
  title: string;
  /** 是否显示「学生姓名：____」栏 */
  showStudentName: boolean;
  /** 字号（px） */
  fontSize: number;
  /** 字距（px，可为负） */
  letterSpacing: number;
  /** 词间距（以字母 o 宽度为 1 的倍数，1 = 一个 o 的大小） */
  wordSpacing: number;
  /** 行距（额外 px） */
  lineSpacing: number;
  /** 字迹颜色 */
  inkColor: string;
  /** 字迹深浅 0.1–1 */
  inkOpacity: number;
  /** 线条颜色 */
  lineColor: string;
  /** 线条深浅 0.1–1 */
  lineOpacity: number;
}

/** 字帖内容生成默认模型 */
export const COPYBOOK_DEFAULT_MODEL = 'gemini-2.5-flash';

/** LLM 返回的字帖练习内容 */
export interface CopybookGenResult {
  /** 练习英文内容，换行符分隔每一行 */
  text: string;
}

export const DEFAULT_COPYBOOK_CONFIG: CopybookConfig = {
  text: '',
  lineType: 'doubleLine',
  mode: 'interleaved',
  title: '衡水体英语字帖',
  showStudentName: false,
  fontSize: 20,
  letterSpacing: 0,
  wordSpacing: 1,
  lineSpacing: 10,
  inkColor: '#000000',
  inkOpacity: 0.5,
  lineColor: '#000000',
  lineOpacity: 0.5,
};

/** 字帖模块保存快照 */
export interface CopybookState extends CopybookConfig {
  model: string;
}

// ─── 试卷排版助手类型 ──────────────────────────────

/** 题目块类型：文章正文 / 选择题 / 填空题 / 写作题 / 其他 */
export type ExamQuestionType = 'passage' | 'choice' | 'blank' | 'essay' | 'other';

export interface ExamOption {
  label: string;
  text: string;
}

export interface ExamQuestion {
  id: string;
  /** 原卷题号字符串，如 "1"、"41"；无编号内容（文章正文）为空字符串 */
  number: string;
  type: ExamQuestionType;
  /** 题干；passage 为正文（多段用 \n 分隔）；blank 含 ___ 占位 */
  stem: string;
  /** passage 的字母标号（阅读理解 A–D），无则省略 */
  label?: string;
  /** 仅 choice */
  options?: ExamOption[];
  /** 原卷明确给出时提取；否则空串，教师手填 */
  answer?: string;
}

export interface ExamSection {
  id: string;
  /** 大题标题，如 "阅读理解"、"完形填空"（教师可改） */
  title: string;
  /** 原始切块序（单块重试后插回原位用；导出/渲染忽略） */
  chunkIndex?: number;
  /** 卷别分隔行，如 "第Ⅰ卷"（居中黑体，仅分卷试卷有） */
  volumeDivider?: string;
  /** 部分完整标题，如 "第一部分：听力理解（共两节，20小题，每题1.5分，满分30分）" */
  partTitle?: string;
  /** 节标题行（含分值说明），按出现顺序 */
  subHeaders?: string[];
  /** 大题说明句 */
  instruction?: string;
  questions: ExamQuestion[];
}

export interface ExamPaperMeta {
  /** 试卷标题 */
  title: string;
  /** 满分/考试时间行 */
  subTitle: string;
  /** 注意事项，逐条 */
  notices: string[];
}

export interface ExamPaper {
  meta: ExamPaperMeta;
  sections: ExamSection[];
}

export type ExamPaperSize = 'a4' | '8k' | 'a3';

export const EXAM_PAPERS: { value: ExamPaperSize; label: string; description: string }[] = [
  { value: 'a4', label: 'A4 竖版', description: 'A4 纵向单栏' },
  { value: '8k', label: '8K 横版', description: '8K (260×370mm) 横向双栏' },
  { value: 'a3', label: 'A3 横版', description: 'A3 横向双栏' },
];

export const EXAM_FONT_SIZES: { value: number; label: string }[] = [
  { value: 21, label: '五号 10.5pt' },
  { value: 18, label: '小五 9pt' },
  { value: 24, label: '小四 12pt' },
];

export interface ExamLayoutOptions {
  paper: ExamPaperSize;
  /** 正文字号（半点单位，docx size） */
  fontSize: number;
  /** 是否输出试卷头（标题 + 班级姓名考号栏） */
  withHeader: boolean;
  /** 是否附带参考答案页 */
  withAnswerPage: boolean;
  /** 目标页数（0 = 不自动凑页）；正数时自动调节行距/段距贴近该页数，便于双面打印 */
  targetPages: number;
}

export const DEFAULT_EXAM_LAYOUT: ExamLayoutOptions = {
  paper: 'a4',
  fontSize: 21,
  withHeader: true,
  withAnswerPage: true,
  targetPages: 0,
};

/** 目标页数选项（8K/A3 双面打印：1 张纸 = 2 页） */
export const EXAM_TARGET_PAGES: { value: number; label: string }[] = [
  { value: 0, label: '不限制' },
  { value: 4, label: '4 页' },
  { value: 6, label: '6 页' },
  { value: 8, label: '8 页' },
  { value: 10, label: '10 页' },
  { value: 12, label: '12 页' },
  { value: 16, label: '16 页' },
];

/** 试卷结构化解析默认模型 */
export const EXAM_DEFAULT_MODEL = 'gemini-2.5-flash';

/** 单个大题块的 LLM 解析结果（无 id/title，由前端补齐） */
export interface ExamSectionParseResult {
  instruction: string;
  questions: Omit<ExamQuestion, 'id'>[];
}

/** LLM 大纲切块结果：各大题名 + 原文锚点（在全文中定位切块边界用） */
export interface ExamOutlineSection {
  name: string;
  /** 标题行或正文开头的逐字摘录（8~20 字符） */
  startMark: string;
}

/** LLM 大纲顺带识别的文末附加部分（参考答案/答案详解/听力原文等） */
export interface ExamOutlineAppendix {
  /** 原标题（如「参考答案及解析」），用于区分答案类 / 听力材料类 */
  label: string;
  /** 标题行开头逐字摘录（4~20 字符） */
  startMark: string;
}

export interface ExamOutline {
  sections: ExamOutlineSection[];
  /** 文末附加部分（无则省略）；内容不列入 sections */
  appendices?: ExamOutlineAppendix[];
}

/** 试卷模块保存快照 */
export interface ExamPaperState {
  inputText: string;
  model: string;
  paper: ExamPaper | null;
  layout: ExamLayoutOptions;
  /** 题型清单（软先验）；旧数据缺失 = 当年未存，恢复时由调用方补学段默认 */
  manifest?: string[];
}

/** M4 难度自检结果 */
export interface LevelCheckResult {
  verdict: 'ok' | 'warn';
  summary: string;
  warnings: string[];
}
