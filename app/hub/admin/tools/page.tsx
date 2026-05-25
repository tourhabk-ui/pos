'use client';

import { useState } from 'react';
import { Download, Play, CheckCircle, AlertTriangle, Loader2, Map } from 'lucide-react';

export default function AdminToolsPage() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    imported?: number;
    skipped?: number;
    noMatch?: number;
    errors?: number;
    total_processed?: number;
    log?: string[];
    error?: string;
  } | null>(null);

  async function runImport() {
    if (!confirm('Запустить импорт GPS-треков с idilesom.com? Займёт 5–15 минут.')) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/import-tracks?limit=500&skip_existing=true', { method: 'POST' });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ success: false, error: (err as Error).message });
    } finally {
      setRunning(false);
    }
  }

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
              Пропускает маршруты у которых уже есть трек · Пауза 800 мс между запросами · До 500 мест за раз
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={runImport}
          disabled={running}
          className="ds-btn ds-btn-primary flex items-center gap-2 disabled:opacity-60"
        >
          {running
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Импорт идёт...</>
            : <><Play className="w-4 h-4" /> Запустить импорт</>
          }
        </button>

        {running && (
          <p className="text-sm text-[var(--text-secondary)] animate-pulse">
            Обрабатываем страницы idilesom.com... Это займёт несколько минут.
          </p>
        )}

        {result && (
          <div className={`rounded-lg p-4 border ${result.success ? 'bg-[var(--success)]/5 border-[var(--success)]/20' : 'bg-[var(--danger)]/5 border-[var(--danger)]/20'}`}>
            <div className="flex items-center gap-2 mb-3">
              {result.success
                ? <CheckCircle className="w-4 h-4 text-[var(--success)]" />
                : <AlertTriangle className="w-4 h-4 text-[var(--danger)]" />
              }
              <span className="font-semibold text-sm text-[var(--text-primary)]">
                {result.success ? 'Готово' : 'Ошибка'}
              </span>
            </div>

            {result.success && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  { label: 'Импортировано', value: result.imported ?? 0, color: 'var(--success)' },
                  { label: 'Нет трека', value: result.skipped ?? 0, color: 'var(--text-muted)' },
                  { label: 'Нет совпадения', value: result.noMatch ?? 0, color: 'var(--warning)' },
                  { label: 'Ошибки', value: result.errors ?? 0, color: 'var(--danger)' },
                ].map(s => (
                  <div key={s.label} className="text-center">
                    <div className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</div>
                    <div className="text-xs text-[var(--text-muted)]">{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            {result.error && (
              <p className="text-sm text-[var(--danger)] mb-2">{result.error}</p>
            )}

            {result.log && result.log.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]">
                  Лог ({result.log.length} строк)
                </summary>
                <pre className="mt-2 text-[10px] text-[var(--text-secondary)] bg-[var(--bg-primary)] rounded p-3 overflow-auto max-h-64 leading-relaxed">
                  {result.log.join('\n')}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
