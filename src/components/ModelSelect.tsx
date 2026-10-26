import { useId } from 'react';

interface Props {
  value: string;
  onChange: (model: string) => void;
  /** 预设建议列表（datalist）；用户仍可输入列表外的任意模型名 */
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  title?: string;
  className?: string;
}

/** 自带 Key 模式的模型选择组合框：可从预设中选，也可手输任意 OpenAI 协议模型名。
 *  各功能（词汇/写作/OCR/学案/字帖/试卷）独立持有一份模型名。
 *  登录态不渲染本组件——模型由平台按操作指定。 */
export default function ModelSelect({ value, onChange, options, disabled, title, className = 'model-select' }: Props) {
  const listId = useId();
  return (
    <>
      <input
        className={className}
        style={disabled ? undefined : { cursor: 'text' }}
        list={listId}
        type="text"
        value={value}
        disabled={disabled}
        title={title ?? '模型名：可从列表选择，也可直接输入任意 OpenAI 协议模型'}
        placeholder="模型名，可手动输入"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {options.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </datalist>
    </>
  );
}
