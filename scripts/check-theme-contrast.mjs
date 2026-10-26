#!/usr/bin/env node
/**
 * 主题色板对比度校验 —— 读 src/index.css 的 :root（亮色）与
 * [data-theme='dark']（暗色）两块自定义属性，按 WCAG 2.x 相对亮度
 * 公式校验常用前景/背景组合（AA：正文 4.5:1，大字/UI 组件 3:1）。
 *
 * 改任何颜色后必跑：node scripts/check-theme-contrast.mjs
 * 退出码：0 = 全部达标；1 = 有不达标项（或解析失败）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.css');

const TEXT = 4.5;  // 正常小字（WCAG AA）
const UI = 3.0;    // 大字 / UI 组件 / 图形（WCAG AA）
const FAINT = 2.5; // 占位/禁用/装饰弱文字，可辨即可（disabled 豁免于 WCAG）

// [前景, 背景, 阈值]；前景/背景填 '--token' 或字面 hex
const PAIRS = [
  ['--fg', '--bg', TEXT], ['--fg', '--bg-raised', TEXT], ['--fg', '--bg-overlay', TEXT],
  ['--fg', '--bg-inset', TEXT], ['--fg', '--bg-active', TEXT],
  ['--fg-2', '--bg', TEXT], ['--fg-2', '--bg-raised', TEXT],
  ['--fg-muted', '--bg', TEXT], ['--fg-muted', '--bg-raised', TEXT], ['--fg-muted', '--bg-inset', TEXT],
  ['--fg-faint', '--bg', FAINT], ['--fg-faint', '--bg-raised', FAINT],
  ['--accent-text', '--bg', TEXT], ['--accent-text', '--bg-raised', TEXT],
  ['--accent-text', '--accent-soft', TEXT],
  ['--fg', '--accent-soft', TEXT],                 // ::selection
  // 注：不测「--accent 填充块 vs 页面底」——填充按钮以自体色块为边界，
  // 有意义的是其上白字对比（'#ffffff' on '--accent'），亮色品牌色不动
  ['#ffffff', '--accent', UI],                     // 主按钮：橙底白字
  ['--success', '--bg', TEXT], ['--success', '--success-soft', TEXT],
  ['--danger', '--bg', TEXT], ['--danger', '--danger-soft', TEXT],
  ['--warning', '--bg', TEXT], ['--warning', '--warning-soft', TEXT],
  ['--info', '--bg', TEXT], ['--info', '--info-soft', TEXT],
  ['--tag-blue-text', '--tag-blue-bg', TEXT],
  ['--tag-orange-text', '--tag-orange-bg', TEXT],
  ['--tag-green-text', '--tag-green-bg', TEXT],
  ['--tag-purple-text', '--tag-purple-bg', TEXT],
  ['--cta-fg', '--cta-bg', TEXT], ['--cta-fg-muted', '--cta-bg', TEXT],
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 CSS 文本里抽一个选择器块内的全部自定义属性 */
function extractBlock(css, selector) {
  const m = css.match(new RegExp(escapeRegExp(selector) + '\\s*\\{([\\s\\S]*?)\\n\\}'));
  if (!m) throw new Error(`index.css 里找不到 ${selector} 块`);
  const vars = {};
  // 全局匹配而非逐行：token 常一行写多个（--success: ..; --success-soft: ..;）
  const re = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g;
  let vm;
  while ((vm = re.exec(m[1])) !== null) vars[vm[1]] = vm[2];
  return vars;
}

function parseColor(value) {
  let m = value.match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = value.match(/^#([0-9a-fA-F]{3})$/);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  return null;
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(CSS_PATH, 'utf8');
const themes = [
  ['亮色 :root', extractBlock(css, ':root')],
  ["暗色 [data-theme='dark']", extractBlock(css, "[data-theme='dark']")],
];

let failed = 0;

for (const [themeName, vars] of themes) {
  console.log(`\n== ${themeName} ==`);
  for (const [fgName, bgName, min] of PAIRS) {
    const fg = parseColor(vars[fgName] ?? fgName);
    const bg = parseColor(vars[bgName] ?? bgName);
    if (!fg || !bg) {
      console.log(`✗ 解析失败：${fgName}=${vars[fgName] ?? fgName} / ${bgName}=${vars[bgName] ?? bgName}（脚本只认 hex）`);
      failed++;
      continue;
    }
    const ratio = contrast(fg, bg);
    const ok = ratio >= min;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${ratio.toFixed(2).padStart(5)}  ${fgName} on ${bgName}（需 ≥${min}）`);
  }
}

console.log(failed === 0 ? '\n全部达标 ✅' : `\n${failed} 项不达标 ❌`);
process.exit(failed === 0 ? 0 : 1);
