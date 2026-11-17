'use client';

/**
 * Как тур выезжает — выбор оператора в карточке тура кабинета (#3476 шаг 4,
 * слово владельца 17.11 «Сайт и чат»). Колонка `operator_tours.schedule_kind`
 * (миграция 1457, правило — lib/tours/schedule-kind):
 *
 *   - «Только в мои даты» (`departures`) — туристы выбирают из расписания ниже;
 *   - «В любой день сезона» (`any_day`) — заявка на любой день между началом и
 *     концом сезона; расписание ниже — исключения (закрыть день, места);
 *   - «Не указано» (NULL) — как до 16.11, «даты по запросу».
 *
 * Без сезона «любой день» туристу не показывается (`anyDayOpen` — сезон
 * обязателен), и это сказано под выбором, а не спрятано.
 *
 * Отдельным компонентом, чтобы это судилось рендером (правило 13.10).
 */

import type { ScheduleKind } from '@/lib/tours/schedule-kind';

export type ScheduleKindValue = ScheduleKind | '';

const OPTIONS: ReadonlyArray<{ value: ScheduleKindValue; title: string; hint: string }> = [
  { value: 'departures', title: 'Только в мои даты', hint: 'Туристы видят и выбирают только даты из расписания ниже.' },
  { value: 'any_day', title: 'В любой день сезона', hint: 'Туристы могут оставить заявку на любой день сезона. Даты ниже — исключения: закрыть день, ограничить места.' },
  { value: '', title: 'Не указано', hint: 'Туристы видят «даты по запросу».' },
];

export default function TourScheduleKind({ value, onChange, seasonStart, seasonEnd }: {
  value: ScheduleKindValue;
  onChange: (v: ScheduleKindValue) => void;
  seasonStart: string;
  seasonEnd: string;
}) {
  const noSeason = value === 'any_day' && (!seasonStart || !seasonEnd);
  return (
    <fieldset className="space-y-2">
      <legend className="block text-xs font-medium text-[var(--text-muted)] mb-1">Как вы выезжаете</legend>
      {OPTIONS.map((o) => (
        <label key={o.value || 'none'} className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="schedule_kind"
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="mt-1 w-4 h-4 accent-[var(--accent)]"
          />
          <span className="text-sm text-[var(--text-primary)]">
            {o.title}
            <span className="block text-xs text-[var(--text-muted)]">{o.hint}</span>
          </span>
        </label>
      ))}
      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Выбор сохраняется кнопкой «Сохранить изменения» внизу карточки.
      </p>
      {noSeason && (
        <p role="status" className="px-3 py-2 rounded-lg border-l-4 text-xs"
          style={{ borderLeftColor: 'var(--warning)', color: 'var(--text-primary)' }}>
          Укажите начало и конец сезона выше — без них туристы не увидят «в любой день сезона».
        </p>
      )}
    </fieldset>
  );
}
