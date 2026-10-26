import { useState } from 'react';
import './MockWorksheet.css';

/** Landing-page mock panel: 书面表达个性化学案 — pure mock data, no API calls */
export default function MockWorksheet() {
  const [tab, setTab] = useState<'errors' | 'drill' | 'upgrade'>('errors');
  const [imgOk, setImgOk] = useState(true);
  const [printOk, setPrintOk] = useState(true);

  return (
    <div className="mock-worksheet">
      <div className="mock-upload-row">
        {imgOk ? (
          <img className="mock-hw-img" src="/landing/handwriting-sample.jpg" alt="学生答题卡"
            onError={() => setImgOk(false)} />
        ) : (
          <div className="mock-img-placeholder mock-hw-img">📷 答题卡</div>
        )}
        <div className="mock-upload-meta">
          <span className="mock-student-chip">👤 张明 · 高二(3)班</span>
          <span className="mock-ocr-status">✓ 识别完成 · 156 词 · 发现 3 处错误</span>
          <span className="mock-ocr-caption">📷 学生答题卡 → AI 自动识别</span>
        </div>
      </div>

      <div className="mock-pills">
        <button className={`mock-pill ${tab === 'errors' ? 'active' : ''}`} onClick={() => setTab('errors')}>错误分析</button>
        <button className={`mock-pill ${tab === 'drill' ? 'active' : ''}`} onClick={() => setTab('drill')}>巩固默写</button>
        <button className={`mock-pill ${tab === 'upgrade' ? 'active' : ''}`} onClick={() => setTab('upgrade')}>句式提升</button>
      </div>

      {tab === 'errors' && (
        <div className="mock-fade" key="errors">
          <div className="mock-error-row">
            <span className="mock-err-badge">时态</span>
            <div>
              <p className="mock-err-line">✕ I have went to Beijing last year.</p>
              <p className="mock-fix-line">✓ I went to Beijing last year.</p>
            </div>
          </div>
          <div className="mock-error-row">
            <span className="mock-err-badge">逗号粘连</span>
            <div>
              <p className="mock-err-line">✕ The weather is good, we decide to go out.</p>
              <p className="mock-fix-line">✓ The weather was good, so we decided to go out.</p>
            </div>
          </div>
          <div className="mock-error-row">
            <span className="mock-err-badge">非谓语</span>
            <div>
              <p className="mock-err-line">✕ I very like play basketball.</p>
              <p className="mock-fix-line">✓ I really like playing basketball.</p>
            </div>
          </div>
        </div>
      )}

      {tab === 'drill' && (
        <div className="mock-fade" key="drill">
          <p className="mock-drill-item">1. 去年我和家人去了北京。<span className="mock-blank-line" /></p>
          <p className="mock-drill-item">2. 雨下得很大，所以我们待在家里。<span className="mock-blank-line" /></p>
          <p className="mock-drill-item">3. 她喜欢在课后打篮球。<span className="mock-blank-line" /></p>
        </div>
      )}

      {tab === 'upgrade' && (
        <div className="mock-fade" key="upgrade">
          <div className="mock-error-row">
            <span className="mock-up-badge">形容词开头</span>
            <div>
              <p className="mock-orig-line">I was very tired after the trip.</p>
              <p className="mock-fix-line">⬆ Exhausted after the trip, I could hardly move a step.</p>
            </div>
          </div>
          <div className="mock-error-row">
            <span className="mock-up-badge">强调句</span>
            <div>
              <p className="mock-orig-line">I like playing basketball very much.</p>
              <p className="mock-fix-line">⬆ Nothing delights me more than playing basketball.</p>
            </div>
          </div>
          <div className="mock-error-row">
            <span className="mock-up-badge">with 复合结构</span>
            <div>
              <p className="mock-orig-line">The weather was good, so we decided to go out.</p>
              <p className="mock-fix-line">⬆ With the weather so pleasant, we decided to go out.</p>
            </div>
          </div>
        </div>
      )}

      <div className="mock-ws-footer">
        <button className="mock-fake-btn">🖨️ 导出 PDF</button>
        <button className="mock-fake-btn">📄 导出 Word</button>
        <div className="mock-print-preview">
          {printOk ? (
            <img src="/landing/worksheet-print.png" alt="打印效果" onError={() => setPrintOk(false)} />
          ) : (
            <div className="mock-img-placeholder mock-print-ph">📄</div>
          )}
          <span>打印效果</span>
        </div>
      </div>
    </div>
  );
}
