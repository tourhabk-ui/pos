/**
 * Погода на экране безопасности (`/safety`, `/hub/safety`) — из того же
 * прогноза, что Кузьмич, сводка и страница погоды (решение владельца 08.10).
 *
 * До этого виджет брал «текущие условия» wttr.in — третьего сервиса погоды на
 * платформе, со своими цифрами: на /safety турист видел одно, у Кузьмича и на
 * /weather — другое. Теперь «сейчас» — это прогноз текущей части дня по часам
 * Камчатки (ночь, утро, день, вечер), и экран так его и подписывает: прогноз,
 * а не замер. Влажности и «ощущается как» у прогноза нет — их нет и в ответе.
 *
 * Строки собираются здесь, на сервере, правилами `weather-format` и
 * `day-parts`: экраны показывают их как есть и своих правил не заводят.
 */
import type { ForecastResult } from '@/lib/planner/intelligence';
import { dayPartForHour, type DayPartLabel } from '@/lib/weather/day-parts';
import { partPrecip, precipLine, skyWords, tempRange, windLine } from '@/lib/weather/weather-format';
import { kamchatkaDate } from '@/lib/weather/weather-page';

export interface SafetyWeather {
  place: string;
  /** Прогноз текущей части дня; null — частей у сегодняшнего дня нет. */
  now: { label: DayPartLabel; temp: string | null; precip: string; wind: string } | null;
  today: { temp: string | null; precip: string; wind: string; sky: string | null };
  /** Когда прогноз получен от источника — не момент запроса. */
  checked_at: string | null;
  /** Источник не отвечает, это последний удачный прогноз. */
  stale: boolean;
}

function kamchatkaHour(now: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kamchatka', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

/**
 * Ответ виджета. null — в прогнозе нет сегодняшнего дня (старый прогноз
 * кончился): виджету показать нечего, и выдумывать «сейчас» по вчера нельзя.
 */
export function safetyWeather(
  f: Extract<ForecastResult, { ok: true }>,
  place: string,
  now: Date = new Date(),
): SafetyWeather | null {
  const today = f.days.find((d) => d.date === kamchatkaDate(now));
  if (!today) return null;
  const label = dayPartForHour(kamchatkaHour(now));
  const part = (today.parts ?? []).find((p) => p.label === label) ?? null;
  return {
    place,
    now: part
      ? { label, temp: tempRange(part.tempMin, part.tempMax), precip: partPrecip(part), wind: windLine(part.windKmh) }
      : null,
    today: {
      temp: tempRange(today.tempMin, today.tempMax),
      precip: precipLine(today.precipMm),
      wind: windLine(today.windKmh),
      sky: skyWords(today)?.toLowerCase() ?? null,
    },
    checked_at: f.staleSince ?? f.fetchedAt ?? null,
    stale: Boolean(f.staleSince),
  };
}
