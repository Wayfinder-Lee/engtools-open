import { useEffect } from 'react';
import type { Session } from '../types';
import { SITE } from '../data/site';
import { track } from '../utils/analytics';
import AuthCard from './home/AuthCard';
import ShowcaseSection from './home/ShowcaseSection';
import MockWorksheet from './home/MockWorksheet';
import MockContinuation from './home/MockContinuation';
import MockVocab from './home/MockVocab';
import MockPractical from './home/MockPractical';
import MockCopybook from './home/MockCopybook';
import MockExamPaper from './home/MockExamPaper';
import PrintMarquee from './home/PrintMarquee';
import InfoModalHost, { openInfoModal } from './InfoModal';
import './HomePage.css';

interface Props {
  onLogin: (session: Session) => void;
  onOwnApi: () => void;
  /** M6：免注册游客体验（按 IP 送体验额度） */
  onGuest: () => void;
}

export default function HomePage({ onLogin, onOwnApi, onGuest }: Props) {
  // 漏斗第一环：落地页曝光（W1 埋点）
  useEffect(() => { track('landing_view'); }, []);

  const scrollToShowcase = () => {
    document.getElementById('showcase')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="home-page">
      {/* ─── Hero: title left 2/3 · divider · auth right 1/3 ─── */}
      <div className="home-hero-band">
        <section className="home-hero-split">
          <div className="hero-left">
            <h1>🛠️ English Teacher's Toolkit</h1>
            <p className="home-subtitle">AI 驱动的英语教学材料准备工具箱</p>
            <ul className="hero-bullets">
              <li>上传照片、粘贴题干，几分钟得到可打印的学案</li>
              <li>词汇 · 应用文 · 读后续写 · 个性化学案 · 衡水体字帖 · 试卷排版，六大工具</li>
              <li>注册即送全功能免费使用额度，无需绑定 API Key</li>
            </ul>
            <div className="hero-cta-row">
              <button className="hero-cta solid" onClick={onGuest}>🚀 免费试用（无需注册）</button>
              <button className="hero-cta" onClick={scrollToShowcase}>了解核心功能 ↓</button>
            </div>
          </div>
          <div className="hero-divider" aria-hidden="true" />
          <div className="hero-right">
            <AuthCard onLogin={onLogin} />
          </div>
        </section>
      </div>

      {/* ─── Feature showcase ─── */}
      <div className="home-showcase" id="showcase">
        <h2 className="showcase-title">工具丰富 覆盖英语学案准备全流程</h2>

        <ShowcaseSection
          icon="handwriting" title="书面表达批改学案"
          tagline="上传学生书面表达答题卡图片/照片，自动识别生成每个学生的专属讲评学案"
          copy="上传学生手写作文照片，AI 自动识别文字、逐句诊断错误、归类语言问题，并为每位学生生成带默写巩固与句式提升的个性化学案，支持打印为 PDF / Word。"
          bullets={['答题卡照片 OCR 识别，无需人工录入', '错误按时态、逗号粘连、非谓语等类型归类', '每位学生一份可打印的个性化学案']}
          panelTitle="书面表达批改学案 · 学生作文.jpg"
          band
        >
          <MockWorksheet />
        </ShowcaseSection>

        <ShowcaseSection
          icon="continuation" title="读后续写学案制作"
          tagline="从范文到方法，十句五定法一键生成"
          copy="粘贴读后续写原文，自动生成两段续写范文、人物与冲突分析、逐句拆解的「十句五定法」写作支架，以及动作 / 情绪 / 语言描写句式库，最后附分句默写材料。"
          bullets={['两段续写范文，衔接段首句', '十句五定法逐句拆解', '描写句式按动作 / 情绪 / 语言分类']}
          panelTitle="读后续写学案制作 · 高考读后续写"
          reverse
        >
          <MockContinuation />
        </ShowcaseSection>

        <ShowcaseSection
          icon="vocab" title="试卷词汇提取"
          tagline="粘贴一张试卷/练习，自动变成重点词汇清单/学案"
          copy="粘贴整份试卷，自动识别阅读理解、完形填空等题型段落，按需勾选生成。每个词条包含音标、释义、高频搭配与记忆方法，全部可编辑，可生成词汇清单与默写清单，一键导出 CSV / Word。"
          bullets={['自动切分题型段落，按段勾选生成', '音标 / 释义 / 搭配 / 记忆法一应俱全', '词汇学案 / 词汇清单 / 默写清单随心切换']}
          panelTitle="试卷词汇提取 · 高考英语试卷"
          band
        >
          <MockVocab />
        </ShowcaseSection>

        <ShowcaseSection
          icon="practical" title="应用文学案制作"
          tagline="同一个应用文考题，ABC三层学生都能有适合自己水平的范文"
          copy="输入应用文题干，选择基础 / 套路 / 拔高三个层级，生成对应范文、逐段写作分析、话题词汇句式和万能模板，并自动生成分句默写材料。"
          bullets={['基础 / 套路 / 拔高三档范文', '话题词汇句式 + 写作模板', '分句默写翻译练习']}
          panelTitle="应用文学案制作 · 演讲比赛邀请信"
          reverse
        >
          <MockPractical />
        </ShowcaseSection>

        <ShowcaseSection
          icon="copybook" title="衡水体字帖制作"
          tagline="内置衡水体字体，四线三格 / 描红 / 临摹一键成帖"
          copy="粘贴或 AI 生成英文内容，一键生成衡水体练习纸：四线三格 / 两线 / 单线线格，描红、隔行临摹、纯空白三种模式，字号、字距、行距随手调，浏览器直接打印或另存 PDF。"
          bullets={['四线三格 / 两线 / 单线，线格自由切换', '描红 · 隔行临摹 · 纯空白三种模式', '字号 / 字距 / 行距可调，直接打印 PDF']}
          panelTitle="衡水体字帖制作 · 打印预览"
          band
        >
          <MockCopybook />
        </ShowcaseSection>

        <ShowcaseSection
          icon="exampaper" title="试卷排版助手"
          tagline="粘贴或上传整份试卷，AI 解析后重新排版成规整的 Word"
          copy="把排版时间还给教学：粘贴试卷原文或上传 docx / 扫描件 / 照片，AI 按大题解析题型结构、题号、选项与答案，逐项可改，一键导出 A4 / 8K / A3 的 Word 试卷，可附答案页。"
          bullets={['docx / 扫描件 / 照片多入口，不必重新录题', '大题结构 / 题号 / 选项自动对齐', '整卷重排导出 Word，附答案页']}
          panelTitle="试卷排版助手 · 高考英语模拟卷"
          reverse
        >
          <MockExamPaper />
        </ShowcaseSection>
      </div>

      {/* ─── Print-ready worksheet marquee ─── */}
      <PrintMarquee />

      {/* ─── Bottom CTA ─── */}
      <section className="home-bottom-cta">
        <h2>把备课时间还给教学</h2>
        <p>现在注册，即送全功能免费使用额度</p>
        <button className="hero-cta solid" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          ↑ 立即注册
        </button>
      </section>

      <footer className="home-footer">
        <div className="footer-links">
          <button className="footer-link" onClick={() => openInfoModal('privacy')}>隐私与数据说明</button>
          <button className="footer-link" onClick={() => openInfoModal('terms')}>用户协议</button>
          <button className="footer-link" onClick={() => openInfoModal('changelog')}>更新日志</button>
          <button className="footer-link" onClick={() => openInfoModal('feedback')}>反馈与联系</button>
          <button className="footer-link" onClick={onOwnApi}>使用自己的 API Key（高级）</button>
        </div>
        {SITE.icpBeian && (
          <p className="footer-icp">{SITE.icpBeian}</p>
        )}
        <div className="footer-tools">
          <a href="/landing/tools/vocab.html">试卷词汇提取</a>
          <a href="/landing/tools/practical.html">应用文学案制作</a>
          <a href="/landing/tools/continuation.html">读后续写学案制作</a>
          <a href="/landing/tools/worksheet.html">个性化学案</a>
          <a href="/landing/tools/copybook.html">衡水体字帖制作</a>
          <a href="/landing/tools/exampaper.html">试卷排版助手</a>
        </div>
      </footer>

      <InfoModalHost />
    </div>
  );
}
