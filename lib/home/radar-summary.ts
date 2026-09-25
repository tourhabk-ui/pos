/**
 * Сводка радара на главной — строки раскрытой плитки «Радар» (владелец 26.09:
 * «радар сделай зелёным и при возможности интерактивным»; из трёх вариантов
 * выбран первый — раскрытие по тапу, как у предупреждений).
 *
 * Строки собираются из того же снимка, что пилюля шапки и лента
 * предупреждений, — своего запроса у сводки нет. У каждой строки есть исход
 * «не знаем» (§4.0): упавшая сводка не превращается ни в «предупреждений
 * нет», ни в «вулканы спокойны».
 */
import { plural } from '@/lib/home/data-freshness';

/**
 * Сколько предупреждений главная берёт из ленты. Лента — выборка с потолком,
 * поэтому число на потолке значит «столько или больше», а не «ровно столько».
 */
export const HOME_ALERTS_LIMIT = 5;

/** «5» при потолке — «5 и больше»: иначе потолок выборки выдавался бы за счёт. */
export function alertsCountLabel(n: number): string {
  return n >= HOME_ALERTS_LIMIT ? `${HOME_ALERTS_LIMIT} и больше` : String(n);
}

export function radarAlertsLine(s: { activeCount: number; maxSeverity: number; degraded?: boolean }): string {
  if (s.degraded) return 'сводка недоступна — не знаем';
  if (s.activeCount === 0) return 'действующих нет';
  const n = s.activeCount;
  const word = n >= HOME_ALERTS_LIMIT ? 'предупреждений' : plural(n, 'предупреждение', 'предупреждения', 'предупреждений');
  const level = s.maxSeverity >= 2 ? ', есть высокой важности' : s.maxSeverity === 1 ? ', средней важности' : '';
  return `${alertsCountLabel(n)} ${word}${level}`;
}

export function radarVolcanoLine(
  volcanoes: { name: string; acc: string }[],
  degraded: boolean | undefined,
  accLabel: Record<string, string>,
): string {
  if (degraded) return 'не знаем — сводка недоступна';
  if (volcanoes.length === 0) return 'повышенных кодов KVERT нет';
  return volcanoes.slice(0, 3).map((v) => `${v.name} — ${accLabel[v.acc] ?? v.acc}`).join(', ')
    + (volcanoes.length > 3 ? ` и ещё ${volcanoes.length - 3}` : '');
}
