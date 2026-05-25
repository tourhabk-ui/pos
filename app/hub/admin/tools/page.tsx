'use client';

import { useState, useRef } from 'react';
import { Play, Square, CheckCircle, AlertTriangle, Loader2, Map } from 'lucide-react';

interface BatchResult {
  success: boolean;
  imported?: number;
  skipped?: number;
  noMatch?: number;
  errors?: number;
  batch_processed?: number;
  offset?: number;
  next_offset?: number;
  total_ids?: number;
  done?: boolean;
  log?: string[];
  error?: string;
}

interface Totals {
  imported: number;
  skipped: number;
  noMatch: number;
  errors: number;
  processed: number;
  total: number;
}

export default function AdminToolsPage() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  async function runBatch(offset: number, acc: Totals, prevLog: string[]): Promise<void> {
    if (stopRef.current) return;

    let data: BatchResult;
    try {
      const res = await fetch(
        `/api/admin/import-tracks?offset=${offset}&batch=25&skip_existing=true`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      }
      data = await res.json() as BatchResult;
    } catch (err) {
      setError((err as Error).message);
      setRunning(false);
      return;
    }

    if (!data.success) {
      setError(data.error ?? 'Неизвестная ошибка');
      setRunning(false);
      return;
    }

    const newTotals: Totals = {
      imported: acc.imported + (data.imported ?? 0),
      skipped: acc.skipped + (data.skipped ?? 0),
      noMatch: acc.noMatch + (data.noMatch ?? 0),
      errors: acc.errors + (data.errors ?? 0),
      processed: data.next_offset ?? offset + (data.batch_processed ?? 0),
      total: data.total_ids ?? acc.total,
    };
    const newLog = [...prevLog, ...(data.log ?? [])];
    setTotals(newTotals);
    setLog(newLog);

    if (data.done || stopRef.current) {
      setDone(true);
      setRunning(false);
      return;
    }

    await runBatch(data.next_offset ?? offset + 25, newTotals, newLog);
  }

  async function startImport() {
    if (!confirm('Запустить импорт GPS-треков с idilesom.com?')) return;
    stopRef.current = false;
    setRunning(true);
    setDone(false);
    setTotals(null);
    setLog([]);
    setError(null);
    const empty: Totals = { imported: 0, skipped: 0, noMatch: 0, errors: 0, processed: 0, total: 0 };
    await runBatch(0, empty, []);
  }

  function stopImport() {
    stopRef.current = true;
  }

  const pct = totals && totals.total > 0 ? Math.round((totals.processed / totals.total) * 100) : 0;

  return (
    <div className="ds-page py-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="ds-h1 mb-1">Инструменты</h1>
        <p className="text-[var(--text-secondary)] text-sm">Одноразовые операции с данными</p>
      </div>

      <div className="ds-card p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--ocean)]/10 flex items-center justify-center flex-shrink-0">
            <Map className="w-5 h-5 text-[var(--ocean)]" />
          </div>
          <div>
            <h2 className="font-semibold text-[var(--text-primary)]">Импорт GPS-треков с idilesom.com</h2>
            <p className="text-sm text-[var(--text-secondary)] mt-0.5">
              Парсит GPS-треки со всех страниц idilesom.com/kam/places и сопоставляет их с маршрутами
              в нашей БД по географической близости (≤5 км). Обновляет поле geometry в kamchatka_routes.
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Батчи по 25 мест · Пауза 500 мс между запросами · Пропускает маршруты с треком
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={startImport}
            disabled={running}
            className="ds-btn ds-btn-primary flex items-center gap-2 disabled:opacity-60"
          >
            {running
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Обрабатываем...</>
              : <><Play className="w-4 h-4" /> Запустить импорт</>
            }
          </button>
          {running && (
            <button
              type="button"
              onClick={stopImport}
              className="ds-btn ds-btn-secondary flex items-center gap-2"
            >
              <Square className="w-4 h-4" /> Остановить
            </button>
          )}
        </div>

        {running && totals && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-[var(--text-secondary)]">
              <span>Обработано {totals.processed} из {totals.total} мест</span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 rounded-full bg-[var(--bg-hover)] overflow-hidden">
              <div
                className="h-full bg-[var(--ocean)] transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {running && !totals && (
          <p className="text-sm text-[var(--text-secondary)] animate-pulse">
            Собираем список мест с idilesom.com...
          </p>
        )}

        {(totals || error) && (
          <div className={`rounded-lg p-4 border ${error ? 'bg-[var(--danger)]/5 border-[var(--danger)]/20' : done ? 'bg-[var(--success)]/5 border-[var(--success)]/20' : 'bg-[var(--ocean)]/5 border-[var(--ocean)]/20'}`}>
            <div className="flex items-center gap-2 mb-3">
              {error
                ? <AlertTriangle className="w-4 h-4 text-[var(--danger)]" />
                : done
                  ? <CheckCircle className="w-4 h-4 text-[var(--success)]" />
                  : <Loader2 className="w-4 h-4 text-[var(--ocean)] animate-spin" />
              }
              <span className="font-semibold text-sm text-[var(--text-primary)]">
                {error ? 'Ошибка' : done ? 'Готово' : 'В процессе...'}
              </span>
            </div>

            {totals && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  { label: 'Импортировано', value: totals.imported, color: 'var(--success)' },
                  { label: 'Нет трека', value: totals.skipped, color: 'var(--text-muted)' },
                  { label: 'Нет совпадения', value: totals.noMatch, color: 'var(--warning)' },
                  { label: 'Ошибки', value: totals.errors, color: 'var(--danger)' },
                ].map(s => (
                  <div key={s.label} className="text-center">
                    <div className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</div>
                    <div className="text-xs text-[var(--text-muted)]">{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            {error && (
              <p className="text-sm text-[var(--danger)] mb-2">{error}</p>
            )}

            {log.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]">
                  Лог ({log.length} строк)
                </summary>
                <pre className="mt-2 text-[10px] text-[var(--text-secondary)] bg-[var(--bg-primary)] rounded p-3 overflow-auto max-h-64 leading-relaxed">
                  {log.join('\n')}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
