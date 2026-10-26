import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  /** 卡片归属者标签（如学生姓名），用于报错文案与控制台定位 */
  label: string;
  /** 提供「清除该生结果以便重新生成」的出口；不传则只展示报错 */
  onReset?: () => void;
  children: ReactNode;
}

interface State { error: Error | null; }

/**
 * 单卡渲染边界：LLM 脏数据（缺字段/类型不符）在渲染期抛 TypeError 时，
 * 只报废这一张卡片，不再让 React 卸载整棵树导致整页白屏。
 * 每张学生学案卡各包一层，互不影响。
 */
export default class ResultErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[渲染异常] ${this.props.label}`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-msg hw-gen-fail-row hw-render-error">
          <span>✕</span>
          <span>
            {this.props.label}：该份学案数据异常，无法正常显示（{this.state.error.message}）。
            {this.props.onReset && (
              <> 可<button className="hw-btn-sm hw-dl-btn hw-render-error-btn" onClick={() => { this.setState({ error: null }); this.props.onReset?.(); }}>
                清除本份学案
              </button>后回第 ② 步重新生成。</>
            )}
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}
