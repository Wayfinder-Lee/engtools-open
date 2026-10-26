import { useState, useEffect } from 'react';
import type { ModuleKey, SavedItem } from '../types';
import { loadHistory, deleteItem, exportAll, importAll } from '../utils/history';
import { Icon } from './icons';
import './HistoryModal.css';

interface Props {
  module: ModuleKey;
  moduleLabel: string;
  onLoad: <T>(item: SavedItem<T>) => void;
  onClose: () => void;
}

export default function HistoryModal({ module, moduleLabel, onLoad, onClose }: Props) {
  const [items, setItems] = useState<SavedItem<unknown>[]>([]);

  useEffect(() => {
    setItems(loadHistory(module));
  }, [module]);

  const handleDelete = (id: string) => {
    if (!window.confirm('确定删除该记录？')) return;
    deleteItem(module, id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  /** M7：全部模块的记录导出为 .json 备份（换设备/清缓存前自救） */
  const handleExport = () => {
    const data = exportAll();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'engtools-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  /** M7：导入备份（按 id 去重合并，不覆盖现有记录） */
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = importAll(data);
      if (!r) throw new Error('bad format');
      const added = r.added;
      setItems(loadHistory(module));
      window.alert(added > 0 ? ('导入完成，新增 ' + added + ' 条记录。注意：备份文件含学生信息，请妥善保管。') : '备份里的记录都已存在，没有新增');
    } catch {
      window.alert('导入失败：文件不是本站导出的备份格式');
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <div className="hm-overlay" onClick={onClose}>
      <div className="hm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hm-header">
          <h3>保存历史 — {moduleLabel}</h3>
          <div className="hm-header-actions">
            <button className="hm-btn hm-btn-load" onClick={handleExport} title="把全部 6 个工具的保存记录导出为 .json 备份文件"><Icon name="download" size={16} /> 导出备份</button>
            <label className="hm-btn hm-btn-load" title="从备份文件导入（与现有记录合并）">
              <Icon name="upload" size={16} /> 导入备份
              <input type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={handleImportFile} />
            </label>
            <button className="hm-close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="hm-body">
          {items.length === 0 ? (
            <p className="hm-empty">暂无保存记录</p>
          ) : (
            <ul className="hm-list">
              {items.map((item) => (
                <li key={item.id} className="hm-item">
                  <div className="hm-item-info">
                    <span className="hm-item-name">{item.autoTitle ? `${item.name} ${item.autoTitle}` : item.name}</span>
                    <span className="hm-item-date">{formatDate(item.savedAt)}</span>
                  </div>
                  <div className="hm-item-actions">
                    <button className="hm-btn hm-btn-load" onClick={() => onLoad(item)}>加载</button>
                    <button className="hm-btn hm-btn-del" onClick={() => handleDelete(item.id)}>删除</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="hm-local-note">以上记录仅保存在本机浏览器：清除浏览器数据或更换设备后不会保留。可「导出备份」换设备迁移——备份文件含学生信息，请妥善保管。</p>
        </div>
      </div>
    </div>
  );
}
