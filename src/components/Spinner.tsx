import { useState, useEffect, useRef } from 'react';
import './Spinner.css';

/** 通用轮播文案：不带任何具体工具的语境，供未注入文案集的调用方兜底 */
const DEFAULT_STATUS_MESSAGES = [
  '正在调用模型，通常需要 30 秒到 2 分钟...',
  '正在逐段生成内容...',
  '正在检查与整理输出...',
  '即将完成，请耐心等待...',
];

/** 词汇提取专用（W7：此前被其他工具误复用，引发「怎么在提取词汇」的困惑） */
export const VOCAB_STATUS_MESSAGES = [
  '正在分析试卷结构...',
  '正在识别主旨句和依据句...',
  '正在提取关键目标词汇...',
  '正在生成释义和例句...',
  '正在整理搭配和记忆辅助...',
  '即将完成，请耐心等待...',
];

interface Props {
  text?: string;
  /** 是否显示进度指示（计时器 + 状态轮播） */
  showProgress?: boolean;
  /** 进度轮播文案集（W7：按工具/任务语境注入，避免文案与任务错位） */
  messages?: string[];
}

export default function Spinner({ text, showProgress = false, messages }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [statusIndex, setStatusIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusMessages = messages ?? DEFAULT_STATUS_MESSAGES;

  useEffect(() => {
    if (!showProgress) return;

    // 计时器每秒 +1
    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);

    // 状态轮播每 4 秒切换
    statusRef.current = setInterval(() => {
      setStatusIndex((prev) => (prev + 1) % statusMessages.length);
    }, 4000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (statusRef.current) clearInterval(statusRef.current);
    };
  }, [showProgress, statusMessages.length]);

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds} 秒`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m} 分 ${s} 秒`;
  };

  return (
    <div className="spinner-overlay">
      <div className="spinner-content">
        <div className="spinner" />
        <p className="spinner-text">{text || '正在生成，请稍候...'}</p>
        {showProgress && (
          <div className="spinner-progress">
            <p className="spinner-elapsed">⏱ 已等待 {formatTime(elapsed)}</p>
            <p className="spinner-status">{statusMessages[statusIndex % statusMessages.length]}</p>
          </div>
        )}
      </div>
    </div>
  );
}
