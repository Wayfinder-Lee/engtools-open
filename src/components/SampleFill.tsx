import { Icon } from './icons';
import './SampleFill.css';

/**
 * 空状态示例入口（W3 新手激活包）：「空白画布是最大激活杀手」——
 * 真实成品范例 + 一键填充示例，让新教师不用先会「喂提示词」。
 */
interface Props {
  onFill: () => void;
  /** 工具名（如「试卷词汇提取」），用于文案 */
  toolName?: string;
}

export default function SampleFill({ onFill, toolName }: Props) {
  return (
    <div className="sample-fill">
      <span className="sample-fill-icon"><Icon name="eye" size={18} /></span>
      <span className="sample-fill-text">
        不知道{toolName ?? '这个工具'}的成品长什么样？点右边用示例内容试一试，填充后可自行修改。
      </span>
      <button className="sample-fill-btn" onClick={onFill}>用示例试一试</button>
    </div>
  );
}
