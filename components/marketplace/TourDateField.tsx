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
 *
 * Выбор даты живёт в ОДНОМ месте — в `value` владельца. Календарь получает его
 * и управляется им: повторный тап по дате зовёт `onChange('')`, и форма
 * снимает дату вместе с календарём (аудит 24.09, П2: раньше календарь снимал
 * выделение, а форма молча держала прежний день и отправляла его).
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
  /** id ручного input — чтобы подпись поля владельца была с ним связана. */
  inputId?: string;
  /** Поле отмечено сервером/проверкой как ошибочное — подсветить ручной ввод. */
  invalid?: boolean;
}

/** Тач-цель 44px у текстовых переключателей режима (DS: минимум 44). */
const MODE_BTN = 'inline-flex items-center min-h-[44px] text-sm text-[var(--ocean)] hover:underline';

export default function TourDateField({ tourId, tourTitle, value, onChange, inputName = 'booking_date', inputId, invalid }: TourDateFieldProps) {
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
      id={inputId}
      name={inputName}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      min={minDate()}
      className="ds-input w-full"
      aria-invalid={invalid || undefined}
      style={invalid ? { borderColor: 'var(--danger)' } : undefined}
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
          className={MODE_BTN}
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
        value={value}
        onDateSelect={(date) => onChange(date)}
        onDateClear={() => onChange('')}
      />
      {/* Дат нет — календарь уже сказал об этом словами, показываем поле ввода.
          Даты есть — оставляем ручной ввод доступным одной кнопкой: у оператора
          бывают договорные выезды вне сетки. */}
      {mode === 'empty' ? manualInput : (
        <button
          type="button"
          onClick={() => setMode('manual')}
          className={MODE_BTN}
        >
          Ввести дату вручную
        </button>
      )}
    </div>
  );
}
