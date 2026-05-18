'use client';

import { useState, useCallback, useEffect } from 'react';
import { Map, CheckCircle, XCircle, Loader2, Play, RotateCcw, BarChart3 } from 'lucide-react';

interface RouteResult {
  id: string;
  title: string;
  ok?: boolean;
  len?: number;
  error?: string;
  status?: string;
}

interface StatsData {
  total: number;
  no_desc: number;
  short_desc: number;
  needs_desc: number;
  good_desc: number;
}

interface BatchResponse {
  success: boolean;
  mode: string;
  dryRun: boolean;
  processed: number;
  remaining: number;
  results: RouteResult[];
  failed?: number;
}

export default function EnrichRoutesPage() {
  const [running, setRunning]   = useState(false);
  const [force, setForce]       = useState(false);
  const [dryRun, setDryRun]     = useState(false);
  const [mode, setMode]         = useState<'description' | 'payload'>('description');
  const [batch, setBatch]       = useState(10);
  const [log, setLog]           = useState<RouteResult[]>([]);
  const [processed, setProcessed] = useState(0);
  const [batches, setBatches]   = useState(0);
  const [finished, setFinished] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [stats, setStats]       = useState<StatsData | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/enrich-routes');
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch {}
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const runBatch = useCallback(async (): Promise<boolean> => {
    const res = await fetch('/api/admin/enrich-routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch, force, dryRun, mode }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: BatchResponse = await res.json();

    setLog(prev => [...data.results, ...prev]);
    setProcessed(prev => prev + data.processed);
    setBatches(prev => prev + 1);

    return (data.remaining ?? 0) > 0;
  }, [batch, force, dryRun, mode]);

  const start = useCallback(async () => {
    setRunning(true);
    setFinished(false);
    setError(null);
    setLog([]);
    setProcessed(0);
    setBatches(0);

    try {
      let hasMore = true;
      while (hasMore) {
        hasMore = await runBatch();
      }
      setFinished(true);
      loadStats();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [runBatch, loadStats]);

  const reset = () => {
    setLog([]); setProcessed(0); setBatches(0); setFinished(false); setError(null);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">

      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-[var(--ocean)]/15 text-[var(--ocean)]">
          <Map size={22} />
        </div>
        <div>
          <h1 className="ds-h2">Обогащение маршрутов</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            AI дописывает описания и метаданные маршрутов (сложность, сезон, снаряжение, опасности)
          </p>
        </div>
      </div>

      {stats && (
        <div className="ds-card p-4 flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <BarChart3 size={16} className="text-[var(--text-muted)]" />
            <span className="text-sm text-[var(--text-secondary)]">Всего маршрутов:</span>
            <span className="text-sm font-medium text-[var(--text-primary)]">{stats.total}</span>
          </div>
          <div className="h-4 w-px bg-[var(--border)]" />
          <span className="text-sm text-[var(--danger)]">Без описания: {stats.no_desc}</span>
          <span className="text-sm text-[var(--warning)]">Короткие: {stats.short_desc}</span>
          <span className="text-sm text-[var(--success)]">Полные: {stats.good_desc}</span>
        </div>
      )}

      <div className="ds-card p-5 space-y-4">
        <div className="flex flex-wrap gap-4 items-center">
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <span>Режим</span>
            <select
              value={mode}
              onChange={e => setMode(e.target.value as 'description' | 'payload')}
              disabled={running}
              className="ds-input text-sm"
            >
              <option value="description">Описания</option>
              <option value="payload">Метаданные (цена, сложность, сезон)</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <span>Батч</span>
            <select
              value={batch}
              onChange={e => setBatch(Number(e.target.value))}
              disabled={running}
              className="ds-input w-20 text-sm"
            >
              {[5, 10, 20, 30].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} disabled={running} className="rounded" />
            Перезаписать всё
          </label>

          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} disabled={running} className="rounded" />
            Dry run
          </label>
        </div>

        <div className="flex gap-3">
          <button onClick={start} disabled={running} className="ds-btn ds-btn-primary flex items-center gap-2">
            {running
              ? <><Loader2 size={16} className="animate-spin" /> Обогащаю...</>
              : <><Play size={16} /> Запустить</>
            }
          </button>
          {(finished || error) && (
            <button onClick={reset} className="ds-btn ds-btn-secondary flex items-center gap-2">
              <RotateCcw size={16} /> Сбросить
            </button>
          )}
        </div>

        {batches > 0 && (
          <p className="text-sm text-[var(--text-secondary)]">
            Батчей: {batches} · Обработано: <span className="text-[var(--success)] font-medium">{processed}</span>
          </p>
        )}
        {finished && (
          <p className="text-sm font-medium text-[var(--success)] flex items-center gap-2">
            <CheckCircle size={15} /> Готово
          </p>
        )}
        {error && <p className="text-sm text-[var(--danger)]">Ошибка: {error}</p>}
      </div>

      {log.length > 0 && (
        <div className="ds-card overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <p className="text-sm font-medium text-[var(--text-primary)]">Лог ({log.length} записей)</p>
          </div>
          <div className="divide-y divide-[var(--border)] max-h-[60vh] overflow-y-auto">
            {log.map((r, i) => {
              const ok = r.ok ?? (r.status === 'enriched' || r.status === 'dry_run');
              return (
                <div key={i} className="px-4 py-2.5 flex items-start gap-3 text-sm">
                  {ok
                    ? <CheckCircle size={14} className="shrink-0 mt-0.5 text-[var(--success)]" />
                    : <XCircle    size={14} className="shrink-0 mt-0.5 text-[var(--danger)]" />
                  }
                  <span className="flex-1 text-[var(--text-primary)]">{r.title}</span>
                  {ok
                    ? <span className="text-[var(--text-muted)] shrink-0 text-xs">{r.len ? `${r.len} симв.` : r.status}</span>
                    : <span className="text-[var(--danger)] shrink-0 text-xs">{r.error ?? r.status}</span>
                  }
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
