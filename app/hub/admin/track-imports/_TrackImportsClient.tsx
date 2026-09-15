'use client';

/**
 * Экран очереди снятых треков.
 *
 * Владелец 15.09: «я сам записывал трек» — и путь к месту не появился.
 * Запись была цела, но увидеть её было неоткуда: единственный вход — крон с
 * секретом. Здесь человек видит свои записи и решает судьбу каждой.
 *
 * ── Запись показывается ЛИНИЕЙ, а не столбцом чисел ───────────────────────
 *
 * Первая редакция этого экрана печатала запись величинами: точек, длина,
 * состояние `pending`. Слово владельца на неё — «это кринж», и оно по делу:
 * «1240 точек, 8.3 км» — это и подъём на вулкан, и круг по посёлку. Человек,
 * прошедший маршрут ногами, узнаёт свой выход по ФОРМЕ, и ни по чему больше.
 *
 * Линия приходит из `/api/admin/track-imports/[id]/line` и рисуется по §12:
 * куски записи — снятым путём, прямые через молчание прибора — построением.
 * Склеить их в одну сплошную значило бы обещать проход там, где прибор
 * терял небо.
 *
 * Два действия, оба с сухим прогоном по умолчанию:
 *   — приложить трек к СУЩЕСТВУЮЩЕМУ маршруту (по названию);
 *   — завести НОВЫЙ маршрут из трека (имя даёт человек, судья §13 проверяет).
 */

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Loader2, Route as RouteIcon, Check, AlertTriangle, MapPinOff } from 'lucide-react';
import type { MapMarker } from '@/components/shared/leaflet-types';
import { trackLine, connectorLine } from '@/lib/map/line-standard';
import type { TrackPreview } from '@/lib/field/track-preview';

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false });

interface QueueItem {
  id: string;
  created_at: string;
  status: string;
  source_name: string | null;
  format: string | null;
  points: number | null;
  length_km: number | null;
  timespan_min: number | null;
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

/** Что известно о форме записи: ещё не спрашивали, не смогли, вот она. */
type LineState =
  | { kind: 'loading' }
  | { kind: 'failed'; reason: string }
  | { kind: 'ready'; preview: TrackPreview };

const STATUSES = [
  { value: 'pending', label: 'Ждут решения' },
  { value: 'applied', label: 'Применённые' },
  { value: 'all', label: 'Все' },
];

const STATUS_WORDS: Record<string, string> = {
  pending: 'ждёт решения',
  applied: 'уже стала маршрутом',
  rejected: 'отклонена',
};

function durationWords(min: number | null): string | null {
  if (min == null || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

/**
 * Карта записи: куски — снятым путём, провалы — построением.
 *
 * Вид линий берётся из §12 и здесь не собирается: стиль, написанный рядом с
 * геометрией, — это второе правило, и оно разойдётся с первым.
 */
function TrackMap({ preview, title }: { preview: TrackPreview; title: string }) {
  const surveyed = trackLine(preview.pieces[0] ?? null, 'gpx');
  const connector = connectorLine();

  const first = preview.pieces[0]?.[0];
  const lastPiece = preview.pieces[preview.pieces.length - 1];
  const last = lastPiece?.[lastPiece.length - 1];

  const markers: MapMarker[] = [
    // Держатели линий: пина у них нет — три куска записи дали бы три пина
    // подряд, и читались бы они как точки маршрута, которых в записи нет.
    ...preview.pieces.map((coords, i) => ({
      coords: coords[0]!,
      title,
      geometryOnly: true,
      geometry: {
        type: 'polyline' as const,
        coordinates: coords,
        ...(surveyed?.style ?? {}),
      },
      id: `piece-${i}`,
    })),
    ...preview.gaps.map((pair, i) => ({
      coords: pair[0],
      // Прямая через молчание прибора маршрутом не называется — §12.
      title: 'Прибор молчал',
      geometryOnly: true,
      geometry: { type: 'polyline' as const, coordinates: pair, ...connector },
      id: `gap-${i}`,
    })),
  ];

  // Два пина на всю запись: где прибор включили и где выключили. Они отвечают
  // на «мой ли это выход?» — в отличие от пина на каждом куске.
  if (first) markers.push({ coords: first, title: 'Начало записи', id: 'start' });
  if (last) markers.push({ coords: last, title: 'Конец записи', id: 'finish' });

  // Масштаб карта берёт сама: fitBounds по всем координатам, включая линию
  // (LeafletMap, один раз на инстанс). Центр — запасной путь, когда точек нет.
  const center: [number, number] = preview.bounds
    ? [
        (preview.bounds.south + preview.bounds.north) / 2,
        (preview.bounds.west + preview.bounds.east) / 2,
      ]
    : [53.02, 158.65];

  return <LeafletMap markers={markers} center={center} zoom={10} height="200px" />;
}

export default function TrackImportsClient() {
  const [status, setStatus] = useState('pending');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, LineState>>({});

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

  /**
   * Формы записей подтягиваются по одной после списка.
   *
   * Первый показ каждой записи скачивает и разбирает файл в хранилище — в
   * общий запрос списка это класть нельзя: одна нечитаемая запись задержала
   * бы весь экран, а разбор десятка треков занял бы минуту. Отказ по одной
   * записи остаётся при ней и говорится словами.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const item of items) {
        if (lines[item.id]) continue;
        setLines(prev => ({ ...prev, [item.id]: { kind: 'loading' } }));
        try {
          const res = await fetch(`/api/admin/track-imports/${item.id}/line`);
          const data = await res.json() as { ok?: boolean; preview?: TrackPreview; error?: string };
          if (cancelled) return;
          setLines(prev => ({
            ...prev,
            [item.id]: data.ok && data.preview
              ? { kind: 'ready', preview: data.preview }
              : { kind: 'failed', reason: data.error ?? `HTTP ${res.status}` },
          }));
        } catch (err) {
          if (cancelled) return;
          setLines(prev => ({
            ...prev,
            [item.id]: { kind: 'failed', reason: err instanceof Error ? err.message : 'сеть' },
          }));
        }
      }
    })();
    return () => { cancelled = true; };
    // lines намеренно не в зависимостях: он меняется внутри этого же эффекта,
    // и включение свернуло бы цикл в шторм запросов.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

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
      <h1 className="mb-2 text-[28px] font-bold leading-[1.15] text-[var(--text-primary)]"
          style={{ fontFamily: 'var(--font-playfair)' }}>
        Треки из поля
      </h1>
      <p className="mb-6 max-w-prose text-sm leading-relaxed text-[var(--text-secondary)]">
        Записи, снятые прибором. Трек становится линией маршрута только вашим решением —
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
                : 'bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
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

      <div className="space-y-6">
        {items.map((t) => {
          const line = lines[t.id];
          const preview = line?.kind === 'ready' ? line.preview : null;
          const gapCount = preview ? preview.gaps.length : 0;
          const facts = [
            t.points != null ? `${t.points.toLocaleString('ru-RU')} точек` : null,
            t.length_km != null ? `${t.length_km.toLocaleString('ru-RU')} км` : null,
            durationWords(t.timespan_min),
            t.format ? t.format.toUpperCase() : null,
          ].filter(Boolean) as string[];

          return (
            <article key={t.id} className="overflow-hidden rounded-lg bg-[var(--bg-card)]">
              <div className="relative h-[200px] bg-[var(--bg-hover)]">
                {preview && <TrackMap preview={preview} title={t.source_name ?? 'Запись'} />}
                {line?.kind === 'loading' && (
                  <p className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-secondary)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Разбираем запись…
                  </p>
                )}
                {line?.kind === 'failed' && (
                  <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
                    <MapPinOff className="h-5 w-5 text-[var(--text-muted)]" aria-hidden />
                    {/* «Не смогли показать» — не то же, что «линии нет» (§4.0):
                        запись цела, и применить её по-прежнему можно. */}
                    <p className="text-sm text-[var(--text-primary)]">Линию показать не смогли</p>
                    <p className="text-xs text-[var(--text-muted)]">{line.reason}</p>
                  </div>
                )}
              </div>

              <div className="p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="font-semibold text-[var(--text-primary)]">
                    {t.source_name || 'Запись без имени файла'}
                  </h2>
                  <span className="text-xs text-[var(--text-muted)]">
                    {new Date(t.created_at).toLocaleDateString('ru-RU', {
                      day: 'numeric', month: 'long', year: 'numeric',
                    })}
                  </span>
                </div>

                {facts.length > 0 && (
                  <p className="mt-1.5 text-sm text-[var(--text-secondary)]"
                     style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {facts.join(' · ')}
                  </p>
                )}

                {t.note && (
                  <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{t.note}</p>
                )}

                {gapCount > 0 && (
                  <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
                    Запись рвётся на {gapCount + 1} кусков: там, где прибор терял небо, стоит
                    серая прямая — по ней никто не шёл.
                  </p>
                )}

                {preview && preview.shown < preview.of && (
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    На карте {preview.shown.toLocaleString('ru-RU')} точек
                    из {preview.of.toLocaleString('ru-RU')} — линия прорежена для показа.
                    В маршрут ляжет запись целиком.
                  </p>
                )}

                {t.matched && (
                  <p className="mt-3 text-sm text-[var(--text-secondary)]">
                    Похоже на «{t.matched.title ?? t.matched.id}»
                    {t.matched.off_by_km != null && (
                      <span className="text-[var(--text-muted)]">
                        {' '}· расхождение {t.matched.off_by_km.toLocaleString('ru-RU')} км
                      </span>
                    )}
                  </p>
                )}

                {status !== 'pending' && (
                  <p className="mt-3 text-xs text-[var(--text-muted)]">
                    Запись {STATUS_WORDS[t.status] ?? t.status}
                  </p>
                )}

                {t.status === 'pending' && (
                  openId === t.id ? (
                    <div className="mt-4 space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => setMode('new')}
                          className={`rounded-lg px-3 py-2 text-sm transition-colors ${mode === 'new'
                            ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] text-[var(--text-primary)]'}`}
                        >
                          Новый маршрут
                        </button>
                        <button
                          onClick={() => setMode('existing')}
                          className={`rounded-lg px-3 py-2 text-sm transition-colors ${mode === 'existing'
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
                        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
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
                          {busy ? 'Считаем…' : 'Показать, что получится'}
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
                                  : <>Что получится</>}
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
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => { setOpenId(t.id); setResult(null); setTitle(''); }}
                      className="ds-btn ds-btn-primary mt-4 text-sm"
                    >
                      Сделать маршрутом
                    </button>
                  )
                )}
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}
