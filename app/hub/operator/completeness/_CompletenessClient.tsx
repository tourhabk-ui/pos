'use client';

/**
 * Экран «Чего не хватает турам» (решение владельца 13.10: «сделай экран
 * „чего не хватает туру“ в кабинете»).
 *
 * Главный вопрос оператора — «почему моего тура нет на витринах», и ответ
 * стоит первым: готовность по тому же правилу, что отбирает ленты Авито и
 * Яндекса и каталог (lib/tours/readiness, missingFields; считает API
 * /api/operator/completeness). Каждый блокер ведёт туда, где чинится
 * (lib/operator/blocker-targets): якорь в редакторе тура, профиль компании
 * или быстрое поле прямо здесь.
 *
 * До 13.10 экран назывался «Полнота туров» и вёл с процента заполненности
 * (70/30 обязательных и рекомендуемых полей): тур показывал «100%» и при
 * этом не уходил ни на одну витрину, а блокеры витрин лежали свёрнутыми
 * без ссылок. Заполненность карточки осталась вторым блоком, без процента
 * на весь экран.
 *
 * Три исхода запроса: список, пустой список, «не смог проверить» (§4.0).
 */

import React, { useState, useEffect } from 'react';
import {
  CheckCircle2, AlertCircle, RefreshCw, Zap, AlertTriangle, ChevronDown, X, Pencil, ArrowRight,
} from 'lucide-react';
import { LoadingSpinner, EmptyState } from '@/components/admin/shared';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { isQuickFillField } from '@/lib/operator/quick-fill-fields';
import { BLOCKER_TARGETS, blockerHref, blockerQuickField } from '@/lib/operator/blocker-targets';
import { plural } from '@/lib/home/data-freshness';

interface TourCompletion {
  tour_id: string;
  tour_title: string;
  is_published: boolean;
  required_score: number;
  recommended_score: number;
  total_score: number;
  missing_required: string[];
  missing_recommended: string[];
  /** Готовность к чужим витринам — судит то же правило, что и ленты каналов. */
  marketplace_ready: boolean;
  marketplace_blockers: Array<{ field: string; label: string }>;
}

interface CompletenessData {
  stats: {
    totalTours: number;
    avgTotalScore: number;
    fullyComplete: number;
    criticallyIncomplete: number;
    publishedTours: number;
  };
  tours: TourCompletion[];
}

/** Поля карточки (второй блок) — словами. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Название тура',
  description: 'Полное описание',
  base_price: 'Базовая цена',
  activity_type: 'Тип активности',
  tour_image: 'Главное фото',
  short_description: 'Краткое описание',
  season_dates: 'Сезон (дата начала/конца)',
  difficulty: 'Уровень сложности',
  included: 'Что включено',
  not_included: 'Что не включено',
  what_to_bring: 'Что взять с собой',
  location_name: 'Название места',
  latitude: 'Широта на карте',
  longitude: 'Долгота на карте',
  coordinates: 'Координаты на карте',
  duration_hours: 'Длительность (часы)',
  duration_type: 'Тип длительности',
  price_unit: 'Единица цены',
  notes: 'Интересные факты',
};

interface QuickFillModal {
  open: boolean;
  tourId?: string;
  tourTitle?: string;
  field?: string;
  value: string;
  saving?: boolean;
}

/** Действие по блокеру: быстрое поле здесь, иначе переход туда, где поле живёт. */
function BlockerAction({ field, tourId, tourTitle, onQuick }: {
  field: string; tourId: string; tourTitle: string;
  onQuick: (tourId: string, tourTitle: string, field: string) => void;
}) {
  const quick = blockerQuickField(field);
  if (quick) {
    return (
      <button type="button" onClick={() => onQuick(tourId, tourTitle, quick)} className="ds-btn ds-btn-secondary text-xs px-2.5 py-1.5 shrink-0">
        Заполнить
      </button>
    );
  }
  const href = blockerHref(field, tourId) ?? `/hub/operator/tours/${tourId}`;
  const label = BLOCKER_TARGETS[field]?.kind === 'profile' ? 'Открыть профиль' : 'Открыть в редакторе';
  return (
    <Link href={href} className="ds-btn ds-btn-secondary text-xs px-2.5 py-1.5 shrink-0 inline-flex items-center gap-1">
      {label} <ArrowRight className="w-3.5 h-3.5" aria-hidden />
    </Link>
  );
}

function TourCard({ tour, expanded, onToggle, onQuick, onAutoFill }: {
  tour: TourCompletion;
  expanded: boolean;
  onToggle: () => void;
  onQuick: (tourId: string, tourTitle: string, field: string) => void;
  onAutoFill: (tourId: string, tourTitle: string) => void;
}) {
  const cardGaps = tour.missing_required.length + tour.missing_recommended.length;
  const title = tour.tour_title?.trim() || 'Без названия';
  return (
    <div className="ds-card overflow-hidden">
      <div className="px-4 py-3 flex items-start gap-3">
        {tour.marketplace_ready
          ? <CheckCircle2 className="w-5 h-5 text-[var(--success)] shrink-0 mt-0.5" aria-hidden />
          : <AlertCircle className="w-5 h-5 text-[var(--warning)] shrink-0 mt-0.5" aria-hidden />}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/hub/operator/tours/${tour.tour_id}`} className="font-medium text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors">
              {title}
            </Link>
            <span className="ds-badge">{tour.is_published ? 'Опубликован' : 'Черновик'}</span>
          </div>
          <p className={`text-xs mt-0.5 ${tour.marketplace_ready ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
            {tour.marketplace_ready
              ? 'Готов к выкладке на Авито и Яндекс'
              : `Не уйдёт на Авито и Яндекс — не хватает: ${tour.marketplace_blockers.length}`}
          </p>
        </div>
        <Link href={`/hub/operator/tours/${tour.tour_id}`} className="ds-btn ds-btn-secondary text-xs px-2.5 py-1.5 shrink-0 inline-flex items-center gap-1">
          <Pencil className="w-3.5 h-3.5" aria-hidden /> Редактор
        </Link>
      </div>

      {/* Блокеры витрин — всегда видны, по одному действию на строку. */}
      {!tour.marketplace_ready && (
        <ul className="border-t border-[var(--border)] divide-y divide-[var(--border)]" aria-label={`Чего не хватает: ${title}`}>
          {tour.marketplace_blockers.map((b) => (
            <li key={b.field} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
              <span className="text-[var(--text-primary)]">{b.label}</span>
              <BlockerAction field={b.field} tourId={tour.tour_id} tourTitle={title} onQuick={onQuick} />
            </li>
          ))}
        </ul>
      )}

      {/* Заполненность карточки на Ведаре — вторым блоком, по клику. */}
      {cardGaps > 0 && (
        <div className="border-t border-[var(--border)]">
          <button
            type="button"
            onClick={onToggle}
            className="w-full px-4 py-2.5 flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
            aria-expanded={expanded}
          >
            <span>Ещё для карточки на Ведаре: {cardGaps} {plural(cardGaps, 'поле', 'поля', 'полей')}</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
          </button>
          {expanded && (
            <div className="px-4 pb-4 space-y-3 text-xs">
              {tour.missing_required.length > 0 && (
                <div>
                  <p className="font-semibold text-[var(--danger)] mb-1.5">Обязательные поля карточки ({tour.missing_required.length})</p>
                  <div className="flex flex-wrap gap-1.5">
                    {tour.missing_required.map((field) => (
                      <button
                        key={field}
                        type="button"
                        onClick={() => onQuick(tour.tour_id, title, field)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
                      >
                        {FIELD_LABELS[field] || field} <Zap className="w-3 h-3 text-[var(--accent)]" aria-hidden />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {tour.missing_recommended.length > 0 && (
                <div>
                  <p className="font-semibold text-[var(--text-secondary)] mb-1.5">Желательно ({tour.missing_recommended.length})</p>
                  <div className="flex flex-wrap gap-1.5">
                    {tour.missing_recommended.map((field) => (
                      <button
                        key={field}
                        type="button"
                        onClick={() => onQuick(tour.tour_id, title, field)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] transition-colors"
                      >
                        {FIELD_LABELS[field] || field}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button type="button" onClick={() => onAutoFill(tour.tour_id, title)} className="ds-btn ds-btn-secondary text-xs inline-flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" aria-hidden /> Заполнить с помощью AI
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CompletenessClient() {
  const router = useRouter();
  const [data, setData] = useState<CompletenessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTour, setExpandedTour] = useState<string | null>(null);
  const [quickFill, setQuickFill] = useState<QuickFillModal>({ open: false, value: '' });

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/operator/completeness');
      const result = await res.json();
      if (!result.success) throw new Error(result.error);
      setData(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ответ не получен');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickFill = (tourId: string, tourTitle: string, field: string) => {
    // Фото, сезон, состав, координаты — не одной строкой: ведём в редактор.
    if (!isQuickFillField(field)) {
      router.push(`/hub/operator/tours/${tourId}`);
      return;
    }
    setQuickFill({ open: true, tourId, tourTitle, field, value: '' });
  };

  const handleSaveQuickFill = async () => {
    if (!quickFill.tourId || !quickFill.field || !quickFill.value.trim()) {
      toast.error('Заполните значение');
      return;
    }
    try {
      setQuickFill((prev) => ({ ...prev, saving: true }));
      const res = await fetch('/api/operator/tours/quick-fill', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tourId: quickFill.tourId, field: quickFill.field, value: quickFill.value }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error);
      toast.success(`${FIELD_LABELS[quickFill.field] ?? quickFill.field} обновлено`);
      setQuickFill({ open: false, value: '' });
      await fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка при сохранении');
    } finally {
      setQuickFill((prev) => ({ ...prev, saving: false }));
    }
  };

  const handleAutoFillAI = async (tourId: string, tourTitle: string) => {
    try {
      const loadingToast = toast.loading(`AI заполняет «${tourTitle}»…`);
      const res = await fetch('/api/operator/tours/auto-fill-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tourId }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error);
      const filled = result.data.filled;
      toast.dismiss(loadingToast);
      if (filled > 0) {
        toast.success(`AI заполнил полей: ${filled}`);
        await fetchData();
      } else {
        toast.error('Нечего заполнять');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка AI');
    }
  };

  useEffect(() => {
    void fetchData();
  }, []);

  if (loading) {
    return <div className="p-6"><LoadingSpinner message="Проверяем готовность туров…" /></div>;
  }

  // Третий исход: запрос не удался — это не «всё готово» и не «туров нет».
  if (error) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<AlertTriangle className="w-10 h-10 text-[var(--warning)]" />}
          title="Не смог проверить готовность"
          description={error}
          action={{ label: 'Повторить', onClick: fetchData }}
        />
      </div>
    );
  }

  // Защита второго слоя: сервер отдаёт объект {stats, tours}, но проверка
  // формы здесь дешева, а цена ошибки — белый экран.
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.stats || !Array.isArray(data.tours)) {
    return null;
  }

  const { tours } = data;
  const readyTours = tours.filter((t) => t.marketplace_ready);
  const notReady = tours
    .filter((t) => !t.marketplace_ready)
    .sort((a, b) => b.marketplace_blockers.length - a.marketplace_blockers.length);
  const drafts = tours.filter((t) => !t.is_published).length;

  // Сколько туров спотыкается о каждый блокер — список работ: видно, что
  // чинится одной фразой на все туры, а что поштучно.
  const byField = new Map<string, { label: string; count: number }>();
  for (const t of notReady) {
    for (const b of t.marketplace_blockers) {
      const cur = byField.get(b.field);
      byField.set(b.field, { label: b.label, count: (cur?.count ?? 0) + 1 });
    }
  }
  const byFieldRows = [...byField.values()].sort((a, b) => b.count - a.count);

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Чего не хватает турам</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-1 max-w-2xl">
            Готовность к витринам — каталогу Ведара, Авито и Яндексу — считается одним правилом,
            тем же, что отбирает ленты. Ниже — что именно заполнить у каждого тура и куда для этого перейти.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchData}
          className="ds-btn ds-btn-secondary text-xs px-2.5 py-1.5 shrink-0"
          aria-label="Проверить заново"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="ds-card p-4">
          <p className="text-xs uppercase tracking-wider text-[var(--text-secondary)] mb-2">Готовы к витринам</p>
          <p className="text-3xl font-bold text-[var(--success)]">{readyTours.length}</p>
          <p className="text-xs text-[var(--text-secondary)] mt-1">из {tours.length} {plural(tours.length, 'тура', 'туров', 'туров')}</p>
        </div>
        <div className="ds-card p-4">
          <p className="text-xs uppercase tracking-wider text-[var(--text-secondary)] mb-2">Не хватает данных</p>
          <p className="text-3xl font-bold text-[var(--warning)]">{notReady.length}</p>
          <p className="text-xs text-[var(--text-secondary)] mt-1">{notReady.length === 0 ? 'все туры готовы' : 'ждут правки — список ниже'}</p>
        </div>
        <div className="ds-card p-4">
          <p className="text-xs uppercase tracking-wider text-[var(--text-secondary)] mb-2">Черновики</p>
          <p className="text-3xl font-bold text-[var(--text-primary)]">{drafts}</p>
          <p className="text-xs text-[var(--text-secondary)] mt-1">не опубликованы — на витрины не идут</p>
        </div>
      </div>

      {byFieldRows.length > 0 && (
        <div className="ds-card p-4">
          <p className="text-xs font-semibold text-[var(--text-primary)] mb-2">Чаще всего не хватает</p>
          <ul className="space-y-1 text-sm">
            {byFieldRows.map((r) => (
              <li key={r.label} className="flex items-baseline justify-between gap-3">
                <span className="text-[var(--text-primary)]">{r.label}</span>
                <span className="text-[var(--text-secondary)] whitespace-nowrap">{r.count} {plural(r.count, 'тур', 'тура', 'туров')}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--text-secondary)] mt-2">
            Условия отмены и способ подвоза обычно одни на все туры оператора — одна формулировка закрывает все строки сразу.
          </p>
        </div>
      )}

      {tours.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="w-10 h-10 text-[var(--success)]" />}
          title="Туров пока нет"
          description="Создайте первый тур в разделе «Туры» — здесь появится, чего ему не хватает до витрин"
        />
      ) : (
        <>
          {notReady.length > 0 && (
            <section className="space-y-2" aria-label="Туры, которым не хватает данных">
              <p className="text-xs uppercase tracking-wider text-[var(--text-secondary)]">Не уйдут на витрины ({notReady.length})</p>
              {notReady.map((tour) => (
                <TourCard
                  key={tour.tour_id}
                  tour={tour}
                  expanded={expandedTour === tour.tour_id}
                  onToggle={() => setExpandedTour(expandedTour === tour.tour_id ? null : tour.tour_id)}
                  onQuick={handleQuickFill}
                  onAutoFill={handleAutoFillAI}
                />
              ))}
            </section>
          )}
          {readyTours.length > 0 && (
            <section className="space-y-2" aria-label="Готовые туры">
              <p className="text-xs uppercase tracking-wider text-[var(--text-secondary)]">Готовы ({readyTours.length})</p>
              {readyTours.map((tour) => (
                <TourCard
                  key={tour.tour_id}
                  tour={tour}
                  expanded={expandedTour === tour.tour_id}
                  onToggle={() => setExpandedTour(expandedTour === tour.tour_id ? null : tour.tour_id)}
                  onQuick={handleQuickFill}
                  onAutoFill={handleAutoFillAI}
                />
              ))}
            </section>
          )}
        </>
      )}

      {/* Быстрое поле — непрозрачный диалог (подтверждение, §2). */}
      {quickFill.open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label="Заполнить поле">
          <div className="ds-card max-w-md w-full p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--text-primary)]">Заполнить поле</p>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">{quickFill.tourTitle}</p>
              </div>
              <button type="button" onClick={() => setQuickFill({ open: false, value: '' })} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="Закрыть">
                <X className="w-4 h-4" aria-hidden />
              </button>
            </div>
            <div className="rounded-lg bg-[var(--bg-hover)] p-3">
              <p className="text-xs uppercase tracking-wider text-[var(--text-secondary)] mb-1">Поле</p>
              <p className="text-sm font-medium text-[var(--text-primary)]">{FIELD_LABELS[quickFill.field!] || quickFill.field}</p>
            </div>
            <div>
              <label htmlFor="quick-fill-value" className="ds-label">Значение</label>
              {quickFill.field === 'base_price' || quickFill.field === 'price_old' ? (
                <input id="quick-fill-value" type="number" min="0" step="0.01" value={quickFill.value}
                  onChange={(e) => setQuickFill((prev) => ({ ...prev, value: e.target.value }))}
                  placeholder="0.00" className="ds-input w-full" disabled={quickFill.saving} />
              ) : quickFill.field === 'duration_hours' ? (
                <input id="quick-fill-value" type="number" min="0" step="0.5" value={quickFill.value}
                  onChange={(e) => setQuickFill((prev) => ({ ...prev, value: e.target.value }))}
                  placeholder="1.0" className="ds-input w-full" disabled={quickFill.saving} />
              ) : quickFill.field?.includes('date') || quickFill.field === 'season_start' || quickFill.field === 'season_end' ? (
                <input id="quick-fill-value" type="date" value={quickFill.value}
                  onChange={(e) => setQuickFill((prev) => ({ ...prev, value: e.target.value }))}
                  className="ds-input w-full" disabled={quickFill.saving} />
              ) : (
                <textarea id="quick-fill-value" value={quickFill.value}
                  onChange={(e) => setQuickFill((prev) => ({ ...prev, value: e.target.value }))}
                  placeholder="Введите значение" rows={3} className="ds-input w-full resize-none" disabled={quickFill.saving} />
              )}
            </div>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setQuickFill({ open: false, value: '' })} disabled={quickFill.saving} className="ds-btn ds-btn-secondary flex-1 disabled:opacity-50">
                Отмена
              </button>
              <button type="button" onClick={handleSaveQuickFill} disabled={quickFill.saving} className="ds-btn ds-btn-primary flex-1 disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
                {quickFill.saving ? (
                  <>
                    <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden />
                    Сохранение…
                  </>
                ) : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
