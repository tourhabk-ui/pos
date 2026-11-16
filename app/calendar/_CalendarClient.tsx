'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import {
  ChevronLeft, ChevronRight, Users, Clock, Star,
  CheckCircle, X, SlidersHorizontal, CalendarDays,
  CloudLightning, TrendingDown, Zap, AlertTriangle,
} from 'lucide-react';
import { Header } from '@/components/layout/Header';
import TourPaymentModal from '@/components/booking/TourPaymentModal';
import { OFFER_ORDER_NOTE_DAY_RU } from '@/lib/tours/offer-order';
import { reportClientError } from '@/lib/client-errors/report';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DayAvail {
  date: string;
  tourCount: number;
  freeSlots: number;
  priceFrom: number | null;
  activities: string[];
  operators: number;
}

interface Tour {
  tourId: number;
  title: string;
  description: string | null;
  activityType: string | null;
  activityLabel: string | null;
  locationName: string | null;
  price: number;
  priceUnit?: string | null;
  durationHours: number | null;
  durationType: string | null;
  freeSlots: number;
  availableSlots: number;
  /** Группа тура не ограничена (1342); нет поля — FALSE. */
  groupSizeUnlimited?: boolean;
  weatherStatus: string;
  operator: {
    id: string;
    name: string;
    verified: boolean;
    /** Оценка — только при отзывах (publicRating); нет отзывов — null. */
    rating: number | null;
    reviewCount?: number | null;
    /** Страница оператора (partners.slug / is_public); нет — имя текстом (13.10). */
    slug?: string | null;
    isPublic?: boolean | null;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WEEKDAYS   = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_RU  = [
  'Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь',
];

/** Кнопка вида: только из живых туров месяца (ответ /api/availability). */
interface ActivityChip { value: string; label: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RUB = (v: number) => v.toLocaleString('ru-RU') + ' ₽';

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function reviewsWord(n: number): string {
  return `${n} ${plural(n, 'отзыв', 'отзыва', 'отзывов')}`;
}

function toursWord(n: number): string {
  return `${n} ${plural(n, 'тур', 'тура', 'туров')}`;
}

function toISO(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function formatDuration(hours: number | null, type: string | null): string {
  if (!hours) return '';
  if (type === 'multi_day') return `${Math.round(hours / 24)} дней`;
  if (hours < 1)  return `${Math.round(hours * 60)} мин`;
  if (hours === Math.floor(hours)) return `${hours} ч`;
  return `${hours} ч`;
}

/** Цвет ячейки по кол-ву доступных туров */
function dayBg(tourCount: number, selected: boolean): string {
  if (selected) return 'var(--accent)';
  if (tourCount === 0) return 'transparent';
  if (tourCount <= 3)  return 'color-mix(in srgb, var(--ocean) 18%, transparent)';
  if (tourCount <= 6)  return 'color-mix(in srgb, var(--accent) 18%, transparent)';
  return 'color-mix(in srgb, var(--accent) 30%, transparent)';
}

function slotsBadge(free: number, total: number) {
  const pct = free / total;
  if (pct <= 0.25) return { color: 'var(--danger)',  label: 'Мало мест' };
  if (pct <= 0.6)  return { color: 'var(--warning)', label: 'Есть места' };
  return               { color: 'var(--success)',    label: 'Много мест' };
}

// ─── Tour Card ────────────────────────────────────────────────────────────────

function TourCard({
  tour, selectedDate, onBook,
}: {
  tour: Tour;
  selectedDate: string;
  onBook: (tour: Tour) => void;
}) {
  const badge   = slotsBadge(tour.freeSlots, tour.availableSlots);
  const weather = tour.weatherStatus === 'alert';

  return (
    <div className="ds-card p-4 flex flex-col gap-3 hover:shadow-md transition-shadow">
      {/* Шапка */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold leading-snug" style={{ color: 'var(--text-primary)' }}>
            {tour.title}
          </h3>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {tour.activityLabel && (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                {tour.activityLabel}
              </span>
            )}
            {tour.locationName && (
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {tour.locationName}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-bold text-base" style={{ color: 'var(--accent)' }}>
            {RUB(tour.price)}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>за чел.</div>
        </div>
      </div>

      {/* Мета */}
      <div className="flex items-center gap-3 text-xs flex-wrap" style={{ color: 'var(--text-secondary)' }}>
        {tour.durationHours && (
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatDuration(tour.durationHours, tour.durationType)}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Users className="w-3 h-3" />
          <span style={{ color: badge.color }}>{tour.freeSlots} мест</span>
        </span>
        {weather && (
          <span className="flex items-center gap-1" style={{ color: 'var(--warning)' }}>
            <CloudLightning className="w-3 h-3" />
            Погодный риск
          </span>
        )}
      </div>

      {/* Оператор */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            <OperatorNameLink name={tour.operator.name} slug={tour.operator.slug} isPublic={tour.operator.isPublic} />
          </span>
          {tour.operator.verified && (
            <CheckCircle className="w-3 h-3" style={{ color: 'var(--success)' }} />
          )}
          {/* Оценка — только с отзывами и с их числом рядом (§4.0): «★ 0.0» без
              единого отзыва стоял здесь до 16.11. */}
          {tour.operator.rating !== null && (tour.operator.reviewCount ?? 0) > 0 && (
            <div className="flex items-center gap-0.5">
              <Star className="w-3 h-3 fill-[var(--warning)] text-[var(--warning)]" />
              <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                {tour.operator.rating.toFixed(1)}
              </span>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                · {reviewsWord(tour.operator.reviewCount ?? 0)}
              </span>
            </div>
          )}
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
          style={{ background: `color-mix(in srgb, ${badge.color} 12%, transparent)`, color: badge.color }}>
          {badge.label}
        </span>
      </div>

      {/* CTA */}
      <button
        onClick={() => onBook(tour)}
        className="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors"
        style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
      >
        Заявка на {new Date(selectedDate + 'T12:00:00').toLocaleDateString('ru-RU', {
          day: 'numeric', month: 'long',
        })}
      </button>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function CalendarClient() {
  const now = new Date();
  const [year, setYear]   = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [activity, setActivity] = useState('');

  const [monthData, setMonthData] = useState<DayAvail[]>([]);
  const [loadingMonth, setLoadingMonth] = useState(true);
  // Отказ загрузки — своё состояние (§4.0): «в этом месяце нет туров» по
  // сбою было бы неправдой.
  const [monthFailed, setMonthFailed] = useState(false);
  /** Кнопки видов из живых туров месяца; подписи запоминаются, чтобы выбранная не пропала. */
  const [chips, setChips] = useState<ActivityChip[]>([]);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayTours, setDayTours]   = useState<Tour[]>([]);
  const [loadingDay, setLoadingDay] = useState(false);
  const [dayFailed, setDayFailed] = useState(false);
  // Прокрутка к панели — только на нажатие человека: ближайший день,
  // выбранный при открытии, страницу не двигает.
  const scrollOnSelect = useRef(false);

  const [bookingTour, setBookingTour] = useState<Tour | null>(null);

  const gridRef  = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // На телефоне панель дня стоит под сеткой, за краем экрана: без прокрутки
  // нажатие на день выглядело бы как «ничего не произошло». Рядом с сеткой
  // (десктоп) панель и так видна — прокручивать нечего.
  useEffect(() => {
    if (!selectedDate || !scrollOnSelect.current) return;
    scrollOnSelect.current = false;
    const grid = gridRef.current, panel = panelRef.current;
    if (!grid || !panel) return;
    if (panel.getBoundingClientRect().top >= grid.getBoundingClientRect().bottom) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedDate]);

  // ── Загрузка дня ────────────────────────────────────────────────────────────
  const loadDay = useCallback(async (iso: string, kind: string) => {
    setSelectedDate(iso);
    setDayTours([]);
    setDayFailed(false);
    setLoadingDay(true);
    try {
      const q   = kind ? `&activity=${encodeURIComponent(kind)}` : '';
      const res = await fetch(`/api/availability/day?date=${iso}${q}`);
      const json: { success: boolean; tours?: Tour[] } = await res.json();
      if (res.ok && json.success && Array.isArray(json.tours)) setDayTours(json.tours);
      else setDayFailed(true);
    } catch (err) {
      reportClientError('error', err);
      setDayFailed(true);
    } finally {
      setLoadingDay(false);
    }
  }, []);

  // ── Загрузка месяца ─────────────────────────────────────────────────────────
  const loadMonth = useCallback(async () => {
    setLoadingMonth(true);
    setMonthFailed(false);
    setSelectedDate(null);
    setDayTours([]);
    setDayFailed(false);
    try {
      const m   = `${year}-${String(month).padStart(2,'0')}`;
      const q   = activity ? `&activity=${encodeURIComponent(activity)}` : '';
      const res = await fetch(`/api/availability?month=${m}${q}`);
      const json: { success: boolean; days?: DayAvail[]; activities?: ActivityChip[] } = await res.json();
      if (!res.ok || !json.success || !Array.isArray(json.days)) {
        setMonthData([]);
        setMonthFailed(true);
        return;
      }
      setMonthData(json.days);
      if (Array.isArray(json.activities)) {
        const live = json.activities;
        setChips((prev) => {
          // Выбранный вид остаётся кнопкой, даже если в этом месяце его туров нет.
          const kept = prev.filter((c) => c.value === activity && !live.some((l) => l.value === c.value));
          return [...live, ...kept];
        });
      }
      // Как у календаря конкурента (сравнение 16.11): при открытии уже выбран
      // ближайший день с турами, его туры видны сразу.
      const first = json.days.find((d) => d.tourCount > 0);
      if (first) void loadDay(first.date, activity);
    } catch (err) {
      reportClientError('error', err);
      setMonthData([]);
      setMonthFailed(true);
    } finally {
      setLoadingMonth(false);
    }
  }, [year, month, activity, loadDay]);

  useEffect(() => { void loadMonth(); }, [loadMonth]);

  function selectDay(iso: string) {
    if (selectedDate === iso) { setSelectedDate(null); setDayTours([]); setDayFailed(false); return; }
    scrollOnSelect.current = true;
    void loadDay(iso, activity);
  }

  function prevMonth() {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  }

  // Сетка
  const firstDay    = new Date(year, month - 1, 1).getDay();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const todayISO = toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const dayMap   = new Map(monthData.map(d => [d.date, d]));

  // Статистика месяца
  const daysWithAvail = monthData.filter(d => d.tourCount > 0).length;
  const minPrice    = monthData.reduce<number | null>((min, d) =>
    d.priceFrom !== null ? (min === null ? d.priceFrom : Math.min(min, d.priceFrom)) : min, null);

  const selDayData = selectedDate ? dayMap.get(selectedDate) : null;

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20" style={{ background: 'var(--bg-primary)' }}>

        {/* ── Hero ────────────────────────────────────────────────────────── */}
        <section className="max-w-5xl mx-auto px-4 pt-10 pb-6">
          <h1 className="ds-h1 mb-2">
            Календарь свободных дат
          </h1>
          <p className="text-base" style={{ color: 'var(--text-secondary)' }}>
            Выберите дату — увидите все доступные туры на Камчатке
          </p>
        </section>

        <div className="max-w-5xl mx-auto px-4 pb-16">

          {/* ── Фильтры + сводка ────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div className="flex items-center gap-2 flex-wrap">
              <SlidersHorizontal className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
              {[{ value: '', label: 'Все типы' }, ...chips].map(a => (
                <button key={a.value}
                  onClick={() => setActivity(a.value)}
                  className="text-xs px-3 py-1.5 rounded-full border transition-all"
                  style={{
                    borderColor: activity === a.value ? 'var(--accent)' : 'var(--border)',
                    background:  activity === a.value ? 'var(--accent)' : 'transparent',
                    color:       activity === a.value ? 'var(--on-accent)' : 'var(--text-secondary)',
                  }}>
                  {a.label}
                </button>
              ))}
            </div>
            {!loadingMonth && daysWithAvail > 0 && (
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {daysWithAvail} {plural(daysWithAvail, 'день', 'дня', 'дней')}
                </span>
                {' '}с турами
                {minPrice !== null && (
                  <> · от <span className="font-semibold" style={{ color: 'var(--accent)' }}>
                    {RUB(minPrice)}
                  </span></>
                )}
              </div>
            )}
          </div>

          {/* На телефоне — колонкой: рядом с панелью в 320 px сетке на экране
              375 px оставалось 3 px (замер 14.10), дни налезали друг на друга. */}
          <div className="flex flex-col md:flex-row gap-5 md:items-start">

            {/* ── Календарная сетка ──────────────────────────────────────── */}
            <div ref={gridRef} className="md:flex-1 min-w-0">
              <div className="ds-card p-4">
                {/* Навигация */}
                <div className="flex items-center justify-between mb-4">
                  <button onClick={prevMonth}
                    disabled={year === now.getFullYear() && month === now.getMonth() + 1}
                    className="p-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-30">
                    <ChevronLeft className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />
                  </button>
                  <h2 className="font-semibold text-lg" style={{ color: 'var(--text-primary)' }}>
                    {MONTHS_RU[month - 1]} {year}
                  </h2>
                  <button onClick={nextMonth}
                    className="p-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors">
                    <ChevronRight className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />
                  </button>
                </div>

                {/* Заголовки дней недели */}
                <div className="grid grid-cols-7 gap-1.5 mb-2">
                  {WEEKDAYS.map(w => (
                    <div key={w} className="text-center text-[11px] font-bold uppercase py-1"
                      style={{ color: 'var(--text-muted)' }}>{w}</div>
                  ))}
                </div>

                {/* Ячейки */}
                {monthFailed ? (
                  <div role="alert" className="py-10 px-4 text-center text-sm flex flex-col items-center gap-2"
                    style={{ color: 'var(--text-secondary)' }}>
                    <AlertTriangle className="w-6 h-6" style={{ color: 'var(--warning)' }} />
                    Календарь не загрузился — это сбой у нас, а не «туров нет».
                    <button onClick={() => void loadMonth()} className="ds-btn ds-btn-secondary mt-1">
                      Повторить
                    </button>
                  </div>
                ) : loadingMonth ? (
                  <div className="grid grid-cols-7 gap-1.5">
                    {Array.from({ length: 35 }).map((_, i) => (
                      <div key={i} className="aspect-square rounded-lg animate-pulse"
                        style={{ background: 'var(--bg-hover)' }} />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-7 gap-1.5">
                    {cells.map((day, i) => {
                      if (!day) return <div key={`e-${i}`} />;
                      const iso     = toISO(year, month, day);
                      const isPast  = iso < todayISO;
                      const dayData = dayMap.get(iso);
                      const count   = dayData?.tourCount ?? 0;
                      const isToday = iso === todayISO;
                      const isSel   = selectedDate === iso;

                      return (
                        <button
                          key={iso}
                          onClick={() => { if (!isPast) selectDay(iso); }}
                          disabled={isPast}
                          title={count > 0 ? `${count} туров` : undefined}
                          className={[
                            'relative aspect-square rounded-lg flex flex-col items-center justify-center transition-all text-sm font-semibold',
                            !isPast && count > 0 ? 'cursor-pointer hover:scale-105 hover:shadow-md' : '',
                            isPast ? 'opacity-25 cursor-default' : '',
                            isSel  ? 'ring-2 ring-[var(--on-accent)] shadow-lg scale-105' : '',
                            isToday && !isSel ? 'ring-2 ring-[var(--ocean)]/50' : '',
                          ].filter(Boolean).join(' ')}
                          style={{
                            background: dayBg(count, isSel),
                            color:      isSel ? 'var(--on-accent)' : count > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                          }}
                        >
                          <span>{day}</span>
                          {count > 0 && !isSel && (
                            <span className="text-[8px] font-bold leading-none mt-0.5"
                              style={{ color: count >= 4 ? 'var(--accent)' : 'var(--ocean)' }}>
                              {toursWord(count)}
                            </span>
                          )}
                          {isSel && count > 0 && (
                            <span className="text-[8px] font-bold leading-none mt-0.5" style={{ color: 'var(--on-accent)' }}>
                              {toursWord(count)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Легенда */}
                {!loadingMonth && !monthFailed && (
                  <div className="flex flex-wrap gap-3 mt-4 pt-3 border-t text-[10px]"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-3 rounded"
                        style={{ background: dayBg(2, false) }} />
                      1–3 тура
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-3 rounded"
                        style={{ background: dayBg(5, false) }} />
                      4–6 туров
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-3 rounded"
                        style={{ background: dayBg(7, false) }} />
                      7+ туров
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* ── Правая панель ──────────────────────────────────────────── */}
            <div ref={panelRef} className="md:w-80 md:shrink-0 space-y-3 scroll-mt-24">

              {selectedDate ? (
                <>
                  {/* Заголовок дня */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-sm capitalize"
                        style={{ color: 'var(--text-primary)' }}>
                        {new Date(selectedDate + 'T12:00:00').toLocaleDateString('ru-RU', {
                          weekday: 'long', day: 'numeric', month: 'long',
                        })}
                      </div>
                      {selDayData && (
                        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {toursWord(selDayData.tourCount)} · {selDayData.freeSlots} мест
                          {selDayData.priceFrom !== null && (
                            <> · от {RUB(selDayData.priceFrom)}</>
                          )}
                        </div>
                      )}
                    </div>
                    <button aria-label="Закрыть день" onClick={() => { setSelectedDate(null); setDayTours([]); setDayFailed(false); }}>
                      <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                    </button>
                  </div>

                  {/* Список туров */}
                  {loadingDay ? (
                    <div className="space-y-3">
                      {[1,2].map(i => (
                        <div key={i} className="ds-card p-4 space-y-2 animate-pulse">
                          <div className="h-4 w-3/4 rounded" style={{ background: 'var(--bg-hover)' }} />
                          <div className="h-3 w-1/2 rounded" style={{ background: 'var(--bg-hover)' }} />
                          <div className="h-8 w-full rounded" style={{ background: 'var(--bg-hover)' }} />
                        </div>
                      ))}
                    </div>
                  ) : dayFailed ? (
                    <div role="alert" className="ds-card p-6 text-center">
                      <AlertTriangle className="w-7 h-7 mx-auto mb-2" style={{ color: 'var(--warning)' }} />
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Туры на этот день не загрузились — это сбой у нас, а не «туров нет».
                      </p>
                      <button onClick={() => void loadDay(selectedDate, activity)} className="ds-btn ds-btn-secondary mt-3">
                        Повторить
                      </button>
                    </div>
                  ) : dayTours.length === 0 ? (
                    <div className="ds-card p-6 text-center">
                      <TrendingDown className="w-7 h-7 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                        Нет доступных туров на этот день
                      </p>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        Попробуйте другую дату
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
                      {/* Правило порядка — словами на самой странице (CLAUDE.md §0, правило 1в). */}
                      <p className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                        {OFFER_ORDER_NOTE_DAY_RU}
                      </p>
                      {dayTours.map(tour => (
                        <TourCard
                          key={tour.tourId}
                          tour={tour}
                          selectedDate={selectedDate}
                          onBook={t => setBookingTour(t)}
                        />
                      ))}
                    </div>
                  )}
                </>
              ) : (
                /* Подсказка */
                <div className="ds-card p-6 text-center flex flex-col items-center gap-3">
                  <div className="w-12 h-12 rounded-full flex items-center justify-center"
                    style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}>
                    <CalendarDays className="w-6 h-6" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Выберите дату
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      Нажмите на цветной день — увидите все доступные туры
                    </p>
                  </div>
                  {!loadingMonth && !monthFailed && daysWithAvail === 0 && (
                    <div className="w-full pt-2 border-t text-xs text-center"
                      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                      В этом месяце нет открытых туров
                    </div>
                  )}
                  {!loadingMonth && daysWithAvail > 0 && (
                    <div className="flex items-center gap-1.5 text-xs"
                      style={{ color: 'var(--success)' }}>
                      <Zap className="w-3.5 h-3.5" />
                      {daysWithAvail} {plural(daysWithAvail, 'день', 'дня', 'дней')} с доступными турами
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

        </div>
      </main>

      {/* Модал бронирования */}
      {bookingTour && (
        <TourPaymentModal
          open={bookingTour !== null}
          onClose={() => setBookingTour(null)}
          tourId={bookingTour.tourId}
          tourName={bookingTour.title}
          operatorName={bookingTour.operator.name}
          priceBase={bookingTour.price}
          priceUnit={bookingTour.priceUnit}
          duration={{ multi_day_count: null, duration_hours: bookingTour.durationHours }}
          maxGroupSize={bookingTour.availableSlots}
          groupSizeUnlimited={bookingTour.groupSizeUnlimited === true}
          nextDeparture={selectedDate}
        />
      )}
    </>
  );
}
