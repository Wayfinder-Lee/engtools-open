import { getToken, isGuestMode } from './session';

/** 登录（付费）用户每项操作强制使用的模型 */
const PAID_MODELS: Record<string, string> = {
  vocab: 'gemini-2.5-flash',
  practical: 'gemini-3.5-flash',
  continuation: 'gemini-3.5-flash',
  ocr: 'gemini-2.5-flash',
  worksheet: 'gemini-3.5-flash',
  class_report: 'gemini-3.5-flash',
  copybook: 'gemini-2.5-flash',
  exampaper: 'gemini-2.5-flash',
  exampaper_vision: 'gemini-2.5-flash', // 照片/扫描件逐页转写（需视觉能力，同 ocr）
  prompt_vision: 'gemini-2.5-flash', // 看图/图表作文题干配图读图（需视觉能力，同 ocr）
  auto_title: 'gemini-2.5-flash', // 自动存档标题（免费辅助，用最便宜的模型）
};

/** 返回当前应使用的 effective 模型名（登录/游客走服务端强制指定，自带 key 用户用自选） */
export function getEffectiveModel(op: string, selectedModel: string): string {
  if (getToken() || isGuestMode()) return PAID_MODELS[op] || selectedModel;
  return selectedModel;
}

/** 操作对应的 credit 消耗（供 UI 提示用）。权威版本在 server/src/index.js 的 CREDIT_COST，改两边须同步。 */
export const CREDIT_COST_LABELS: Record<string, number> = {
  word: 0,
  vocab_section: 5,
  cloze: 20,
  practical: 20,
  continuation: 30,
  worksheet: 30,
  class_report: 10,
  ocr: 1,
  copybook: 5,
  exampaper: 5,
  exampaper_vision: 5,
  prompt_vision: 1,
  rewrite: 3,
  rewrite_essay: 8,
  level_check: 2,
  summarize: 1,
  auto_title: 0,
};

/** op → 中文名（使用看板 / 额度明细的「项目」列）。stat 类 op 是客户端上报数量，不是计费 op。 */
const OP_LABELS: Record<string, string> = {
  word: '查词',
  vocab_section: '词汇提取',
  cloze: '语法填空',
  practical: '书面表达学案',
  continuation: '读后续写',
  worksheet: '个性化学案',
  class_report: '讲评报告',
  ocr: '手写识别',
  prompt_vision: '题图识别',
  copybook: '字帖内容',
  exampaper: '试卷解析',
  exampaper_vision: '试卷视觉转写',
  rewrite: '段落重写',
  rewrite_essay: '整篇重写',
  level_check: '难度自检',
  summarize: '题干概括',
  auto_title: '存档标题',
  word_unlock: '单词次数解锁',
  redeem: '兑换码充值',
  signup: '注册赠送',
  verify_email: '邮箱验证赠送',
  vocab_words: '词汇提取（词数）',
  exampaper_done: '试卷排版（份）',
  copybook_print: '字帖打印（次）',
};

export function opLabel(op: string): string {
  return OP_LABELS[op] || op;
}
