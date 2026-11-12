/**
 * lib/routes/route-today.ts
 *
 * Оценка маршрута на сегодня — для ответа Кузьмича и MCP (#3302, 12.11).
 *
 * Маршрут «Вилючинский водопад» опубликован, ищется и читается, а инструмент
 * безопасности отвечал о нём «не найдено»: статус считается у мест, а записи
 * места с таким названием нет. При этом у маршрута своя оценка на сегодня уже
 * была — на его карточке: «Идти / Осторожно / Не сегодня» по правилам
 * lib/routes/go-verdict из сигналов lib/routes/collect-signals (предупреждения
 * по зонам и точкам маршрута, закрытие его парка, коды вулканов на коридоре,
 * закрытые точки пути, сезон). До агента она не доходила.
 *
 * Здесь нет ни одного своего правила: оценка та же, что на карточке, и слова
 * фактов те же (lib/routes/verdict-facts). Второе правило о том же маршруте
 * разошлось бы с первым — и чат сказал бы «можно», когда карточка говорит
 * «не сегодня».
 *
 * Отказ сбора сигналов — не «препятствий нет»: все сигналы становятся `null`,
 * и правило отвечает «Осторожно — данных мало» (§4.0).
 */
import { collectRouteSignals } from '@/lib/routes/collect-signals';
import {
  goVerdict, VERDICT_LABELS, type RouteSignals, type Verdict, type VerdictStatus,
} from '@/lib/routes/go-verdict';
import { verdictFactLines, VERDICT_DISCLAIMER_RU } from '@/lib/routes/verdict-facts';

export interface RouteToday {
  verdict: Verdict;
  signals: RouteSignals;
}

const ALL_UNKNOWN: RouteSignals = { alerts: null, volcanoes: null, inSeason: null, weather: null, closures: null };

/**
 * Оценка маршрута на сегодня. `routeDbId` — `kamchatka_routes.id`: на нём
 * живут путевые точки; id карточки (COALESCE(ark_id, id)) сюда не годится.
 */
export async function routeToday(routeDbId: string): Promise<RouteToday> {
  let signals: RouteSignals;
  try {
    signals = await collectRouteSignals(routeDbId);
  } catch (err) {
    console.error('[route-today] сигналы маршрута не собраны:', err instanceof Error ? err.message : err);
    signals = ALL_UNKNOWN;
  }
  return { verdict: goVerdict(signals), signals };
}

/**
 * Метка в скобках у названия маршрута. У «Идти» метки нет намеренно: спокойный
 * день не помечается (как и на карточке — строка, а не плашка), а метки
 * «ОСТОРОЖНО» и «НЕ СЕГОДНЯ» читает сторож утверждений Кузьмича
 * (lib/kuzmich/safety-claim-guard): при них «безопасно, можно идти» без
 * оговорок в ответе получает поправку.
 */
export const ROUTE_TODAY_MARK: Record<VerdictStatus, string | null> = {
  go: null,
  caution: 'ОСТОРОЖНО',
  no: 'НЕ СЕГОДНЯ',
};

/** Сколько предупреждений маршрута назвать поимённо; остальные — числом. */
export const ROUTE_ALERTS_NAMED_MAX = 5;

/** Предупреждения, названные в строках оценки поимённо. */
export function namedRouteAlerts(t: RouteToday): string[] {
  return (t.signals.alerts ?? []).slice(0, ROUTE_ALERTS_NAMED_MAX).map((a) => a.title);
}

/** Точка в конце, если фраза сама не кончается знаком. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/**
 * Строки оценки для модели: слово, причина, факты, из которых оно посчитано,
 * и чем оценка не является. Факты идут и у «Идти»: агенту видно, что именно
 * проверено, а «закрытые точки: администратор не отмечал» не читается как
 * проверка точек.
 */
export function routeTodayLines(t: RouteToday): string[] {
  const lines = [
    `Оценка маршрута на сегодня — «${VERDICT_LABELS[t.verdict.status]}»: ${sentence(t.verdict.reason)} `
    + 'Правило то же, что на карточке маршрута.',
  ];
  for (const f of verdictFactLines(t.signals, { maxAlerts: ROUTE_ALERTS_NAMED_MAX })) {
    lines.push(sentence(`${f.label}: ${f.value}`));
  }
  lines.push(t.verdict.status === 'go'
    ? `Это не гарантия безопасности. ${VERDICT_DISCLAIMER_RU}`
    : VERDICT_DISCLAIMER_RU);
  return lines;
}
