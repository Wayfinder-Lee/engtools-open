/**
 * 构建后预渲染（W2 SEO）：把落地页渲染成静态 HTML 注入 dist/index.html。
 * 百度对 JS 渲染支持很弱——光补 meta 标签解决不了「正文为零」，
 * 必须让爬虫在无 JS 时能看到真实内容。
 *
 * 流程：vite ssrLoadModule 加载 HomePage → renderToString → 替换 <div id="root"></div>。
 * 客户端 createRoot().render() 提交时会接管容器，静态快照仅作为首屏/爬虫内容存在。
 * SSR 失败（如未来 HomePage 引入仅浏览器 API）时回退注入手写首屏快照，绝不阻塞构建。
 */
import { createServer } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { renderToString } from 'react-dom/server';
import React from 'react';

const DIST_INDEX = 'dist/index.html';

// 手写兜底快照：保证百度至少能索引到核心关键词与功能介绍
const FALLBACK = `
<section style="max-width:920px;margin:0 auto;padding:48px 20px;font-family:system-ui,sans-serif">
  <h1 style="font-size:28px">English Teacher's Toolkit · 英语教学工具箱</h1>
  <p style="font-size:15px;line-height:1.8">面向中学英语教师的 AI 备课工具箱：粘贴试卷自动提取重点词汇生成可打印学案；应用文与读后续写助手生成范文与逐段讲解；上传手写作文照片生成每位学生的个性化学案；衡水体字帖一键成帖；整份试卷 AI 解析后重排版导出 Word。支持高中（高考）与初中（中考）双学段。注册即送免费使用额度，无需绑定 API Key。</p>
</section>
`.trim();

async function inject(snapshot) {
  const content = await readFile(DIST_INDEX, 'utf8');
  if (!content.includes('<div id="root"></div>')) {
    throw new Error('dist/index.html 中未找到 <div id="root"></div> 锚点（可能已被注入过）');
  }
  const next = content.replace(
    '<div id="root"></div>',
    () => `<div id="root">${snapshot}</div><!--prerendered-->`,
  );
  await writeFile(DIST_INDEX, next);
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const { default: HomePage } = await vite.ssrLoadModule('/src/components/HomePage.tsx');
  const html = renderToString(
    React.createElement(HomePage, { onLogin: () => {}, onOwnApi: () => {} }),
  );
  await inject(html);
  console.log(`[prerender] 已注入落地页静态快照（约 ${Math.round(html.length / 1024)}KB 文本）`);
} catch (err) {
  console.warn('[prerender] SSR 渲染失败，注入手写首屏快照兜底：', err?.message ?? err);
  try {
    await inject(FALLBACK);
    console.log('[prerender] 已注入手写兜底快照');
  } catch (err2) {
    console.warn('[prerender] 兜底注入也失败（不影响构建产物可用性）：', err2?.message ?? err2);
  }
} finally {
  await vite.close();
}
