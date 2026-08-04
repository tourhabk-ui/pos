'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Календарь свободных дат тура.
 *
 * Переработан 04.08 по замечанию владельца. Что было не так в прежней версии и
 * почему это чинится именно так — по пунктам, чтобы следующий читатель не
 * вернул «как было красивее»:
 *
 *  1. ХАРДКОД ЦВЕТА. Легенда и подсветка были прибиты как rgba(63,185,80,.4) и
 *     rgba(210,153,34,.4) — мимо токенов (CLAUDE.md §2). В тёмной теме такие
 *     заливки живут своей жизнью. Теперь только color-mix по var(--success) и
 *     var(--warning).
 *
 *  2. ТАЧ-ЦЕЛИ. Ячейки шли aspect-square в семь колонок — на 360px это ~43px,
 *     а стрелки месяцев с p-1 давали 24px. Календарём пользуются пальцем, часто
 *     на ходу: минимум 44px (DS), у стрелок — полноценная кнопка.
 *
 *  3. НАВИГАЦИЯ В ПУСТОТУ. Месяцы листались бесконечно: тур Июн—Сен, а уйти
 *     можно было в январь и увидеть пустую сетку. Так делают только у нас;
 *     Airbnb, Booking и GetYourGuide гасят стрелку на границе доступности.
 *     Теперь диапазон выводится ИЗ САМИХ дат, и за него не выйти.
 *
 *  4. ОТКРЫВАЛСЯ НА ТЕКУЩЕМ МЕСЯЦЕ. В октябре турист видел пустой октябрь и
 *     уходил, хотя даты есть в июне. Открываемся на первом месяце с датами.
 *
 *  5. `scale-110` НА ВЫБОРЕ — ячейка вылезала из сетки и наезжала на соседей.
 *     Выделяем заливкой, а не размером.
 *
 *  6. `<div onKeyDown>` ВМЕСТО КНОПКИ и `title` вместо подписи: на телефоне
 *     title не показывается вовсе, а роль/фокус держались на костылях.
 *
 *  7. ЧИСЛО МЕСТ БЫЛО СПРЯТАНО в title. «Осталось 2» — это то, ради чего
 *     календарь и открывают; выносим в ячейку.
 *
 * Честность: сетка рисует ровно то, что вернул /api/tours/[id]/slots (там
 * занятость считается по реальным броням). Нет дат — говорим прямо и отдаём
 * решение наверх через `onEmpty`, а не изображаем доступность.
 */

interface SlotDay {
  date: string; // YYYY-MM-DD
  free_slots: number;
}

interface OfferInfo {
  tourId: number;
  tourName: string;
  nextDeparture: string | null;
  nextSlots: number | null;
}

interface AvailabilityCalendarProps {
  offers: OfferInfo[];
  /** Клик по доступной дате: YYYY-MM-DD и tourId подходящего тура. */
  onDateSelect?: (date: string, tourId: number) => void;
  /**
   * Свободных дат нет вовсе. Нужен, чтобы владелец экрана мог показать другой
   * путь (ручной ввод даты) и при этом НЕ делать второй запрос за теми же
   * слотами — раньше TourDateField спрашивал их отдельно, чтобы решить, стоит
   * ли рисовать календарь.
   */
  onEmpty?: () => void;
}

/** Ключ месяца для сравнения без возни с датами. */
const monthKey = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

function isoOf(year: number, monthIdx: number, day: number): string {
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export default function AvailabilityCalendar({ offers, onDateSelect, onEmpty }: AvailabilityCalendarProps) {
  const [slots, setSlots] = useState<Map<string, number>>(new Map());
  const [slotTours, setSlotTours] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [month, setMonth] = useState<Date | null>(null);

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);

  useEffect(() => {
    let alive = true;
    setSelectedDate(null);
    if (offers.length === 0) { setLoading(false); return; }

    const tourIds = [...new Set(offers.map(o => o.tourId))];
    setLoading(true);

    Promise.all(
      tourIds.map(id =>
        fetch(`/api/tours/${id}/slots`)
          .then(r => (r.ok ? r.json() : { slots: [] }))
          .then((data: { slots?: SlotDay[] }) => ({ id, days: data.slots ?? [] }))
          .catch(() => ({ id, days: [] as SlotDay[] })),
      ),
    ).then(results => {
      if (!alive) return;
      const merged = new Map<string, number>();
      const tourMap = new Map<string, number>();
      for (const { id, days } of results) {
        for (const d of days) {
          merged.set(d.date, (merged.get(d.date) ?? 0) + d.free_slots);
          if (!tourMap.has(d.date)) tourMap.set(d.date, id);
        }
      }
      setSlots(merged);
      setSlotTours(tourMap);
      setLoading(false);
      if (merged.size === 0) onEmpty?.();
    });

    return () => { alive = false; };
  }, [offers, onEmpty]);

  /** Границы доступности — из самих дат, а не из предположений о сезоне. */
  const bounds = useMemo(() => {
    if (slots.size === 0) return null;
    const sorted = [...slots.keys()].sort();
    return {
      first: new Date(sorted[0] + 'T00:00:00'),
      last: new Date(sorted[sorted.length - 1] + 'T00:00:00'),
    };
  }, [slots]);

  // Открываемся на первом месяце, где даты ЕСТЬ (см. п.4 в шапке файла).
  useEffect(() => {
    if (!bounds || month) return;
    setMonth(new Date(bounds.first.getFullYear(), bounds.first.getMonth(), 1));
  }, [bounds, month]);

  const view = month ?? new Date(today.getFullYear(), today.getMonth(), 1);
  const canPrev = !!bounds && monthKey(view) > monthKey(bounds.first);
  const canNext = !!bounds && monthKey(view) < monthKey(bounds.last);

  const step = useCallback((delta: number) => {
    setMonth(new Date(view.getFullYear(), view.getMonth() + delta, 1));
    setSelectedDate(null);
  }, [view]);

  const pick = useCallback((iso: string, free: number) => {
    if (free <= 0) return;
    setSelectedDate(prev => (prev === iso ? null : iso));
    if (onDateSelect) {
      const tourId = slotTours.get(iso) ?? offers[0]?.tourId;
      if (tourId !== undefined) onDateSelect(iso, tourId);
    }
  }, [onDateSelect, slotTours, offers]);

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Загружаем свободные даты">
        <div className="ds-skeleton" style={{ height: 24, width: '60%', borderRadius: 8 }} />
        <div className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: 35 }).map((_, i) => (
            <div key={i} className="ds-skeleton" style={{ height: 44, borderRadius: 10 }} />
          ))}
        </div>
      </div>
    );
  }

  // Дат нет — говорим прямо. Экран-владелец уже получил onEmpty и, скорее
  // всего, покажет ручной ввод; изображать доступность здесь нельзя.
  if (slots.size === 0) {
    return (
      <p className="text-sm text-[var(--text-secondary)] py-2">
        Оператор пока не открыл даты. Выберите день вручную — он подтвердит его при бронировании.
      </p>
    );
  }

  const year = view.getFullYear();
  const mIdx = view.getMonth();
  const daysInMonth = new Date(year, mIdx + 1, 0).getDate();
  const firstWeekday = new Date(year, mIdx, 1).getDay(); // 0 = вс
  const offset = firstWeekday === 0 ? 6 : firstWeekday - 1; // неделя с понедельника

  return (
    // Доступное имя, а не видимый заголовок: внутри формы бронирования поле уже
    // подписано «Дата заезда», и третья подпись над сеткой была бы шумом. Но
    // сетка из чисел без имени непонятна скринридеру — отсюда role+aria-label.
    <div className="space-y-3" role="group" aria-label="Доступные даты">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-sm font-semibold capitalize text-[var(--text-primary)]"
          style={{ fontFamily: 'var(--font-playfair)' }}
        >
          {view.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}
        </span>
        <div className="flex items-center gap-1">
          {/* Стрелки гаснут на границе доступности: листать в месяцы, где тура
              нет и быть не может, — значит показывать пустоту как результат. */}
          <button
            type="button" onClick={() => step(-1)} disabled={!canPrev}
            aria-label="Предыдущий месяц"
            className="grid place-items-center rounded-lg border border-[var(--border)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ width: 44, height: 44 }}
          >
            <ChevronLeft className="w-4 h-4 text-[var(--text-secondary)]" />
          </button>
          <button
            type="button" onClick={() => step(1)} disabled={!canNext}
            aria-label="Следующий месяц"
            className="grid place-items-center rounded-lg border border-[var(--border)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ width: 44, height: 44 }}
          >
            <ChevronRight className="w-4 h-4 text-[var(--text-secondary)]" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map(d => (
          <div key={d} className="text-center text-[10px] font-bold uppercase pb-1 text-[var(--text-muted)]">
            {d}
          </div>
        ))}

        {Array.from({ length: offset }).map((_, i) => <div key={`pad-${i}`} />)}

        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
          const iso = isoOf(year, mIdx, day);
          const free = slots.get(iso) ?? 0;
          const isPast = new Date(year, mIdx, day) < today;
          const open = !isPast && free > 0;
          const low = open && free <= 3;
          const selected = selectedDate === iso;

          if (!open) {
            return (
              <div
                key={day}
                className="grid place-items-center rounded-lg text-sm text-[var(--text-muted)] opacity-40"
                style={{ height: 44 }}
                aria-hidden="true"
              >
                {day}
              </div>
            );
          }

          const tone = low ? 'var(--warning)' : 'var(--success)';
          return (
            <button
              key={day}
              type="button"
              onClick={() => pick(iso, free)}
              aria-pressed={selected}
              aria-label={`${day} ${view.toLocaleDateString('ru-RU', { month: 'long' })}, свободно мест: ${free}`}
              className="flex flex-col items-center justify-center rounded-lg transition-all duration-200 cursor-pointer"
              style={{
                height: 44,
                background: selected ? 'var(--accent)' : `color-mix(in srgb, ${tone} 14%, transparent)`,
                color: selected ? 'var(--bg-card)' : tone,
                border: `1px solid ${selected ? 'var(--accent)' : `color-mix(in srgb, ${tone} 30%, transparent)`}`,
                fontWeight: 600,
              }}
            >
              <span className="text-sm leading-none">{day}</span>
              {/* Число мест — то, ради чего календарь и открывают. Раньше оно
                  пряталось в title, которого на телефоне не существует. */}
              <span className="text-[9px] leading-none mt-0.5 opacity-80">{free}</span>
            </button>
          );
        })}
      </div>

      {selectedDate && (
        <p className="text-xs text-[var(--text-secondary)]">
          Выбрано:{' '}
          <span className="font-semibold text-[var(--text-primary)]">
            {new Date(selectedDate + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}
          </span>
          {' '}— оператор подтвердит дату при бронировании.
        </p>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 border-t border-[var(--border)] text-[10px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'color-mix(in srgb, var(--success) 45%, transparent)' }} />
          есть места
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'color-mix(in srgb, var(--warning) 45%, transparent)' }} />
          осталось мало
        </span>
      </div>
    </div>
  );
}
