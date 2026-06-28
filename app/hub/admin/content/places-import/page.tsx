'use client';

import { useState } from 'react';
import { MapPin, CheckCircle, XCircle, AlertTriangle, Loader2, Play, Eye, SkipForward, Filter } from 'lucide-react';

interface PlaceResult {
  title: string;
  status: 'imported' | 'skipped' | 'filtered' | 'error' | 'no_coords';
  type?: string;
  has_track?: boolean;
  skip_reason?: string;
  error?: string;
}

interface ImportResult {
  ok: boolean;
  dry_run: boolean;
  total: number;
  imported: number;
  skipped: number;
  filtered: number;
  no_coords: number;
  errors: number;
  duration_ms: number;
  places: PlaceResult[];
  error?: string;
}

const STATUS_ICON: Record<PlaceResult['status'], React.ReactNode> = {
  imported: <CheckCircle size={14} className="text-[var(--success)] shrink-0" />,
  skipped:  <SkipForward  size={14} className="text-[var(--text-muted)] shrink-0" />,
  filtered: <Filter       size={14} className="text-[var(--warning)] shrink-0" />,
  error:    <XCircle      size={14} className="text-[var(--danger)] shrink-0" />,
  no_coords:<AlertTriangle size={14} className="text-[var(--text-muted)] shrink-0" />,
};

const STATUS_LABEL: Record<PlaceResult['status'], string> = {
  imported: 'Добавлено',
  skipped:  'Пропущено',
  filtered: 'Отфильтровано',
  error:    'Ошибка',
  no_coords:'Нет координат',
};

export default function IdilesomImportPage() {
  const [running, setRunning]   = useState(false);
  const [result, setResult]     = useState<ImportResult | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [limitStr, setLimitStr] = useState('');
  const [filter, setFilter]     = useState<PlaceResult['status'] | 'all'>('all');

  async function run(dry_run: boolean) {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { dry_run };
      const lim = parseInt(limitStr, 10);
      if (lim > 0) body.limit = lim;

      const res = await fetch('/api/admin/import/idilesom-places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data: ImportResult = await res.json();
      if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const shown = result?.places.filter(p => filter === 'all' || p.status === filter) ?? [];

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-[var(--ocean)]/15 text-[var(--ocean)]">
          <MapPin size={22} />
        </div>
        <div>
          <h1 className="ds-h2">Импорт мест — idilesom.com</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Пополнение таблицы <code className="text-[var(--ocean)]">places</code> из idilesom.com/kam/places.
            GPS-треки сохраняются в <code className="text-[var(--ocean)]">kamchatka_routes</code>.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="ds-card p-5 space-y-4">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <span>Лимит мест</span>
            <input
              type="number"
              value={limitStr}
              onChange={e => setLimitStr(e.target.value)}
              disabled={running}
              placeholder="все"
              className="ds-input w-24 text-sm"
              min={1}
            />
            <span className="text-[var(--text-muted)]">(пусто = все ~480)</span>
          </label>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => run(true)}
            disabled={running}
            className="ds-btn ds-btn-secondary flex items-center gap-2"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Eye size={16} />}
            Dry-run (предпросмотр)
          </button>
          <button
            onClick={() => run(false)}
            disabled={running}
            className="ds-btn ds-btn-primary flex items-center gap-2"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Запустить импорт
          </button>
        </div>

        {running && (
          <p className="text-sm text-[var(--text-secondary)] flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            Парсим ~480 страниц, это займёт 1–5 минут…
          </p>
        )}
      </div>

      {error && (
        <div className="ds-card p-4 border border-[var(--danger)]/30 text-[var(--danger)] text-sm">
          {error}
        </div>
      )}

      {result && (
        <>
          {/* Summary */}
          <div className="ds-card p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
              {result.dry_run && (
                <span className="ds-badge bg-[var(--warning)]/15 text-[var(--warning)] px-2 py-0.5 text-xs">DRY-RUN</span>
              )}
              <span>Готово за {(result.duration_ms / 1000).toFixed(1)} с · обработано {result.total} страниц</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                { label: 'Добавлено',       val: result.imported,  color: 'var(--success)' },
                { label: 'Пропущено',       val: result.skipped,   color: 'var(--text-muted)' },
                { label: 'Отфильтровано',   val: result.filtered,  color: 'var(--warning)' },
                { label: 'Нет координат',   val: result.no_coords, color: 'var(--text-muted)' },
                { label: 'Ошибки',          val: result.errors,    color: 'var(--danger)' },
              ].map(s => (
                <div key={s.label} className="text-center p-3 rounded-lg bg-[var(--bg-hover)]">
                  <div className="text-2xl font-bold" style={{ color: s.color }}>{s.val}</div>
                  <div className="text-xs text-[var(--text-muted)] mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Filter tabs */}
          {result.places.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {(['all', 'imported', 'skipped', 'filtered', 'error', 'no_coords'] as const).map(s => {
                const count = s === 'all'
                  ? result.places.length
                  : result.places.filter(p => p.status === s).length;
                if (count === 0) return null;
                return (
                  <button
                    key={s}
                    onClick={() => setFilter(s)}
                    className={`text-xs px-3 py-1 rounded-full border transition-all ${
                      filter === s
                        ? 'bg-[var(--ocean)] text-white border-[var(--ocean)]'
                        : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--ocean)]'
                    }`}
                  >
                    {s === 'all' ? 'Все' : STATUS_LABEL[s]} ({count})
                  </button>
                );
              })}
            </div>
          )}

          {/* Results list */}
          <div className="ds-card divide-y divide-[var(--border)] overflow-hidden">
            {shown.length === 0 && (
              <div className="p-4 text-sm text-[var(--text-muted)] text-center">Нет записей</div>
            )}
            {shown.slice(0, 500).map((p, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-2.5 hover:bg-[var(--bg-hover)] transition-colors">
                {STATUS_ICON[p.status]}
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-[var(--text-primary)] line-clamp-1">{p.title}</span>
                  {p.type && p.type !== 'other' && (
                    <span className="ml-2 text-xs text-[var(--ocean)]">{p.type}</span>
                  )}
                  {p.has_track && (
                    <span className="ml-2 text-xs text-[var(--success)]">+ трек</span>
                  )}
                  {p.skip_reason && (
                    <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{p.skip_reason}</div>
                  )}
                  {p.error && (
                    <div className="text-xs text-[var(--danger)] mt-0.5 truncate">{p.error}</div>
                  )}
                </div>
                <span className="text-xs text-[var(--text-muted)] shrink-0">{STATUS_LABEL[p.status]}</span>
              </div>
            ))}
            {shown.length > 500 && (
              <div className="p-3 text-xs text-[var(--text-muted)] text-center">
                + ещё {shown.length - 500} записей не отображено
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
