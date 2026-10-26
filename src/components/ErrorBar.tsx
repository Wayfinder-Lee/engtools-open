import { describeError } from '../services/llm';
import { openInfoModal } from './InfoModal';
import { Icon } from './icons';
import './ErrorBar.css';

/**
 * 通用错误条（W8）：人话文案 + 可展开的原始信息 + 重试 + 反馈现场入口。
 * 替换原先各 tab 直出 `API 请求失败 (429): {...英文 JSON}` 的裸错误条。
 */
interface Props {
  error: unknown;
  /** 提供则显示「重试」按钮（重新执行生成动作，内部会重新校验余额等前置条件） */
  onRetry?: () => void;
  /** 追加前缀（如「第 3 段：」） */
  prefix?: string;
  /** 覆盖容器类（Copybook 等非 sf 布局的 tab 传自己的错误条类名） */
  className?: string;
}

export default function ErrorBar({ error, onRetry, prefix, className }: Props) {
  const { message, detail } = describeError(error);
  return (
    <div className={`sf-sticky-error error-bar ${className ?? ''}`} role="alert">
      <div className="error-bar-row">
        <span className="error-bar-icon">✕</span>
        <span className="error-bar-text">{prefix}{message}</span>
        {onRetry && (
          <button className="error-bar-btn" onClick={onRetry}><Icon name="refresh" size={14} /> 重试</button>
        )}
        <button
          className="error-bar-btn error-bar-feedback"
          onClick={() => openInfoModal('feedback')}
          title="反馈时会带上所在工具与错误类型，不含你的输入内容"
        >
          反馈此问题
        </button>
      </div>
      {detail && (
        <details className="error-bar-detail">
          <summary>原始信息（供反馈时参考）</summary>
          <pre>{detail}</pre>
        </details>
      )}
    </div>
  );
}
