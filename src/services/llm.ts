import type { ApiConfig, ClassFeedbackReport, ClozeResult, ContinuationWritingResult, CopybookGenResult, EssayType, ExamOutline, ExamSectionParseResult, ExtractionResult, HandwritingWorksheetResult, ModelEssaySentence, ModelEssayTable, PracticalWritingResult, PromptSummary, ScoreBreakdown, Stage, VocabItem } from '../types';
import { getScoreDimensions } from '../types';
import { getToken, isGuestMode } from '../utils/session';
import { compressImage } from '../utils/image';
import { API_BASE } from './api';
import { EXAM_TRANSCRIBE_SYSTEM, EXAM_TRANSCRIBE_USER } from '../prompts/examTranscribePrompt';
import { PROMPT_IMAGE_READING_SYSTEM, PROMPT_IMAGE_READING_USER } from '../prompts/promptImageReadingPrompt';

/**
 * 清理 LLM 返回的 JSON 字符串：去掉可能的 markdown 代码块标记等。
 * 某些模型（DeepSeek 等）偶尔会在 JSON 外面包裹 ```json ... ```。
 */
function cleanJsonResponse(content: string): string {
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned;
}

/**
 * 在 JSON 字符串字面量内转义裸控制字符（真换行/制表符等，JSON 语法禁止）。
 * 逐字符状态机，覆盖对象 value、数组元素等**所有**字符串位置——
 * gemini-3.5-flash 曾在讲评报告 lessonPlan 数组元素（长中文句子）里输出裸换行，
 * 旧正则 `(?<=: ")` 只够到对象 value，导致 repair 失败、报「JSON 解析失败（已重试）」。
 * 对合法 JSON 是恒等变换（转义对走 `\\` 分支原样保留）。
 */
export function escapeRawControlChars(t: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === '\\') { out += ch + (t[++i] ?? ''); continue; } // 保住转义对（含 \" \\）
    if (ch === '"') { inStr = false; out += ch; continue; }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 修复 LLM 常犯的 JSON 格式错误 */
function repairJson(text: string): string {
  let t = text.trim();
  // Strip markdown fences
  t = t.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  // Strip leading text before first { or [
  const start = t.search(/[\{\[]/);
  if (start > 0) t = t.slice(start);
  // Strip trailing text after last } or ]
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (end >= 0 && end < t.length - 1) t = t.slice(0, end + 1);
  // Remove trailing commas before } or ]
  t = t.replace(/,(\s*[}\]])/g, '$1');
  // Fix unescaped control characters in strings (multiline modelEssay、lessonPlan 数组元素等)
  t = escapeRawControlChars(t);
  return t;
}

/**
 * 判断当前是否处于 Vite 开发模式。
 * 开发模式下使用 Vite 代理转发，避免浏览器 CORS 限制。
 */
const isDev = import.meta.env.DEV;

// ─── 错误人话化（W8）────────────────────────────────
// 服务商原始返回（常为英文 JSON）直出错误条，教师读不懂原因。
// HTTP 层错误在此翻译成中文；原始返回挂在 detail 上，由 ErrorBar 提供可展开的「原始信息」。

/** 带原始详情的错误：message 面向教师，detail 供排障展开查看。 */
export class LlmError extends Error {
  detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}

/** 把 HTTP 错误响应翻译成教师能读懂的中文。 */
export function humanizeHttpError(status: number, body: string): LlmError {
  // 自有后端返回的中文 { error: "..." } 直接透传（额度不足等业务错误）
  try {
    const j = JSON.parse(body) as { error?: unknown };
    if (j && typeof j.error === 'string' && /[一-龥]/.test(j.error)) {
      return new LlmError(j.error, body.slice(0, 500));
    }
  } catch {
    // 非 JSON，走状态码映射
  }
  const map: Record<number, string> = {
    401: '登录状态已过期，请刷新页面重新登录',
    402: '额度不足，请点顶栏「额度充值」兑换后再试',
    403: '没有访问权限，请重新登录后再试',
    404: '模型服务接口不存在，请稍后重试，若持续出现请反馈',
    429: '模型限流中，请等待十几秒再点重试（失败不扣额度）',
  };
  const message = map[status]
    ?? (status >= 500 ? '模型服务暂时不可用，请稍后重试（失败不扣额度）' : `请求失败（${status}），请稍后重试`);
  return new LlmError(message, body.slice(0, 500));
}

/** 渲染错误条前的统一归一化：网络断连 / 超时 / 人话化后的 LlmError 都收敛成中文。 */
export function describeError(e: unknown): { message: string; detail?: string } {
  if (e instanceof LlmError) return { message: e.message, detail: e.detail };
  if (e instanceof Error) {
    if (e.name === 'TypeError' && /fetch|network/i.test(e.message)) {
      return { message: '网络异常，无法连接模型服务。请检查网络后重试（失败不扣额度）', detail: e.message };
    }
    if (/timeout|timed?\s?out|aborted/i.test(e.message)) {
      return { message: '请求超时，请重试（失败不扣额度）', detail: e.message };
    }
    return { message: e.message };
  }
  return { message: String(e) };
}

/**
 * 构造实际请求的 URL 与鉴权头，支持三种模式：
 * - 已登录（存在 JWT）：请求打到自己的后端 /api/llm/chat，带 Bearer <JWT>，
 *   由后端持真实 key 转发并扣额度。浏览器里不出现任何真实 API key。
 * - 游客模式（M6 免注册体验）：同样打到后端，不带鉴权头——服务端按调用方 IP
 *   记体验额度。浏览器里同样不出现任何真实 API key。
 * - 自带 key 模式（开发者后门）：沿用旧逻辑——开发走 Vite 代理、
 *   生产直连配置端点，Authorization 用用户自填的 apiKey。
 */
function buildRequest(config: ApiConfig): { url: string; headers: Record<string, string> } {
  const token = getToken();
  if (token) {
    return { url: `${API_BASE}/api/llm/chat`, headers: { Authorization: `Bearer ${token}` } };
  }
  if (isGuestMode()) {
    return { url: `${API_BASE}/api/llm/chat`, headers: {} };
  }
  if (isDev) {
    return {
      url: '/api/proxy',
      headers: { 'X-Proxy-Target': config.endpoint, Authorization: `Bearer ${config.apiKey}` },
    };
  }
  return { url: config.endpoint, headers: { Authorization: `Bearer ${config.apiKey}` } };
}

/** 模型名收口：自带 Key 模式下模型名来自可自由输入的组合框（可能被清空/粘贴出首尾空格）。
 *  去空格；为空直接抛清晰错误，而不是把空 model 发给 API 换来莫名的 400。 */
function normModel(model: string): string {
  const m = model.trim();
  if (!m) throw new Error('模型名不能为空，请在页面上方的模型输入框填写模型名');
  return m;
}

/** 调用 OpenAI 兼容的 Chat Completions API，返回解析后的 ExtractionResult */
export async function extractVocab(
  config: ApiConfig,
  model: string,
  systemPrompt: string,
  userContent: string
): Promise<ExtractionResult> {
  const m = normModel(model);
  const { url, headers: reqHeaders } = buildRequest(config);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...reqHeaders,
    },
    body: JSON.stringify({
      _operation: 'vocab_section',
      model: m,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error');
    throw humanizeHttpError(response.status, errorBody);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('API 返回内容为空');
  }

  let parsed: ExtractionResult;
  try {
    parsed = JSON.parse(cleanJsonResponse(content)) as ExtractionResult;
  } catch {
    throw new Error(`无法解析 LLM 返回的 JSON: ${content.slice(0, 300)}`);
  }

  if (!Array.isArray(parsed.vocabularies)) {
    throw new Error('LLM 返回的 JSON 格式不符合预期（缺少 vocabularies 数组）');
  }

  parsed.vocabularies = parsed.vocabularies.map((item, index) => ({
    ...item,
    id: item.id ?? index + 1,
  }));

  return parsed;
}

/** 按学段构建单词条目 prompt（初中版锚定课标三级词汇/中考难度） */
function buildSingleWordSystemPrompt(stage: Stage): string {
  if (stage === 'junior') {
    return `你是一位初中英语教学专家，熟悉《义务教育英语课程标准（2022年版）》三级词汇（中考约1600词）和中考命题规律。用户给你一个单词或词组，你需要为它生成一份适合初中生的完整词汇学习条目。

返回一个严格的 JSON 对象，包含该单词的完整信息：

{
  "word": "单词（词典原形，非变形）",
  "phonetic": "音标（IPA）",
  "examFrequency": "★★★★☆",
  "source": "custom",
  "sourceLabel": "自定义添加",
  "definition": "词性 ① 中文释义 ｜ English ② 中文释义 ｜ English",
  "originalSentence": "用 **word** 加粗单词的英文例句。（中文翻译。）",
  "collocations": "搭配1 中文意思; 搭配2 中文意思（搭配中注明 sth./sb.）",
  "memoryAid": "简化辅助记忆（不写初中生不认识的拉丁/希腊词根，优先常见词根/构词/联想/辨析，开头标明方法）",
  "extraExample": "另一个用 **word** 加粗的英文例句。（中文翻译中对应汉语词也加粗。）",
  "spellingRequired": true
}

各字段规范要求如下：
- word：必须输出词典原形，不要变形
- definition：必须包含词性，多义项用①②③编号，义项以初中常用义为主
- examFrequency：表示该词在中考中的考查频次，仅星级，不加任何文字说明
- collocations：注明 sth./sb. 等搭配成分，选用中考常考搭配
- memoryAid：简化，不用初中生看不懂的拉丁/希腊词根
- originalSentence / extraExample：例句难度贴合初中生水平，用词不超出课标三级词汇（超纲词不超过必要范围）
请严格按照 JSON 格式返回。`;
  }

  return `你是一位高中英语教学专家。用户给你一个单词或词组，你需要为它生成一份完整的词汇学习条目。

返回一个严格的 JSON 对象，包含该单词的完整信息：

{
  "word": "单词（词典原形，非变形）",
  "phonetic": "音标（IPA）",
  "examFrequency": "★★★★☆",
  "source": "custom",
  "sourceLabel": "自定义添加",
  "definition": "词性 ① 中文释义 ｜ English ② 中文释义 ｜ English",
  "originalSentence": "用 **word** 加粗单词的英文例句。（中文翻译。）",
  "collocations": "搭配1 中文意思; 搭配2 中文意思（搭配中注明 sth./sb.）",
  "memoryAid": "简化辅助记忆（不写高中生不认识的拉丁/希腊词根，优先常见词根/构词/联想/辨析，开头标明方法）",
  "extraExample": "另一个用 **word** 加粗的英文例句。（中文翻译中对应汉语词也加粗。）",
  "spellingRequired": true
}

各字段规范要求如下：
- word：必须输出词典原形，不要变形
- definition：必须包含词性，多义项用①②③编号
- examFrequency：仅星级，不加任何文字说明
- collocations：注明 sth./sb. 等搭配成分
- memoryAid：简化，不用高中生看不懂的拉丁/希腊词根
请严格按照 JSON 格式返回。`;
}

/**
 * 为单个单词生成词汇学习条目。
 * 用于用户自定义添加单词的场景。
 */
export async function generateWordInfo(
  config: ApiConfig,
  model: string,
  word: string,
  stage: Stage = 'senior'
): Promise<VocabItem> {
  const m = normModel(model);
  const { url, headers: reqHeaders } = buildRequest(config);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...reqHeaders,
    },
    body: JSON.stringify({
      _operation: 'word',
      model: m,
      messages: [
        { role: 'system', content: buildSingleWordSystemPrompt(stage) },
        { role: 'user', content: `请为以下单词生成词汇学习条目：${word}` },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error');
    throw humanizeHttpError(response.status, errorBody);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('API 返回内容为空');
  }

  let parsed: VocabItem;
  try {
    parsed = JSON.parse(cleanJsonResponse(content)) as VocabItem;
  } catch {
    throw new Error(`无法解析 LLM 返回的 JSON: ${content.slice(0, 300)}`);
  }

  if (!parsed.word) {
    throw new Error('LLM 没有返回有效的词汇信息');
  }

  parsed.source = 'custom' as VocabItem['source'];
  parsed.sourceLabel = '自定义添加';

  return parsed;
}

/**
 * 为词汇列表生成语法填空检测题。
 * 返回 ClozeResult，失败时返回 null（不阻断导出流程）。
 */
export async function generateCloze(
  config: ApiConfig,
  model: string,
  systemPrompt: string
): Promise<ClozeResult | null> {
  const m = normModel(model);
  try {
    const { url, headers: reqHeaders } = buildRequest(config);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...reqHeaders,
      },
      body: JSON.stringify({
        _operation: 'cloze',
        model: m,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请根据词汇列表生成语法填空题。' },
        ],
        temperature: 0.5,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error('Cloze generation failed:', response.status);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(cleanJsonResponse(content)) as ClozeResult;
    if (!Array.isArray(parsed.items)) return null;

    return parsed;
  } catch (e) {
    console.error('Cloze generation error:', e);
    return null;
  }
}

// ─── Generic JSON API helper ──────────────────────

async function callLLM<T>(config: ApiConfig, model: string, systemPrompt: string, userContent: string, op: string, temperature = 0.3, extraBody: Record<string, unknown> = {}): Promise<T> {
  const m = normModel(model);
  const { url, headers: reqHeaders } = buildRequest(config);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...reqHeaders },
    body: JSON.stringify({
      _operation: op,
      model: m,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      temperature,
      response_format: { type: 'json_object' },
      ...extraBody,
    }),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => 'Unknown');
    throw humanizeHttpError(response.status, err);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('API 返回内容为空');

  // Try strict parse first, then repair, then retry
  const parsed = tryParseJson<T>(content);
  if (parsed) return parsed;

  // 输出被 max_tokens 截断（finish_reason=length）：JSON 必然撕裂且补不全括号修不回，
  // 降温度重试不会让输出变短，只会再扣一次额度——直接报错，且文案指明原因便于反馈
  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new Error('输出长度超出上限被截断，请反馈给站长上调该功能的输出上限');
  }

  // Retry once with lower temperature
  const retryResp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...reqHeaders },
    body: JSON.stringify({
      _operation: op,
      model: m,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      temperature: Math.max(temperature - 0.1, 0.1),
      response_format: { type: 'json_object' },
      ...extraBody,
    }),
  });
  if (!retryResp.ok) throw new Error(`API 重试失败 (${retryResp.status})`);
  const retryData = await retryResp.json();
  const retryContent = retryData.choices?.[0]?.message?.content;
  if (!retryContent) throw new Error('API 重试返回为空');
  const retryParsed = tryParseJson<T>(retryContent);
  if (retryParsed) return retryParsed;
  throw new Error('JSON 解析失败（已重试）');
}

function tryParseJson<T>(content: string): T | null {
  try { return JSON.parse(cleanJsonResponse(content)) as T; } catch {}
  try { return JSON.parse(repairJson(content)) as T; } catch {}
  return null;
}

// ─── 自动存档标题（auto_title：免费辅助 op，gemini-2.5-flash）───

export const AUTO_TITLE_SYSTEM_PROMPT = `你是英语教学材料的存档命名助手。老师会把材料开头片段发给你，你要起一个简明的中文存档标题，让老师在历史记录列表里一眼认出这份材料。要求：
- 8 字以内、最多不超过 12 字，可为空时宁短勿长
- 概括材料最核心的信息（应用文/续写：体裁+话题，如「邀请信：外教当评委」；试卷：考试名称；词汇：主题范围）
- 标题里不要出现学生姓名
- 只输出标题文字本身，不加引号、书名号、句号或任何解释

以 JSON 返回：{"title":"标题"}`;

/** 清洗 LLM 标题：去换行与首尾包裹符，码元安全截到 16 字；空串抛错由调用方静默吞掉 */
function normalizeAutoTitle(v: unknown): string {
  const t = String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”‘’《》〈〉「」『』【】()（）.,，。;；!！?？、\s]+/, '')
    .replace(/["'“”‘’《》〈〉「」『』【】()（）.,，。;；!！?？、\s]+$/, '')
    .trim();
  if (!t) throw new Error('标题为空');
  return Array.from(t).slice(0, 16).join('');
}

/** 起存档标题（免费 op auto_title）。sourceText 已由调用方截断。 */
export async function generateAutoTitle(config: ApiConfig, model: string, sourceText: string): Promise<string> {
  const r = await callLLM<{ title?: unknown }>(config, model, AUTO_TITLE_SYSTEM_PROMPT,
    `请为这份教学材料起存档标题：\n${sourceText}`, 'auto_title', 0.2);
  return normalizeAutoTitle(r?.title);
}

// ─── 应用文生成 ────────────────────────────────────

export async function generatePracticalWriting(
  config: ApiConfig, model: string, systemPrompt: string, userInput: string,
): Promise<PracticalWritingResult> {
  return callLLM<PracticalWritingResult>(config, model, systemPrompt, userInput, 'practical', 0.5);
}

// ─── 读后续写生成 ──────────────────────────────────

export async function generateContinuationWriting(
  config: ApiConfig, model: string, systemPrompt: string, userInput: string,
): Promise<ContinuationWritingResult> {
  return callLLM<ContinuationWritingResult>(config, model, systemPrompt, userInput, 'continuation', 0.5);
}

// ─── 读后续写题干概括（单独调用，结果共享）───────────

const SUMMARIZE_PROMPT = `你是一位高中英语教师。请将以下读后续写题目的原文概括为一句话中文摘要（60字左右），保留关键人物、事件和矛盾。同时提取两段续写的段首句（英文原文）。

返回严格的 JSON：
{
  "summary": "一句话中文摘要，约60字",
  "opening1": "Paragraph 1 opening sentence in English",
  "opening2": "Paragraph 2 opening sentence in English"
}`;

export async function summarizeContinuationPrompt(
  config: ApiConfig, model: string, promptText: string,
): Promise<PromptSummary> {
  return callLLM<PromptSummary>(config, model, SUMMARIZE_PROMPT, promptText, 'summarize', 0.3);
}

// ─── 书面表达个性化学案生成 ──────────────────────────

const _hwStr = (v: unknown): string => (typeof v === 'string' ? v : v == null || typeof v === 'object' ? '' : String(v));
const _hwArr = <T,>(v: unknown): T[] => (Array.isArray(v) ? v : []);
const _hwObj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
/** 分数清洗：接受 number 或纯数字字符串（"18"），round 后钳到 [min,max]，非法返回 undefined */
const _hwInt = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
};

/** modelEssay 兜底：字符串原样；表格补全句子字段；意外结构降级为字符串（EditableField 自带 object 兜底） */
function _hwNormalizeModelEssay(v: unknown): string | ModelEssayTable {
  if (typeof v === 'string') return v;
  const t = _hwObj(v);
  if (Array.isArray(t.paragraph1) || Array.isArray(t.paragraph2)) {
    const sent = (s: unknown): ModelEssaySentence => ({ sentence: _hwStr(_hwObj(s).sentence), function: _hwStr(_hwObj(s).function) });
    return { paragraph1: _hwArr<any>(t.paragraph1).map(sent), paragraph2: _hwArr<any>(t.paragraph2).map(sent) };
  }
  return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
}

/**
 * 个性化学案结果运行时校验/补全。
 * callLLM 只保证「合法 JSON」，LLM 偶发漏掉个别字段（如 vocabularyUpgrade 某条的 upgrades 数组），
 * 裸进渲染层会在 .map 处抛 TypeError → 无 ErrorBoundary 时整页白屏。
 * 此处对渲染/导出层消费的所有字段兜底补全；内容模块整体缺失（空壳 JSON）时抛错，
 * 由调用方转为该生 genError，可单独重新生成。
 */
export function normalizeHandwritingResult(raw: unknown, opts?: { essayType?: EssayType }): HandwritingWorksheetResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('生成结果不是有效的 JSON 对象');
  const r = raw as Record<string, any>;
  const pa = _hwObj(r.promptAnalysis);
  const ed = _hwObj(r.errorDiagnosis);
  const gb = _hwObj(r.grammarBreakthrough);
  const vu = _hwObj(r.vocabularyUpgrade);
  const si = _hwObj(r.sentenceImprovement);

  const result: HandwritingWorksheetResult = {
    studentName: _hwStr(r.studentName),
    promptAnalysis: {
      isOffTopic: Boolean(pa.isOffTopic),
      offTopicDetail: _hwStr(pa.offTopicDetail),
      coveredPoints: _hwArr<unknown>(pa.coveredPoints).map(p => _hwStr(p)),
      missedPoints: _hwArr<unknown>(pa.missedPoints).map(p => _hwStr(p)),
      overallComment: _hwStr(pa.overallComment),
    },
    overallComment: _hwStr(r.overallComment),
    // 分数硬化：maxScore 以题型推导为准（不信模型自报，顺带修复「漏给 maxScore → 导出分数整段消失」）；
    // score 越界钳制；scoreBreakdown 各维钳到维度满分，score 缺失时按三维之和兜底
    ...((): { score?: number; maxScore?: number; scoreBreakdown?: ScoreBreakdown } => {
      const dims = opts?.essayType ? getScoreDimensions(opts.essayType) : undefined;
      const maxScore = dims ? dims.total : _hwInt(r.maxScore, 1, 100);
      const bd = _hwObj(r.scoreBreakdown);
      let breakdown: ScoreBreakdown | undefined;
      if (dims) {
        const c = _hwInt(bd.content, 0, dims.content);
        const l = _hwInt(bd.language, 0, dims.language);
        const ch = _hwInt(bd.cohesion, 0, dims.cohesion);
        if (c != null || l != null || ch != null) {
          breakdown = { content: c ?? 0, language: l ?? 0, cohesion: ch ?? 0 };
        }
      }
      const score = _hwInt(r.score, 0, maxScore ?? 100)
        ?? (breakdown ? breakdown.content + breakdown.language + breakdown.cohesion : undefined);
      return { score, maxScore, scoreBreakdown: breakdown };
    })(),
    errorDiagnosis: {
      grammar: _hwArr<any>(ed.grammar).map(e => ({ original: _hwStr(e?.original), corrected: _hwStr(e?.corrected), explanation: _hwStr(e?.explanation) })),
      vocabulary: _hwArr<any>(ed.vocabulary).map(e => ({ original: _hwStr(e?.original), suggestion: _hwStr(e?.suggestion), explanation: _hwStr(e?.explanation) })),
      sentence: _hwArr<any>(ed.sentence).map(e => ({ original: _hwStr(e?.original), improvement: _hwStr(e?.improvement), explanation: _hwStr(e?.explanation) })),
      logic: _hwArr<any>(ed.logic).map(e => ({ issue: _hwStr(e?.issue), explanation: _hwStr(e?.explanation) })),
    },
    grammarBreakthrough: {
      rules: _hwArr<any>(gb.rules).map(e => ({
        title: _hwStr(e?.title), explanation: _hwStr(e?.explanation),
        examples: _hwArr<any>(e?.examples).map(x => ({ en: _hwStr(x?.en), cn: _hwStr(x?.cn) })),
      })),
    },
    vocabularyUpgrade: {
      items: _hwArr<any>(vu.items).map(e => ({
        original: _hwStr(e?.original),
        upgrades: _hwArr<any>(e?.upgrades).map(x => ({ word: _hwStr(x?.word), context: _hwStr(x?.context) })),
      })),
    },
    sentenceImprovement: {
      items: _hwArr<any>(si.items).map(e => ({
        original: _hwStr(e?.original), analysis: _hwStr(e?.analysis), improved: _hwStr(e?.improved), highlights: _hwStr(e?.highlights),
      })),
    },
    modelEssay: _hwNormalizeModelEssay(r.modelEssay),
    consolidationExercises: _hwArr<any>(r.consolidationExercises).map(e => ({ cn: _hwStr(e?.cn), pattern: _hwStr(e?.pattern), en: _hwStr(e?.en) })),
  };

  // 读后续写专项分析：可选字段，仅在存在时保留并补全内部结构
  const ca = _hwObj(r.continuationAnalysis);
  if (ca && (ca.detail != null || ca.descriptionDiversity != null)) {
    const dd = _hwObj(ca.descriptionDiversity);
    result.continuationAnalysis = {
      p1ConnectsToOpening: Boolean(ca.p1ConnectsToOpening),
      p1EndConnectsToP2: Boolean(ca.p1EndConnectsToP2),
      hasThemeHighlight: Boolean(ca.hasThemeHighlight),
      onlyTwoParagraphs: Boolean(ca.onlyTwoParagraphs),
      detail: _hwStr(ca.detail),
      descriptionDiversity: {
        action: Boolean(dd.action), dialogue: Boolean(dd.dialogue), emotion: Boolean(dd.emotion), environment: Boolean(dd.environment),
        comment: _hwStr(dd.comment),
      },
    };
  }

  const hasContent =
    result.promptAnalysis.coveredPoints.length > 0 || result.promptAnalysis.overallComment !== '' ||
    result.overallComment !== '' ||
    result.errorDiagnosis.grammar.length > 0 || result.errorDiagnosis.vocabulary.length > 0 ||
    result.errorDiagnosis.sentence.length > 0 || result.errorDiagnosis.logic.length > 0 ||
    result.grammarBreakthrough.rules.length > 0 || result.vocabularyUpgrade.items.length > 0 ||
    result.sentenceImprovement.items.length > 0 || result.modelEssay !== '' ||
    result.consolidationExercises.length > 0;
  if (!hasContent) throw new Error('模型返回了空壳 JSON（缺少全部内容模块），请重新生成');
  return result;
}

export async function generateHandwritingWorksheet(
  config: ApiConfig, model: string, systemPrompt: string, userInput: string, essayType?: EssayType,
): Promise<HandwritingWorksheetResult> {
  const r = await callLLM<HandwritingWorksheetResult>(config, model, systemPrompt, userInput, 'worksheet', 0.5);
  return normalizeHandwritingResult(r, { essayType });
}

// ─── 班级讲评报告（整班一次调用）─────────────────────

/** 码元安全截断（同 classStats.clip：不截出半个代理对） */
const _crClip = (v: unknown, n: number): string => {
  const s = _hwStr(v);
  if (s.length <= n) return s;
  let cut = s.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
};

/**
 * 匿名铁律的客户端兜底：prompt 只是约束模型，这里把「高分学生原文（具名）」提供的
 * 姓名从共性问题/建议/评讲课文本中强制替换为「某同学」（highlights 豁免——表扬允许点名）。
 * 长名优先替换，防短名先替换破坏长名匹配。
 */
function _scrubNames(text: string, names: string[]): string {
  let out = text;
  for (const name of [...names].filter(n => n.length >= 2).sort((a, b) => b.length - a.length)) {
    if (out.includes(name)) out = out.split(name).join('某同学');
  }
  return out;
}

/** 班级讲评报告叙事部分的运行时校验：全字段兜底补全 + 数量/长度钳制 + 匿名兜底；空壳 JSON 抛错（normalizeHandwritingResult 同款约定） */
export function normalizeClassFeedbackReport(raw: unknown, opts?: { studentNames?: string[] }): Pick<ClassFeedbackReport, 'commonProblems' | 'suggestions' | 'highlights' | 'lessonPlan'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('讲评报告返回不是有效的 JSON 对象');
  const r = raw as Record<string, any>;
  const names = opts?.studentNames ?? [];
  const sevOf = (v: unknown): 'high' | 'medium' | 'low' => (v === 'high' || v === 'low' ? v : 'medium');

  const commonProblems = _hwArr<any>(r.commonProblems).slice(0, 6).map(p => ({
    title: _scrubNames(_crClip(p?.title, 60), names),
    description: _scrubNames(_crClip(p?.description, 400), names),
    severity: sevOf(p?.severity),
    examples: _hwArr<any>(p?.examples).slice(0, 3).map(e => ({
      quote: _crClip(e?.quote, 300), corrected: _crClip(e?.corrected, 300), note: _scrubNames(_crClip(e?.note, 120), names),
    })),
  })).filter(p => p.title || p.description);

  const highlights = _hwArr<any>(r.highlights).slice(0, 6).map(h => ({
    studentName: _crClip(h?.studentName, 30), sentence: _crClip(h?.sentence, 400), comment: _crClip(h?.comment, 200),
  })).filter(h => h.sentence);

  const result = {
    commonProblems,
    suggestions: _hwArr<unknown>(r.suggestions).slice(0, 6).map(s => _scrubNames(_crClip(s, 300), names)).filter(Boolean),
    highlights,
    lessonPlan: _hwArr<unknown>(r.lessonPlan).slice(0, 8).map(s => _scrubNames(_crClip(s, 300), names)).filter(Boolean),
  };
  const hasContent = result.commonProblems.length > 0 || result.suggestions.length > 0 ||
    result.highlights.length > 0 || result.lessonPlan.length > 0;
  if (!hasContent) throw new Error('模型返回了空壳讲评报告（缺少全部内容模块），请重新生成');
  return result;
}

export async function generateClassFeedbackReport(
  config: ApiConfig, model: string, systemPrompt: string, userContent: string,
  meta: { essayType: EssayType; studentCount: number; fingerprint: string; studentNames?: string[] },
): Promise<ClassFeedbackReport> {
  // max_tokens 8000：四个内容模块 + 例句的输出量介于 outline(2500) 与整卷转写(12000) 之间
  const r = await callLLM<Omit<ClassFeedbackReport, 'generatedAt' | 'essayType' | 'studentCount' | 'fingerprint'>>(
    config, model, systemPrompt, userContent, 'class_report', 0.4, { max_tokens: 8000 },
  );
  return { ...normalizeClassFeedbackReport(r, { studentNames: meta.studentNames }), generatedAt: new Date().toISOString(), ...meta };
}

// ─── 衡水体字帖内容生成 ──────────────────────────────

export async function generateCopybook(
  config: ApiConfig, model: string, systemPrompt: string, userInput: string,
): Promise<CopybookGenResult> {
  return callLLM<CopybookGenResult>(config, model, systemPrompt, userInput, 'copybook', 0.5);
}

// ─── 试卷结构化解析（按大题分块）─────────────────────

/**
 * 解析单个大题块原文为结构化题目。保真任务用低温（同 OCR）；
 * max_tokens 上调防止长块（听力原文等）输出被默认 4K 上限截断。
 */
export async function parseExamSection(
  config: ApiConfig, model: string, systemPrompt: string, sectionText: string,
): Promise<ExamSectionParseResult> {
  return callLLM<ExamSectionParseResult>(config, model, systemPrompt, sectionText, 'exampaper', 0.1, { max_tokens: 8000 });
}

/**
 * 整卷大纲切块：LLM 列出全文各大题名 + 原文锚点（输出远小于逐题解析，
 * 2500 tokens 足够十几道大题）。同样计费为 exampaper 一块。
 */
export async function outlineExamSections(
  config: ApiConfig, model: string, systemPrompt: string, userContent: string,
): Promise<ExamOutline> {
  return callLLM<ExamOutline>(config, model, systemPrompt, userContent, 'exampaper', 0.1, { max_tokens: 2500 });
}

// ─── 手写 OCR 识别（视觉模型）────────────────────────
// 契约（模型只做「逐行转录 + 是否新段」的视觉判断，段落拼装由前端确定性完成）：
// 输出 "lines": [{t: 该视觉行的词, p: 是否新段(true=缩进/格式行/新段首行)}]——
// p 只依赖笔迹形态（缩进/贴左），不依赖内容；前端 assembleOcrLines 把
// p:false 的行并入当前段、p:true 的行开新段，段落边界因此与输出格式无关，
// 彻底绕开模型维护全局分块格式不稳定的缺陷。

// 导出供本地 OCR 测试脚本（scripts/ocr-test.mjs 经 vite ssrLoadModule）复用同一份 prompt
export const OCR_SYSTEM_PROMPT = `You are an expert OCR engine specialized in transcribing handwritten English essays from exam answer sheets.

Your task: Transcribe ONLY the student's handwritten essay text from the image.

CRITICAL RULES:

1. Output = the student's HANDWRITING only. Do NOT transcribe machine-printed text (instructions, section headers, "Paragraph 1:" labels, the printed story/openers, "写作第一节（15分）", line numbers, watermarks).
   - Decide printed vs handwritten ONLY by stroke appearance (uniform machine font vs irregular pen strokes), NEVER by content. You are a transcriber, not an editor: even if a handwritten passage repeats or closely continues the printed story, transcribe it anyway. Students OFTEN echo the opener's wording in their own words ("she was backing away from her bike and towards the tree slowly") — such echo lines are HANDWRITTEN student work: transcribe them, never skip them for resembling the print.
   - CRITICAL: exam sheets give PRINTED paragraph openers and the student continues right after them — on the SAME line and on the FOLLOWING lines. That continuation is handwritten, so it belongs in "lines": transcribe ALL of it. Never drop a handwritten paragraph just because it follows a printed opener line, and never output only the first handwritten paragraph. Continuation-type sheets (读后续写) have TWO handwritten continuation paragraphs — "lines" must cover BOTH.
   - Sheets with "Paragraph 1:" / "Paragraph 2:" labels: EACH label must produce exactly ONE paragraph — the handwritten words from right after the printed opener to the end of that paragraph, with its first line marked "p": true and its wrapped lines "p": false. Two labels → two paragraphs, always.
   - BOUNDARY / MIXED LINES: the handwritten words START ON THE SAME LINE as the printed opener (the print occupies the left portion, then the student's larger, wider-spaced handwriting fills the rest of that line). That visual line is a MIXED line, and it is STILL one line object: "t" = ONLY its handwritten part (the printed opener itself stays out), "p" = true (it begins the paragraph). NEVER skip a mixed line and NEVER start the paragraph from the following line — that would delete the paragraph's beginning ("The kitchen was in a" handwritten after printed "Paragraph 1: As the twins looked around..." → {"t": "The kitchen was in a", "p": true}).

2. Preserve ALL original spelling, grammar, punctuation — we need raw student output for teaching purposes. Copy every word exactly as the student wrote it, including mistakes ("assit" stays "assit", "Cound't" stays "Cound't"). NEVER correct, complete, or normalize spelling. If a word is illegible, mark as [?].
   EXCEPTION — cross-outs: Rule 2 applies to the FINAL text after the student's own deletions, never to crossed-out content.

3. CROSS-OUT HANDLING: Students frequently cross out letters, words, or whole phrases with one or more horizontal strikethrough lines, scribbles, wavy lines, or by blacking them out. Crossed-out content is DELETED by the student — do NOT transcribe it, it must not appear in the output.
   - A word/letter with a line (or lines) drawn through it, scribbled over, or blacked out → SKIP it entirely.
   - Pay special attention to SHORT crossed-out words (1–4 letters: "that", "the", "was"...) and single crossed-out LETTERS squeezed before a word — they are easy to miss. A crossed-out letter glued to the next word must NOT be merged into it (crossed "p" + "improved" → "improved", never "pimproved"; crossed "that" between sentences → transcribe neither).
   - If a replacement word is written ABOVE (or beside) the crossed-out word — the common exam correction style — transcribe the REPLACEMENT in its place instead, and do NOT transcribe the crossed-out word.
   - If a word is rewritten immediately AFTER a crossed-out word, transcribe only the rewrite.
   - If a whole line is crossed out, skip the whole line; if it was rewritten below, transcribe the rewrite.
   - A caret (^) with a word above the line means an INSERTION — include that word at the correct position between the surrounding words.
   - Do not let strikethrough lines confuse you into reading extra letters or words: what remains in the output must read as the clean final version of the essay.

4. LINE-BY-LINE OUTPUT (most important):
   Output "lines": an array with ONE object per VISUAL LINE of the student's handwriting, in reading order (top to bottom). Each object is {"t": "<words on that visual line>", "p": <true|false>}.
   - "p" is true ONLY when that visual line STARTS A NEW PARAGRAPH: its first word is indented (starts clearly further right than the first words of the lines above it), OR the line is a fresh format line (a diary's date/weather line, a letter's salutation "Dear X,", the closing "Yours,", the signature). The essay's very first handwritten line has "p": true.
   - "p" is false for simple line wrapping: the text just continuing on the next ruled line at the SAME left margin. Most lines are false — a 10-line paragraph has exactly one true (its first line) and nine false.

5. Letter/diary conventions: the salutation, each body paragraph, the closing, and the signature each START a new paragraph (mark that line "p": true). Diary date/weather lines: a PRE-PRINTED date/weather line (uniform machine font in a corner of the answer box, e.g. "Aug. 5, 2026  Sunny") is print — skip it exactly like all other print. Only a HANDWRITTEN date/weather line is transcribed, as its own paragraph at the very beginning ("p": true), never merged into the first body paragraph.

6. STUDENT NAME extraction: Look for the student's handwritten name on the answer sheet — usually written next to a printed label like "姓名" / "Name" at the top of the sheet or inside the seal line (密封线) area. Return it in the "studentName" field (string).
   - Transcribe the name exactly as written (Chinese characters or pinyin).
   - Do NOT include this name in "lines" — the output must contain only the essay body.
   - Do NOT use the essay signature (e.g. "Li Hua") — that is a fictional name from the essay prompt, not the student's real name.
   - If the name area is empty, cropped, folded, or illegible, return "".
   - Confidence gate: a WRONG name is worse than an empty one. If the name is written in cursive/linked strokes and you cannot read every character with confidence, return "" — never guess characters you are unsure about.

7. Output a JSON object with exactly two fields: "lines" and "studentName". Never emit duplicate keys. The "lines" array must cover EVERY visual line of handwriting on the sheet — a continuation sheet's output looks like:
     {"lines": [{"t": "To her frighten, she was backing away from her bike", "p": true}, {"t": "towards the tree slowly when the angry-looking bear", "p": false}, {"t": "After a while, the bear didn't afford this voice", "p": true}], "studentName": "..."}

SELF-CHECK before answering:
- Count the handwritten visual lines on the sheet. Does "lines" contain every one of them, in order? A missing line = skipped student work = failed task. Especially check BOTH mixed lines (printed opener + handwriting): each continuation paragraph's FIRST "t" must be the handwritten words on the opener's line, not the line below.
- Does every handwritten word appear (except crossed-out content)?
- Scan for glued-in crossed-out letters: no "t" may contain an impossible word like "pimproved", "bsback", "baback" — a leftover crossed-out letter welded to the front of the next word. If you find one, remove the crossed-out letter.
- Is exactly the first line of each paragraph marked "p": true, and every wrapped continuation line "p": false?

EXAMPLE OF CORRECT OUTPUT (a letter — salutation, three body paragraphs, closing and signature are each their own paragraph; the ruled lines that merely wrap a paragraph are "p": false):
{"lines": [
  {"t": "Dear Mr. Green,", "p": true},
  {"t": "I am writing to express my sincere apology for failing to submit the English", "p": true},
  {"t": "book report on time. Yesterday, I was so excited that I completely", "p": false},
  {"t": "forgot about my homework.", "p": false},
  {"t": "When I finally remembered the report, it was already too late.", "p": true},
  {"t": "However, I will complete it by this Friday. I promise such delay will", "p": false},
  {"t": "not happen again.", "p": false},
  {"t": "I hope you can understand my situation and accept my apology.", "p": true},
  {"t": "Thank you for your patience and understanding.", "p": false},
  {"t": "Yours,", "p": true},
  {"t": "Li Hua", "p": true}
], "studentName": "..."} `;

// compressImage 原实现抽到 utils/image.ts（移动端扫码上传同用）；此处 re-export 保持既有 import 点不变
export { compressImage };

/**
 * 逐行 → 段落确定性组装：模型只判断每个视觉行「是否新段」（p），拼接在此完成——
 * p:true 开新段，p:false 并入当前段（单空格）。空 t 跳过；lines 缺失/为空时
 * 回退旧 "text" 字段（兼容旧格式）。这是产品代码与测试脚本共用的拼装语义。
 */
export function assembleOcrLines(parsed: { lines?: unknown; text?: unknown }): string {
  if (Array.isArray(parsed.lines)) {
    const paras: string[] = [];
    let cur = '';
    for (const ln of parsed.lines) {
      const t = typeof (ln as { t?: unknown })?.t === 'string' ? (ln as { t: string }).t.trim() : '';
      if (!t) continue;
      if ((ln as { p?: unknown }).p === true || !cur) {
        if (cur) paras.push(cur);
        cur = t;
      } else {
        cur += ` ${t}`;
      }
    }
    if (cur) paras.push(cur);
    if (paras.length) return paras.join('\n\n');
  }
  return typeof parsed.text === 'string' ? parsed.text : '';
}

/**
 * 段落格式兜底：lines 组装产物只含 \n\n；若模型走了旧 text 路径仍可能按
 * 视觉行输出单 \n——在此确定性合并为空格。信件抬头/落款、日记日期行、
 * 各自然段都是 \n\n 块，不受影响。
 */
function normalizeOcrParagraphs(s: string): string {
  return s.replace(/(?<!\n)[ \t]*\n(?!\n)[ \t]*/g, ' ').trim();
}

export async function ocrHandwriting(
  config: ApiConfig,
  model: string,
  imageFile: File | string,
): Promise<{ text: string; imageDataUrl: string; studentName?: string }> {
  const m = normModel(model);
  // string = 现成 dataURL（扫码上传的照片手机端已压缩过，不再二次压缩直接透传）
  const imageDataUrl = typeof imageFile === 'string' ? imageFile : await compressImage(imageFile);

  const { url, headers: reqHeaders } = buildRequest(config);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...reqHeaders },
    body: JSON.stringify({
      _operation: 'ocr',
      model: m,
      messages: [
        { role: 'system', content: OCR_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Please transcribe the text and extract the student name from the name field. Return as JSON: {"lines":[{"t":"...","p":true},...], "studentName":"..."}' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0, // 转录任务：不要创造性，压制运行间波动
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => 'Unknown');
    throw humanizeHttpError(response.status, err);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OCR API 返回内容为空');

  // Try parsing as JSON (handle markdown wrapping)
  try {
    const cleaned = cleanJsonResponse(content);
    const parsed = JSON.parse(cleaned) as { lines?: unknown; text?: unknown; studentName?: unknown };
    // 姓名栏识别结果截断防幻觉长串；空串归一为 undefined
    const studentName = typeof parsed.studentName === 'string' ? parsed.studentName.trim().slice(0, 30) : '';
    return {
      text: normalizeOcrParagraphs(assembleOcrLines(parsed)),
      imageDataUrl,
      studentName: studentName || undefined,
    };
  } catch {
    // Fallback: old plain-text format
    return { text: normalizeOcrParagraphs(content), imageDataUrl };
  }
}

/**
 * 试卷视觉转写（M2）：照片 / 扫描件 PDF 渲染出的单页图片 → 整页逐行纯文本。
 * 与 ocrHandwriting 同形（image_url + 登录走 /api/llm/chat 计费），但输出是纯文本
 * （无 response_format），参数按实测定型：temperature 0.1、max_tokens 12000
 * （脏页面 thinking 可烧上万 token 才出正文）、reasoning_effort low（陷阱页曾在
 * 默认思考档把全部 token 耗在 reasoning 上输出 0 字符）。调用方负责 cleanTranscribedPage。
 */
export async function transcribeExamPage(
  config: ApiConfig,
  model: string,
  imageDataUrl: string,
): Promise<string> {
  const m = normModel(model);
  const { url, headers: reqHeaders } = buildRequest(config);

  // reasoning_effort 是中转站/OpenAI reasoning 系扩展参数，仅登录走自家中转时附带；
  // 自备 Key 直连严格端点（OpenAI gpt-4o 等非 reasoning 模型）会 400 拒收未知参数
  const body: Record<string, unknown> = {
    _operation: 'exampaper_vision',
    model: m,
    messages: [
      { role: 'system', content: EXAM_TRANSCRIBE_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: EXAM_TRANSCRIBE_USER },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 12000,
  };
  if (getToken()) body.reasoning_effort = 'low';

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...reqHeaders },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => 'Unknown');
    throw humanizeHttpError(response.status, err);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('试卷视觉识别返回内容为空');
  return content.trim();
}

/**
 * 看图/图表作文题干配图读图：一张配图 → 忠实文字描述（纯文本，无 response_format）。
 * 两步法第一步，老师核对描述后并入题干，生成模型保持纯文本即可。
 * 与 transcribeExamPage 同形；max_tokens 4000 是描述类输出的余量
 * （thinking 模型 reasoning 先烧 token，太小会正文 0 字符）。
 */
export async function readPromptImage(
  config: ApiConfig,
  model: string,
  imageDataUrl: string,
): Promise<string> {
  const m = normModel(model);
  const { url, headers: reqHeaders } = buildRequest(config);

  const body: Record<string, unknown> = {
    _operation: 'prompt_vision',
    model: m,
    messages: [
      { role: 'system', content: PROMPT_IMAGE_READING_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT_IMAGE_READING_USER },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 4000,
  };
  if (getToken()) body.reasoning_effort = 'low';

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...reqHeaders },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => 'Unknown');
    throw humanizeHttpError(response.status, err);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('题图识别返回内容为空');
  return content.trim();
}

// ─── M1/R1 块级重新生成 ─────────────────────────────
// R1：重写结果同时携带刷新后的分句默写，保证「换一个」后默写部分同步更换（单次调用不加价）。

export interface RewriteResult {
  paragraph?: string;
  paragraphs?: string[];
  dictationSentences: { cn: string; en: string; pattern?: string }[];
}

/** 段落级局部重写（换一个，含默写刷新）：op=rewrite（3 额度）。 */
export async function rewriteParagraph(
  config: ApiConfig, model: string, systemPrompt: string, userContent: string,
): Promise<RewriteResult> {
  const r = await callLLM<RewriteResult>(config, model, systemPrompt, userContent, 'rewrite', 0.7);
  const p = (r.paragraph || '').trim();
  if (!p) throw new Error('LLM 没有返回有效的段落内容');
  return {
    paragraph: p,
    dictationSentences: Array.isArray(r.dictationSentences)
      ? r.dictationSentences.filter((d) => d && typeof d.cn === 'string' && typeof d.en === 'string')
      : [],
  };
}

/** 整篇范文按目标层次重写（含默写刷新）：op=rewrite_essay（8 额度）。 */
export async function rewriteEssayAtLevel(
  config: ApiConfig, model: string, systemPrompt: string, userContent: string,
): Promise<RewriteResult> {
  const r = await callLLM<RewriteResult>(config, model, systemPrompt, userContent, 'rewrite_essay', 0.5);
  if (!Array.isArray(r.paragraphs) || r.paragraphs.length === 0 || !r.paragraphs.every((x) => typeof x === 'string' && x.trim())) {
    throw new Error('LLM 返回的段落数组不符合预期');
  }
  return {
    paragraphs: r.paragraphs,
    dictationSentences: Array.isArray(r.dictationSentences)
      ? r.dictationSentences.filter((d) => d && typeof d.cn === 'string' && typeof d.en === 'string')
      : [],
  };
}

// ─── M4 难度自检 ────────────────────────────────────

/** 范文学段匹配度自检：op=level_check（2 额度）。 */
export async function checkWritingLevel(
  config: ApiConfig, model: string, systemPrompt: string, userContent: string,
): Promise<import('../types').LevelCheckResult> {
  const r = await callLLM<import('../types').LevelCheckResult>(config, model, systemPrompt, userContent, 'level_check', 0.2);
  if (r.verdict !== 'ok' && r.verdict !== 'warn') throw new Error('难度自检返回格式不符合预期');
  return { verdict: r.verdict, summary: r.summary || '', warnings: Array.isArray(r.warnings) ? r.warnings : [] };
}
