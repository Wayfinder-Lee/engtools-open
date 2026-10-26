import { useState } from 'react';
import './MockVocab.css';

type View = 'table' | 'list' | 'dictation';

/** Landing-page mock panel: 词汇提取 — pure mock data, no API calls */
export default function MockVocab() {
  const [cloze, setCloze] = useState(false);
  const [view, setView] = useState<View>('table');

  const sections = [
    { name: '阅读理解 A', words: '~420 词', status: <span className="mock-status-chip done">✓ 已完成</span>, checked: true },
    { name: '阅读理解 B', words: '~380 词', status: <span className="mock-status-chip busy">生成中</span>, checked: true },
    { name: '完形填空', words: '~310 词', status: <span className="mock-status-chip pending">⏸ 待生成</span>, checked: cloze },
  ];

  return (
    <div className="mock-vocab">
      <div className="mock-section-list">
        {sections.map((s, i) => (
          <label key={i} className={`mock-section-row ${s.checked ? 'checked' : ''}`}>
            <input type="checkbox" checked={s.checked} readOnly={i < 2}
              onChange={i === 2 ? () => setCloze(v => !v) : undefined} />
            <span className="mock-section-name">{s.name}</span>
            <span className="mock-section-words">{s.words}</span>
            {i === 2 && cloze ? <span className="mock-status-chip busy">生成中</span> : s.status}
          </label>
        ))}
      </div>

      <div className="mock-pills">
        <button className={`mock-pill ${view === 'table' ? 'active' : ''}`} onClick={() => setView('table')}>词汇学案</button>
        <button className={`mock-pill ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}>词汇清单</button>
        <button className={`mock-pill ${view === 'dictation' ? 'active' : ''}`} onClick={() => setView('dictation')}>默写清单</button>
      </div>

      {view === 'table' && (
        <div className="mock-fade" key="table">
          <div className="mock-vocab-scroll">
            <table className="mock-vocab-table">
              <thead>
                <tr><th>词汇</th><th>音标</th><th>释义</th><th>搭配</th><th>记忆法</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>accommodate</td><td>/əˈkɒmədeɪt/</td>
                  <td><span className="mock-editable" title="双击可编辑">v. 容纳；适应</span></td>
                  <td>accommodate oneself to</td><td>词根：com(共同)+mod(方式)</td>
                </tr>
                <tr><td>controversial</td><td>/ˌkɒntrəˈvɜːʃl/</td><td>adj. 有争议的</td><td>a controversial issue</td><td>contro(相反)+vers(转)</td></tr>
                <tr><td>phenomenon</td><td>/fəˈnɒmɪnən/</td><td>n. 现象</td><td>a social phenomenon</td><td>复数 phenomena</td></tr>
                <tr><td>substantial</td><td>/səbˈstænʃl/</td><td>adj. 大量的</td><td>make substantial progress</td><td>sub+stant(站)→实在的</td></tr>
                <tr><td>undertake</td><td>/ˌʌndəˈteɪk/</td><td>v. 承担；着手</td><td>undertake a task</td><td>under+take→接手</td></tr>
              </tbody>
            </table>
          </div>
          <p className="mock-edit-hint">✏️ 每个词条都可直接编辑、排序、删除</p>
        </div>
      )}

      {view === 'list' && (
        <div className="mock-fade mock-word-list" key="list">
          <p>1. <strong>accommodate</strong> v. 容纳；适应</p>
          <p>2. <strong>controversial</strong> adj. 有争议的</p>
          <p>3. <strong>phenomenon</strong> n. 现象</p>
          <p>4. <strong>substantial</strong> adj. 大量的</p>
          <p>5. <strong>undertake</strong> v. 承担；着手</p>
          <p className="mock-list-more">…共 32 词，可按题型段落分组</p>
        </div>
      )}

      {view === 'dictation' && (
        <div className="mock-fade mock-dict-list" key="dictation">
          <p>1. v. 容纳；适应 <span className="mock-dict-blank">a____________</span></p>
          <p>2. adj. 有争议的 <span className="mock-dict-blank">c____________</span></p>
          <p>3. n. 现象 <span className="mock-dict-blank">p____________</span></p>
          <p>4. adj. 大量的 <span className="mock-dict-blank">s____________</span></p>
          <p>5. v. 承担；着手 <span className="mock-dict-blank">u____________</span></p>
          <p className="mock-list-more">…首字母提示，可直接打印默写</p>
        </div>
      )}

      <div className="mock-vocab-footer">
        <button className="mock-fake-btn">📥 导出 CSV</button>
        <button className="mock-fake-btn">📄 导出 Docx 学案</button>
      </div>
    </div>
  );
}
