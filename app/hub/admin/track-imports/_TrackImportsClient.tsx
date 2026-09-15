'use client';

/**
 * Экран очереди снятых треков.
 *
 * Владелец 15.09: «я сам записывал трек» — и путь к месту не появился.
 * Запись была цела, но увидеть её было неоткуда: единственный вход — крон с
 * секретом. Здесь человек видит свои записи и решает судьбу каждой.
 *
 * Два действия, оба с сухим прогоном по умолчанию:
 *   — приложить трек к СУЩЕСТВУЮЩЕМУ маршруту (по названию);
 *   — завести НОВЫЙ маршрут из трека (имя даёт человек, судья §13 проверяет).
 *
 * Сухой прогон печатает, что получится: сколько точек, какая длина, на какие
 * куски бьётся запись там, где прибор молчал. Применение — вторым нажатием,
 * уже осознанно.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Route as RouteIcon, Check, AlertTriangle } from 'lucide-react';

interface QueueItem {
  id: string;
  created_at: string;
  status: string;
  source_name: string | null;
  format: string | null;
  points: number | null;
  length_km: number | null;
  note: string | null;
  trip_tag: string | null;
  matched: { id: string; title: string | null; off_by_km: number | null } | null;
}

interface ApplyResult {
  success?: boolean;
  dry_run?: boolean;
  applied?: boolean;
  error?: string;
  created_route_id?: string;
  target?: { id: string | null; title: string; will_create?: boolean };
  new_line?: { points: number; length_km: number };
  segments?: Array<{ index: number; points: number; length_km: number; chosen?: boolean }>;
}

const STATUSES = [
  { value: 'pending', label: 'Ждут решения' },
  { value: 'applied', label: 'Применённые' },
  { value: 'all', label: 'Все' },
];

export default function TrackImportsClient() {
  const [status, setStatus] = useState('pending');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/track-imports?status=${status}&limit=50`);
      const data = await res.json() as { ok?: boolean; items?: QueueItem[]; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setItems(data.items ?? []);
    } catch (err) {
      // Пустая очередь и сломанный запрос — разные состояния, и человек
      // должен их различать.
      setError(err instanceof Error ? err.message : 'Не удалось прочитать очередь');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  async function apply(id: string, dryRun: boolean) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/track-imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          dry_run: dryRun,
          ...(mode === 'new' ? { new_route_title: title.trim() } : { route_title: title.trim() }),
        }),
      });
      const data = await res.json() as ApplyResult;
      setResult(data);
      if (!dryRun && data.applied) await load();
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : 'Сеть не ответила' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-20 pb-16 lg:px-6">
      <h1 className="mb-2 text-[26px] font-bold leading-[1.2] text-[var(--text-primary)]"
          style={{ fontFamily: 'var(--font-playfair)' }}>
        Треки из поля
      </h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        Записи, снятые в поле. Трек становится линией маршрута только вашим решением —
        сам он ничего не заменяет.
      </p>

      <div className="mb-6 flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => setStatus(s.value)}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              status === s.value
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-card)] text-[var(--text-primary)]'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {loading && (
        <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Читаем очередь…
        </p>
      )}

      {error && (
        <p className="flex items-start gap-2 rounded-lg bg-[var(--bg-card)] p-4 text-sm text-[var(--danger)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {!loading && !error && items.length === 0 && (
        <p className="rounded-lg bg-[var(--bg-card)] p-5 text-sm text-[var(--text-secondary)]">
          Записей в этом состоянии нет.
        </p>
      )}

      <div className="space-y-4">
        {items.map((t) => (
          <div key={t.id} className="rounded-lg bg-[var(--bg-card)] p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-semibold text-[var(--text-primary)]">
                {t.source_name || 'Запись без имени файла'}
              </p>
              <span className="text-xs text-[var(--text-muted)]">
                {new Date(t.created_at).toLocaleString('ru-RU')}
              </span>
            </div>

            <dl className="mt-3 divide-y divide-[var(--border)] text-sm">
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-[var(--text-secondary)]">Точек</dt>
                <dd className="font-semibold text-[var(--text-primary)]">{t.points ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-[var(--text-secondary)]">Длина</dt>
                <dd className="font-semibold text-[var(--text-primary)]">
                  {t.length_km != null ? `${t.length_km.toLocaleString('ru-RU')} км` : '—'}
                </dd>
              </div>
              {t.matched && (
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-[var(--text-secondary)]">Похож на</dt>
                  <dd className="text-right font-medium text-[var(--text-primary)]">
                    {t.matched.title ?? t.matched.id}
                    {t.matched.off_by_km != null && (
                      <span className="text-[var(--text-muted)]"> · расхождение {t.matched.off_by_km} км</span>
                    )}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-[var(--text-secondary)]">Состояние</dt>
                <dd className="font-semibold text-[var(--text-primary)]">{t.status}</dd>
              </div>
            </dl>

            {t.status === 'pending' && (
              openId === t.id ? (
                <div className="mt-4 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setMode('new')}
                      className={`rounded-lg px-3 py-2 text-sm ${mode === 'new'
                        ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] text-[var(--text-primary)]'}`}
                    >
                      Новый маршрут
                    </button>
                    <button
                      onClick={() => setMode('existing')}
                      className={`rounded-lg px-3 py-2 text-sm ${mode === 'existing'
                        ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] text-[var(--text-primary)]'}`}
                    >
                      К существующему
                    </button>
                  </div>

                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={mode === 'new'
                      ? 'Имя маршрута: «Раздолье — Зеленовские озерки»'
                      : 'Название существующего маршрута'}
                    className="ds-input w-full"
                  />
                  {mode === 'new' && (
                    <p className="text-xs text-[var(--text-muted)]">
                      Имя называет объект или путь — без восклицаний, кавычек-лозунгов и
                      маркетинговых эпитетов (стандарт §13). Имя придумывает человек: код
                      его не сочиняет.
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => apply(t.id, true)}
                      disabled={busy || title.trim().length < 3}
                      className="ds-btn ds-btn-secondary text-sm disabled:opacity-50"
                    >
                      {busy ? 'Считаем…' : 'Проверить (сухой прогон)'}
                    </button>
                    <button
                      onClick={() => apply(t.id, false)}
                      disabled={busy || title.trim().length < 3 || !result?.success}
                      className="ds-btn ds-btn-primary text-sm disabled:opacity-50"
                    >
                      Применить
                    </button>
                    <button
                      onClick={() => { setOpenId(null); setResult(null); }}
                      className="ds-btn ds-btn-secondary text-sm"
                    >
                      Отмена
                    </button>
                  </div>

                  {result && (
                    <div className="rounded-lg bg-[var(--bg-hover)] p-4 text-sm">
                      {result.error ? (
                        <p className="text-[var(--danger)]">{result.error}</p>
                      ) : (
                        <>
                          <p className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
                            {result.applied
                              ? <><Check className="h-4 w-4 text-[var(--success)]" aria-hidden /> Применено</>
                              : <>Сухой прогон: что получится</>}
                          </p>
                          <p className="mt-1 text-[var(--text-secondary)]">
                            {result.target?.will_create ? 'Будет создан маршрут ' : 'Маршрут '}
                            «{result.target?.title}»
                            {result.new_line && `: ${result.new_line.points} точек, ${result.new_line.length_km} км`}
                          </p>
                          {result.created_route_id && (
                            <a
                              href={`/routes/${result.created_route_id}`}
                              className="mt-2 inline-flex items-center gap-1.5 text-[var(--ocean)]"
                            >
                              <RouteIcon className="h-4 w-4" aria-hidden /> Открыть маршрут
                            </a>
                          )}
                          {result.segments && result.segments.length > 1 && (
                            <p className="mt-2 text-xs text-[var(--text-muted)]">
                              Запись бьётся на {result.segments.length} кусков там, где прибор молчал.
                              Применяется вся линия — провалы пройдут прямыми.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => { setOpenId(t.id); setResult(null); setTitle(''); }}
                  className="ds-btn ds-btn-secondary mt-4 text-sm"
                >
                  Сделать маршрутом
                </button>
              )
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
