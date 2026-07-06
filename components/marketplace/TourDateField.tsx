'use client';

import { useState, useEffect, useMemo } from 'react';
import AvailabilityCalendar from '@/components/routes/AvailabilityCalendar';

/**
 * Поле выбора даты заезда с календарём доступности.
 * Вынесено из BookingFormClient для переиспользования в чекауте корзины.
 *
 * Если у тура есть открытые слоты (/api/tours/[id]/slots — считает
 * занятость из реальных броней), дата выбирается по календарю. Слотов
 * нет / фетч упал → ручной <input type="date">: календарь у операторов
 * опционален, отсутствие строк tour_availability означает «даты свободны».
 */

// Минимальная дата — завтра
function minDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

interface TourDateFieldProps {
  tourId: number;
  tourTitle?: string;
  value: string;
  onChange: (date: string) => void;
  /** name для ручного input (совместимость с формами) */
  inputName?: string;
}

export default function TourDateField({ tourId, tourTitle, value, onChange, inputName = 'booking_date' }: TourDateFieldProps) {
  const [slotsMode, setSlotsMode] = useState<'loading' | 'calendar' | 'manual'>('loading');
  const [dateSource, setDateSource] = useState<'none' | 'manual' | 'calendar'>('none');

  useEffect(() => {
    let alive = true;
    fetch(`/api/tours/${tourId}/slots`)
      .then(r => (r.ok ? r.json() : { slots: [] }))
      .then((d: { slots?: unknown[] }) => {
        if (alive) setSlotsMode((d.slots?.length ?? 0) > 0 ? 'calendar' : 'manual');
      })
      .catch(() => { if (alive) setSlotsMode('manual'); });
    return () => { alive = false; };
  }, [tourId]);

  // offers — в зависимостях эффекта AvailabilityCalendar: новый массив на
  // каждый рендер зациклил бы рефетч слотов.
  const calendarOffers = useMemo(
    () => [{ tourId, tourName: tourTitle ?? '', nextDeparture: null, nextSlots: null }],
    [tourId, tourTitle]
  );

  const showCalendar = slotsMode === 'calendar' && dateSource !== 'manual';

  if (showCalendar) {
    return (
      <div className="space-y-2">
        <AvailabilityCalendar
          offers={calendarOffers}
          onDateSelect={(date) => {
            setDateSource('calendar');
            onChange(date);
          }}
        />
        <button
          type="button"
          onClick={() => setDateSource('manual')}
          className="text-xs text-[var(--ocean)] hover:underline"
        >
          Ввести дату вручную
        </button>
      </div>
    );
  }

  return (
    <input
      type="date"
      name={inputName}
      value={value}
      onChange={(e) => {
        setDateSource('manual');
        onChange(e.target.value);
      }}
      min={minDate()}
      className="ds-input w-full"
      required
    />
  );
}
