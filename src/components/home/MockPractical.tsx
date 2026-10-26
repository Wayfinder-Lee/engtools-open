import { useState } from 'react';
import './MockPractical.css';

type Level = 'basic' | 'formula' | 'advanced';

const ESSAYS: Record<Level, { body: string; note: string }> = {
  basic: {
    body: 'I am Li Hua, chairman of the Student Union. I am writing to invite you to be a judge at our English speech contest, which will be held in the school hall at 3 p.m. next Friday.',
    note: '✓ 时态准确 · 结构完整',
  },
  formula: {
    body: 'On behalf of the Student Union, I am writing to sincerely invite you to serve as a judge at our English speech contest scheduled for 3 p.m. next Friday in the school hall.',
    note: '✓ on behalf of 高级开头 · 过去分词后置定语',
  },
  advanced: {
    body: 'It is with great pleasure that I, on behalf of the Student Union, extend to you our sincere invitation to serve as a judge at the upcoming English speech contest, to be held in the school hall at 3 p.m. next Friday.',
    note: '✓ It is with great pleasure that 强调句 · 不定式后置',
  },
};

/** Landing-page mock panel: 应用文助手 — pure mock data, no API calls */
export default function MockPractical() {
  const [level, setLevel] = useState<Level>('formula');

  return (
    <div className="mock-practical">
      <div className="mock-prompt-box">
        假定你是李华，你校将举办英语演讲比赛。请给外教 Chris 写一封邮件，邀请他担任评委。
        内容包括：1. 比赛时间地点；2. 比赛主题；3. 期待回复。
      </div>

      <div className="mock-pills">
        <button className={`mock-pill ${level === 'basic' ? 'active' : ''}`} onClick={() => setLevel('basic')}>基础版</button>
        <button className={`mock-pill ${level === 'formula' ? 'active' : ''}`} onClick={() => setLevel('formula')}>套路版</button>
        <button className={`mock-pill ${level === 'advanced' ? 'active' : ''}`} onClick={() => setLevel('advanced')}>拔高版</button>
      </div>

      <div className="mock-fade" key={level}>
        <div className="mock-essay-preview">
          <p className="mock-essay-salutation">Dear Chris,</p>
          <p className="mock-essay-body">{ESSAYS[level].body}</p>
        </div>
        <p className="mock-essay-note">{ESSAYS[level].note}</p>
      </div>

      <div className="mock-chip-row">
        <span className="mock-chip-label">话题词汇</span>
        <span className="mock-chip">extend an invitation</span>
        <span className="mock-chip">serve as a judge</span>
        <span className="mock-chip">be scheduled for</span>
        <span className="mock-chip">a prompt reply</span>
      </div>
    </div>
  );
}
