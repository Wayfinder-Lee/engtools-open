import { useState } from 'react';
import './MockContinuation.css';

type View = 'essay' | 'method' | 'patterns';

/** Landing-page mock panel: 读后续写助手 — pure mock data, no API calls */
export default function MockContinuation() {
  const [view, setView] = useState<View>('essay');

  return (
    <div className="mock-continuation">
      <div className="mock-story-card">
        <p>
          …When I finally crossed the finish line, my legs gave way. The crowd burst into
          cheers, but all I could see was Coach Lee standing there, his eyes glistening.
        </p>
        <p className="mock-story-para1">Para 1: A tear rolled down my cheek as I turned to him…</p>
      </div>

      <div className="mock-pills">
        <button className={`mock-pill ${view === 'essay' ? 'active' : ''}`} onClick={() => setView('essay')}>续写范文</button>
        <button className={`mock-pill ${view === 'method' ? 'active' : ''}`} onClick={() => setView('method')}>十句五定法</button>
        <button className={`mock-pill ${view === 'patterns' ? 'active' : ''}`} onClick={() => setView('patterns')}>描写句式</button>
      </div>

      {view === 'essay' && (
        <div className="mock-fade" key="essay">
          <p className="mock-cw-para">
            <strong>A tear rolled down my cheek as I turned to him.</strong> Coach Lee hurried
            over, wrapping his worn jacket around my trembling shoulders. "You made it," he
            whispered, his voice cracking with pride.
          </p>
          <p className="mock-cw-para">
            <strong>The next morning, a package arrived at my dormitory.</strong> Inside lay
            his old stopwatch, the one he had used to time my very first run…
          </p>
        </div>
      )}

      {view === 'method' && (
        <div className="mock-fade" key="method">
          <table className="mock-method-table">
            <thead>
              <tr><th>句序</th><th>定什么</th><th>示例句</th></tr>
            </thead>
            <tbody>
              <tr><td>第1句</td><td>定衔接 · 承接段首句</td><td>A tear rolled down my cheek as I turned to him.</td></tr>
              <tr><td>第2句</td><td>过渡句 · 动作描写</td><td>He hurried over, wrapping his jacket around my shoulders.</td></tr>
              <tr><td>第3句</td><td>过渡句 · 心理描写</td><td>Warmth surged through me, washing away months of doubt.</td></tr>
              <tr className="mock-method-more"><td colSpan={3}>…共 10 句，逐句给出功能与示例</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {view === 'patterns' && (
        <div className="mock-fade" key="patterns">
          <div className="mock-pattern-group">
            <span className="mock-pattern-label">动作</span>
            <span className="mock-chip">sprint down the track</span>
            <span className="mock-chip">clench my fists</span>
          </div>
          <div className="mock-pattern-group">
            <span className="mock-pattern-label">情绪</span>
            <span className="mock-chip">my heart pounded wildly</span>
            <span className="mock-chip">a wave of relief swept over me</span>
          </div>
          <div className="mock-pattern-group">
            <span className="mock-pattern-label">语言</span>
            <span className="mock-chip">"You made it!" he exclaimed.</span>
          </div>
        </div>
      )}
    </div>
  );
}
