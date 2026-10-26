import { useEffect, useRef, useState } from 'react';
import type { ApiConfig } from '../types';
import { OCR_DEFAULT_MODEL, OCR_MODEL_OPTIONS } from '../types';
import { describeError, readPromptImage } from '../services/llm';
import { isPhotoFile, photoToDataUrl, PHOTO_ACCEPT } from '../services/visionExtract';
import { getEffectiveModel } from '../utils/model';
import { useCostGate } from './CostGate';
import ModelSelect from './ModelSelect';
import { Icon } from './icons';
import './PromptImageReader.css';

/**
 * 看图/图表作文：题干配图上传 + AI 读图转文字（两步法第一步）。
 * 读图结果以【图片内容】块回调 onInsert 并入题干，由老师核对编辑；
 * 生成流程不变（生成模型无需视觉能力）。图片只留在内存，不进任何持久化。
 * 错误一律行内显示——父组件的 ErrorBar 重试键挂着各自的生成动作，接过去会误触发。
 */

interface Props {
  apiConfig: ApiConfig;
  /** 登录用户余额；null = 自带 Key 模式（模型自选，走自配 endpoint） */
  quota: number | null | undefined;
  /** 父组件忙态（生成中等），禁用交互 */
  disabled?: boolean;
  /** 读图成功：收到待并入题干的文本块 */
  onInsert: (block: string) => void;
}

/** 原图体积上限（读图前会压到 2048px JPEG，这里只拦异常大的原文件） */
const MAX_RAW_BYTES = 20 * 1024 * 1024;

export default function PromptImageReader({ apiConfig, quota, disabled, onInsert }: Props) {
  const serverMode = quota != null;
  const [model, setModel] = useState(OCR_DEFAULT_MODEL);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { confirmSpend, costDialog } = useCostGate(quota);

  // object URL 生命周期：替换/移除/卸载一律 revoke，防泄漏
  const previewRef = useRef('');
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);
  const applyPreview = (url: string) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreviewUrl(url);
  };

  const clearImage = () => {
    setFile(null);
    setErr('');
    applyPreview('');
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // 允许重选同一文件
    if (!f) return;
    if (!isPhotoFile(f)) { setErr('仅支持 JPG / PNG / WebP 图片'); return; }
    if (f.size > MAX_RAW_BYTES) { setErr('图片过大（超过 20MB），请压缩后重试'); return; }
    setErr('');
    setFile(f);
    applyPreview(URL.createObjectURL(f));
  };

  const handleRead = async () => {
    if (!file || busy) return;
    if (!apiConfig.apiKey.trim() && !serverMode) { setErr('请先登录或填入 API Key'); return; }
    setErr('');
    if (!(await confirmSpend(1, 'AI 读图（题干配图转文字）'))) return;
    setBusy(true);
    try {
      const dataUrl = await photoToDataUrl(file);
      const text = await readPromptImage(apiConfig, getEffectiveModel('prompt_vision', model), dataUrl);
      onInsert(`【图片内容（AI 读图，请核对）】\n${text}`);
      setFile(null); // 文字已落题干，弃图存文
      applyPreview('');
    } catch (e) {
      setErr(describeError(e).message); // 保留 file/preview，重试免重选
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pir">
      <input ref={inputRef} type="file" accept={PHOTO_ACCEPT} onChange={handleFileChange} hidden />
      {!file ? (
        <div className="pir-row">
          <button type="button" className="pir-chip" disabled={disabled}
            onClick={() => inputRef.current?.click()}><Icon name="image" size={16} /> 看图/图表作文？上传配图，AI 转成文字题干</button>
          {serverMode && <span className="pir-hint">AI 读图 1 额度</span>}
        </div>
      ) : (
        <div className="pir-preview">
          <img className="pir-thumb" src={previewUrl} alt="题干配图预览" />
          <span className="pir-name" title={file.name}>{file.name}</span>
          {!serverMode && (
            <ModelSelect className="pir-model" value={model} onChange={setModel}
              options={OCR_MODEL_OPTIONS} disabled={busy || disabled} title="读图模型（需视觉能力）" />
          )}
          <button type="button" className="pir-read" disabled={busy || disabled} onClick={handleRead}>
            {busy ? '读图中…' : (<><Icon name="search" size={16} /> AI 读图{serverMode ? ' · 1 额度' : ''}</>)}
          </button>
          <button type="button" className="pir-remove" disabled={busy} onClick={clearImage}
            title="移除图片">✕</button>
        </div>
      )}
      {busy && <div className="pir-busy">正在读图：图表数字会逐项转写，完成后请核对…</div>}
      {err && (
        <div className="pir-error" role="alert">
          <span>{err}</span>
          {file && !busy && (
            <button type="button" className="pir-retry" onClick={handleRead}>↻ 重试</button>
          )}
        </div>
      )}
      {costDialog}
    </div>
  );
}
