import { useCallback, useEffect, useState } from 'react';
import type { Session } from '../types';
import { apiUsageLogs } from '../services/api';
import type { UsageRow } from '../services/api';
import { opLabel } from '../utils/model';
import { csvFromRows, deltaText, formatDateTime } from '../utils/usageStats';
import './UsageStats.css';

/**
 * 「我的账户 → 额度明细」：充值 + 使用流水表，时间降序。
 * 筛选走服务端 type 过滤（游标分页才能正确续读）；CSV 导出已加载范围。
 */

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'charge', label: '充值' },
  { key: 'spend', label: '使用' },
] as const;

type Filter = (typeof FILTERS)[number]['key'];

const KIND_BADGE: Record<UsageRow['kind'], { text: string; cls: string }> = {
  llm: { text: '使用', cls: 'us-badge-llm' },
  redeem: { text: '充值', cls: 'us-badge-redeem' },
  grant: { text: '赠送', cls: 'us-badge-grant' },
  unlock: { text: '解锁', cls: 'us-badge-unlock' },
  stat: { text: '统计', cls: 'us-badge-stat' },
};

const PAGE_SIZE = 50;

export default function UsageLedger({ session }: { session: Session }) {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async (f: Filter) => {
    setLoading(true);
    setErr('');
    try {
      const r = await apiUsageLogs(session.token, { limit: PAGE_SIZE, type: f });
      setRows(r.rows);
      setNextCursor(r.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load('all');
  }, [load]);

  const changeFilter = (f: Filter) => {
    if (f === filter) return;
    setFilter(f);
    load(f);
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setErr('');
    try {
      const r = await apiUsageLogs(session.token, { limit: PAGE_SIZE, cursor: nextCursor, type: filter });
      setRows((prev) => [...prev, ...r.rows]);
      setNextCursor(r.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败，请稍后重试');
    } finally {
      setLoadingMore(false);
    }
  };

  const downloadCsv = () => {
    const blob = new Blob([csvFromRows(rows)], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `engtools-额度明细-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="us-ledger">
      <div className="us-ledger-bar">
        <div className="us-seg" role="group" aria-label="筛选类型">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`us-seg-btn ${filter === f.key ? 'active' : ''}`}
              onClick={() => changeFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="us-ledger-actions">
          <button type="button" className="us-mini-btn" onClick={() => load(filter)} disabled={loading}>刷新</button>
          <button
            type="button"
            className="us-mini-btn"
            onClick={downloadCsv}
            disabled={loading || rows.length === 0}
            title="导出当前已加载的记录"
          >导出 CSV</button>
        </div>
      </div>

      {err && <p className="us-err">{err}</p>}

      {loading ? (
        <div className="us-loading">明细加载中…</div>
      ) : rows.length === 0 ? (
        <div className="us-empty">暂无记录——生成第一个学案或兑换额度后，这里会出现流水。</div>
      ) : (
        <div className="us-table-wrap">
          <table className="am-table us-table">
            <thead>
              <tr><th>时间</th><th>类型</th><th>项目</th><th className="us-col-delta">变动</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const badge = KIND_BADGE[r.kind] || { text: r.kind, cls: 'us-badge-llm' };
                const delta = deltaText(r);
                return (
                  <tr key={r.sk}>
                    <td className="us-col-time" title={formatDateTime(r.createdAt)}>{formatDateTime(r.createdAt)}</td>
                    <td><span className={`us-badge ${badge.cls}`}>{badge.text}</span></td>
                    <td>
                      {opLabel(r.op)}
                      {r.kind === 'redeem' && r.meta && <span className="us-meta">…{r.meta.slice(-4)}</span>}
                    </td>
                    <td className={`us-col-delta ${delta.positive ? 'pos' : 'neg'}`}>{delta.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && !loading && (
        <div className="us-more-row">
          <button type="button" className="us-mini-btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
