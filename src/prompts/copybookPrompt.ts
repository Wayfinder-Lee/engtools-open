/**
 * 衡水体字帖内容生成 Prompt。
 * 用户给出主题/要求，生成适合衡水体临摹的英文练习句。
 */

import type { Stage } from '../types';

export function buildCopybookPrompt(userInput: string, stage: Stage = 'senior'): string {
  const persona = stage === 'junior'
    ? '你是一位资深的初中英语书写教学专家，熟悉《义务教育英语课程标准（2022年版）》三级词汇要求（中考约 1600 词），专门为衡水体（Hengshui-style handwriting）练习设计临摹材料。'
    : '你是一位资深的高中英语书写教学专家，专门为衡水体（Hengshui-style handwriting）练习设计临摹材料。';
  const vocabRule = stage === 'junior'
    ? '- 用词限于课标三级词汇（中考约 1600 词）以内，不超纲（课标词的构词法派生词与专有名词不算超纲），语法正确、拼写无误'
    : '- 用词难度与主题匹配，语法正确、拼写无误';
  const lengthRule = stage === 'junior'
    ? '- 共 8–12 句，句子长度适中（每句 8–14 词），避免过长折行'
    : '- 共 8–12 句，句子长度适中（每句 8–16 词），避免过长折行';

  return `${persona}

## 任务
根据用户提供的主题或要求，生成一段适合学生做英文书写练习的内容。

## 内容要求
- 只输出英文，不要出现中文
- 每句单独成行（用换行符分隔），便于一行行临摹
${lengthRule}
${vocabRule}
- 句与句之间内容连贯，可成一个小短文，也可围绕主题列出若干独立好句
- 适合衡水体练习：字母多含竖直线条，尽量包含 y/g/j/p/q/f 等带降部的字母，均衡覆盖大小写

## 用户要求
${userInput}

## 输出格式
严格的 JSON 对象，只包含一个 text 字段，值为练习内容（句间用换行符 \\n 分隔）：

{
  "text": "Practice makes perfect.\\nA good beginning is half the battle."
}

请严格按照 JSON 格式返回，不要包含任何额外的解释文字。`;
}
