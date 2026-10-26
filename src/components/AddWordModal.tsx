import { useState } from 'react';
import type { ApiConfig, Stage, VocabItem } from '../types';
import { generateWordInfo } from '../services/llm';
import { apiUnlockWordLimit } from '../services/api';
import Spinner from './Spinner';
import { loadSession } from '../utils/session';
import { Icon } from './icons';
import './AddWordModal.css';

interface Props {
  apiConfig: ApiConfig;
  model: string;
  sectionName?: string;
  stage: Stage;
  /** 服务端计费模式（登录或游客）；false = 自带 Key */
  serverMode?: boolean;
  onAdd: (item: VocabItem, sectionName?: string) => void;
  onClose: () => void;
}

export default function AddWordModal({ apiConfig, model, sectionName, stage, serverMode, onAdd, onClose }: Props) {
  const [word, setWord] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showUnlock, setShowUnlock] = useState(false);

  const handleGenerate = async () => {
    const trimmed = word.trim();
    if (!trimmed) { setError('请输入单词或词组'); return; }
    if (!apiConfig.apiKey.trim() && !serverMode) { setError('请先登录或填入 API Key'); return; }

    setError(''); setShowUnlock(false); setLoading(true);

    try {
      const result = await generateWordInfo(apiConfig, model, trimmed, stage);
      onAdd(result, sectionName);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '生成失败';
      // 402 = 今日免费次数用完，需解锁
      if (e && typeof e === 'object' && (e as { status?: number }).status === 402) {
        setShowUnlock(true);
        setError(msg);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleUnlock = async () => {
    const sess = loadSession();
    if (!sess) { setError('请先登录'); return; }
    setLoading(true);
    try {
      await apiUnlockWordLimit(sess.token);
      setShowUnlock(false);
      // 解锁成功后自动重试
      const result = await generateWordInfo(apiConfig, model, word.trim(), stage);
      onAdd(result, sectionName);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '解锁失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3><Icon name="pencil" size={18} /> 自定义添加单词</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <p className="modal-desc">
            输入任意单词或词组，AI 将自动生成完整的词汇学习信息（释义、例句、搭配、记忆辅助等）。
          </p>
          {sectionName && <p className="modal-section-hint">将添加到「{sectionName}」分组</p>}

          <div className="modal-input-row">
            <input
              type="text"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              placeholder={stage === 'junior' ? '输入单词，如：necessary' : '输入单词，如：perseverance'}
              disabled={loading}
              onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
              autoFocus
            />
          </div>

          {error && (
            <div className="error-msg">
              <span>✕</span> {error}
            </div>
          )}

          {showUnlock && (
            <div className="unlock-bar">
              <p>今日免费次数已用完（50次/天）。支付 <strong>1 credit</strong> 解除今日限制。</p>
              <button className="btn-unlock" onClick={handleUnlock} disabled={loading}>
                {loading ? '请稍候…' : '支付 1 credit 解锁'}
              </button>
            </div>
          )}

          {loading && <Spinner text="正在生成词汇信息..." />}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button
            className="btn-generate"
            onClick={handleGenerate}
            disabled={loading || !word.trim()}
          >
            {loading ? '生成中...' : (<><Icon name="sparkles" size={16} /> 生成词汇信息</>)}
          </button>
        </div>
      </div>
    </div>
  );
}
