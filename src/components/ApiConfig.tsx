import { useState, useEffect } from 'react';
import type { ApiConfig } from '../types';
import './ApiConfig.css';

interface Props {
  config: ApiConfig;
  onSave: (config: ApiConfig) => void;
  forceOpen?: boolean;
}

/** 常用 API 端点快速选择 */
const PRESET_ENDPOINTS: { label: string; url: string }[] = [
  {
    label: 'DeepSeek',
    url: 'https://api.deepseek.com/v1/chat/completions',
  },
  {
    label: '阿里百炼 (DashScope)',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  },
  {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
  },
  {
    label: '自定义',
    url: '',
  },
];

export default function ApiConfig({ config, onSave, forceOpen }: Props) {
  const [collapsed, setCollapsed] = useState(!forceOpen);
  const [endpoint, setEndpoint] = useState(config.endpoint);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (forceOpen) setCollapsed(false);
  }, [forceOpen]);

  const handlePreset = (preset: (typeof PRESET_ENDPOINTS)[number]) => {
    if (preset.label === '自定义') return;
    // 切换到不同服务商时清空 Key：旧服务商的 Key 在新端点必然鉴权失败
    // （防止保存「智谱端点 + 其他供应商 Key」后一直 401 且面板仍显示已配置 ✓）
    const hostOf = (url: string): string => {
      try { return new URL(url).host; } catch { return url; }
    };
    if (hostOf(endpoint) !== hostOf(preset.url)) setApiKey('');
    setEndpoint(preset.url);
  };

  const handleSave = () => {
    // 智能补全：如果用户填了 base URL 但漏了 /chat/completions，自动补上
    let finalEndpoint = endpoint.trim();
    if (finalEndpoint && !finalEndpoint.endsWith('/chat/completions')) {
      // 去掉末尾斜杠，然后加上标准路径
      finalEndpoint = finalEndpoint.replace(/\/+$/, '') + '/chat/completions';
    }
    onSave({ endpoint: finalEndpoint, apiKey: apiKey.trim() });
    setEndpoint(finalEndpoint); // 更新本地显示
    setCollapsed(true);
  };

  return (
    <div className="api-config">
      <div className="api-config-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="api-config-icon">{collapsed ? '▶' : '▼'}</span>
        <span>API 设置</span>
        {apiKey && <span className="api-config-badge">已配置 ✓</span>}
      </div>

      {!collapsed && (
        <div className="api-config-body">
          {/* 快速选择 */}
          <div className="form-group">
            <label>快速选择</label>
            <div className="preset-buttons">
              {PRESET_ENDPOINTS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="preset-btn"
                  onClick={() => handlePreset(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="endpoint">
              API 端点
              <span className="label-hint">（需包含 /chat/completions）</span>
            </label>
            <input
              id="endpoint"
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://api.deepseek.com/v1/chat/completions"
            />
            <span className="field-hint">
              开发模式下通过 Vite 代理转发，不受浏览器 CORS 限制
            </span>
          </div>

          <div className="form-group">
            <label htmlFor="apikey">API Key</label>
            <div className="apikey-input">
              <input
                id="apikey"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
              <button
                type="button"
                className="toggle-key"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>

          <div className="form-actions">
            <button className="btn-save" onClick={handleSave}>
              保存设置
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
