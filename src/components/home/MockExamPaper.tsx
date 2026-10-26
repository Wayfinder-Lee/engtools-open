import './MockExamPaper.css';

const PARSED = [
  { num: '一', title: '听力理解', count: '20 小题', ok: true },
  { num: '二', title: '阅读理解', count: '15 小题 · 4 篇', ok: true },
  { num: '三', title: '完形填空', count: '15 小题', ok: true },
  { num: '四', title: '语法填空', count: '10 小题', ok: true },
  { num: '五', title: '书面表达', count: '1 篇', ok: false },
];

/** Landing-page mock panel: 试卷排版助手 — pure mock data, no API calls */
export default function MockExamPaper() {
  return (
    <div className="mock-exam">
      <div className="mock-exam-source">
        <span className="mock-exam-source-tag">原文粘贴 / docx 上传</span>
        <p className="mock-exam-source-text">
          第二部分 阅读理解<br />A<br />When I was ten, my family moved to a small town in the
          mountains. At first I hated everything about it — the mud, the silence, the long bus
          ride to school…
        </p>
      </div>
      <div className="mock-exam-arrow" aria-hidden="true">✨ AI 按大题解析 ↓</div>
      <div className="mock-exam-structure">
        <div className="mock-exam-structure-head">
          <span>解析结果</span>
          <span className="mock-exam-structure-meta">5 个大题 · 61 小题</span>
        </div>
        {PARSED.map((s, i) => (
          <div key={s.num} className={`mock-exam-row ${s.ok ? '' : 'busy'}`} style={{ animationDelay: `${i * 0.12}s` }}>
            <span className="mock-exam-row-num">{s.num}</span>
            <span className="mock-exam-row-title">{s.title}</span>
            <span className="mock-exam-row-count">{s.count}</span>
            <span className={`mock-exam-row-state ${s.ok ? 'done' : ''}`}>{s.ok ? '✓ 已排版' : '⏳ 解析中'}</span>
          </div>
        ))}
        <div className="mock-exam-export">📄 导出 Word 试卷 · A4 双栏 · 附答案页</div>
      </div>
    </div>
  );
}
