/**
 * Обстановка на дату и место тура — одно правило (#2969, 03.11).
 *
 * До этого дня обстановку на день выезда собирали по-разному: напоминание за
 * двое суток брало ТЕКУЩУЮ погоду Петропавловска (wttr.in) и выдавало её за
 * прогноз на дату тура, напоминание за сутки — прогноз той же точки, а Rescue
 * судил погоду, официальные предупреждения и опасность зон по-своему и
 * говорил только владельцу. Ни турист, ни оператор этого не видели.
 *
 * Здесь — суждение из уже существующих правил Rescue (`judgeForecastDay`,
 * `matchOfficialAlerts`) и оценки зоны. Три исхода (§4.0):
 *  - risk — есть опасная погода, официальное предупреждение по зоне или
 *    высокая опасность зоны; перечислено, что именно;
 *  - unknown — опасного не найдено, но хоть что-то проверить не смогли;
 *  - calm — проверено всё, опасного нет.
 * Советов «отменить» и оценок «безопасно» здесь нет: решение о выезде —
 * за оператором, Ведар только называет факты.
 *
 * Модуль чистый: без базы и без сети.
 */
import type { DayVerdict, OfficialAlert } from '@/lib/agents/evo/rescue-judge';

export type SituationKind = 'calm' | 'risk' | 'unknown';

export interface ZoneDangerInput {
  /** Название зоны словами («Авачинская группа»). */
  name: string;
  level: 'low' | 'moderate' | 'high' | 'critical';
}

export interface SituationInput {
  /** Суждение о погоде дня; null — координат тура нет, прогноз не спрашивали. */
  weather: DayVerdict | null;
  /** Официальные предупреждения, относящиеся к туру; 'failed' — лента не прочиталась. */
  officials: OfficialAlert[] | 'failed';
  /** У тура нет зоны маршрута, а зональные предупреждения есть — сверить нельзя. */
  officialsUnassessed: boolean;
  /** Оценка опасности зоны; null — зона не оценивается; 'failed' — не прочиталась. */
  zoneDanger: ZoneDangerInput | null | 'failed';
}

export interface Situation {
  kind: SituationKind;
  /** Что опасно — по пункту на источник. */
  risks: string[];
  /** Что проверить не смогли. */
  unchecked: string[];
}

const LEVEL_WORD: Record<'high' | 'critical', string> = { high: 'высокая', critical: 'критическая' };

export function judgeSituation(input: SituationInput): Situation {
  const risks: string[] = [];
  const unchecked: string[] = [];

  const w = input.weather;
  if (w === null) unchecked.push('погоду — у тура не записаны координаты');
  else if (w.kind === 'hazard') risks.push(`погода: ${w.labels.join(', ')}`);
  else if (w.kind === 'fog') risks.push('погода: туман');
  else if (w.kind === 'unknown') unchecked.push(`погоду — ${w.reason}`);

  if (input.officials === 'failed') unchecked.push('официальные предупреждения — лента не прочиталась');
  else {
    for (const a of input.officials) risks.push(`официальное предупреждение: ${a.title.replace(/\s+/g, ' ').trim()}`);
    if (input.officialsUnassessed) unchecked.push('официальные предупреждения по зоне — у тура не записана зона маршрута');
  }

  const z = input.zoneDanger;
  if (z === 'failed') unchecked.push('оценку опасности зоны — не прочиталась');
  else if (z && (z.level === 'high' || z.level === 'critical')) risks.push(`опасность в зоне «${z.name}»: ${LEVEL_WORD[z.level]}`);

  const kind: SituationKind = risks.length > 0 ? 'risk' : unchecked.length > 0 ? 'unknown' : 'calm';
  return { kind, risks, unchecked };
}

/** Одна строка для человека: оператору в «Сегодня», в журнал, в напоминание. */
export function situationLine(s: Situation): string {
  const tail = s.unchecked.length > 0 ? ` Не проверено: ${s.unchecked.join('; ')}.` : '';
  if (s.kind === 'risk') return `есть риски — ${s.risks.join('; ')}.${tail}`;
  if (s.kind === 'unknown') return `опасного не найдено, но не смог проверить ${s.unchecked.join('; ')}.`;
  return 'спокойно: в прогнозе нет опасной погоды, официальных предупреждений по зоне тура нет.';
}

/** Повтор отправки — только когда изменилось то, что говорится человеку. */
export function situationFingerprint(s: Situation): string {
  return `${s.kind}|${s.risks.join('|')}`;
}

function ruDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/**
 * Туристу за двое суток — только при риске (решение по #2969). Без советов
 * отменить: решает оператор. ПД нет: название тура, дата и факты.
 */
export function touristSituationText(args: { tourTitle: string; date: string; situation: Situation }): string {
  return [
    `Поездка «${args.tourTitle}» ${ruDate(args.date)}: по данным Ведара ${situationLine(args.situation)}`,
    'Решение о выезде принимает оператор тура: если планы изменятся, он свяжется с вами. Вопрос можно задать ему или Кузьмичу.',
    'Экстренный вызов — 112.',
  ].join('\n');
}

/** Оператору — при риске, по каждому выезду. Решение за ним; Ведар ничего не отменяет и не переносит. */
export function operatorSituationText(args: {
  tourTitle: string; date: string; situation: Situation; travellers: number; touristsInformed: number;
}): string {
  const told = args.touristsInformed > 0
    ? `Туристам этого выезда та же строка фактов ушла: ${args.touristsInformed}.`
    : 'Туристам этого выезда Ведар ничего не отправил: канала связи с ними нет или сообщение не дошло.';
  return [
    `Выезд «${args.tourTitle}» ${ruDate(args.date)} (броней и заявок: ${args.travellers}): ${situationLine(args.situation)}`,
    'Решение о выезде — за вами: Ведар ничего не отменяет и не переносит.',
    told,
  ].join('\n');
}
