'use client';

import { useState, useMemo, useCallback } from 'react';
import AvailabilityCalendar from '@/components/routes/AvailabilityCalendar';

/**
 * Поле выбора даты заезда.
 *
 * Календарь свободных дат — основной путь; ручной ввод остаётся запасным:
 * заполнять tour_availability оператор не обязан, и отсутствие строк означает
 * «дату согласуем», а не «мест нет».
 *
 * Один запрос вместо двух. Раньше это поле само спрашивало /api/tours/[id]/slots,
 * чтобы решить, рисовать ли календарь, — а календарь внутри спрашивал тот же
 * эндпоинт второй раз. Теперь слоты грузит только календарь, а о пустоте
 * сообщает наверх через onEmpty.
 */

/** Минимальная дата ручного ввода — завтра: сегодняшний выезд уже не собрать. */
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
  /** none — календарь ещё может показать даты; empty — их нет; manual — так решил турист. */
  const [mode, setMode] = useState<'calendar' | 'empty' | 'manual'>('calendar');

  // offers — в зависимостях эффекта календаря: новый массив на каждый рендер
  // зациклил бы перезапрос слотов.
  const calendarOffers = useMemo(
    () => [{ tourId, tourName: tourTitle ?? '', nextDeparture: null, nextSlots: null }],
    [tourId, tourTitle],
  );

  const handleEmpty = useCallback(() => setMode(m => (m === 'manual' ? m : 'empty')), []);

  const manualInput = (
    <input
      type="date"
      name={inputName}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      min={minDate()}
      className="ds-input w-full"
      required
    />
  );

  if (mode === 'manual') {
    return (
      <div className="space-y-2">
        {manualInput}
        <button
          type="button"
          onClick={() => setMode('calendar')}
          className="text-xs text-[var(--ocean)] hover:underline"
        >
          Показать календарь свободных дат
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <AvailabilityCalendar
        offers={calendarOffers}
        onEmpty={handleEmpty}
        onDateSelect={(date) => onChange(date)}
      />
      {/* Дат нет — календарь уже сказал об этом словами, показываем поле ввода.
          Даты есть — оставляем ручной ввод доступным одной кнопкой: у оператора
          бывают договорные выезды вне сетки. */}
      {mode === 'empty' ? manualInput : (
        <button
          type="button"
          onClick={() => setMode('manual')}
          className="text-xs text-[var(--ocean)] hover:underline"
        >
          Ввести дату вручную
        </button>
      )}
    </div>
  );
}
