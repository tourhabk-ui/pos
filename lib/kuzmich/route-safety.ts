/**
 * Строка безопасности под ответом о маршруте (разбор плохих исходов 03.11).
 *
 * За 30 дней 12 плохих оценок Кузьмича — «не упомянута безопасность, хотя
 * вопрос о конкретном маршруте». Фикстура эвала 03.11: из 13 ответов о
 * маршрутах и безопасности 112 назван в трёх. Промпт уже просит напоминать о
 * МЧС — модель делает это через раз. Поэтому строка дописывается кодом.
 *
 * Что в строке — только то, что известно наверняка:
 * - действующее предупреждение МЧС о месте из ВОПРОСА — из того же блока
 *   `mchsPromptBlock`, что видела модель (живые `external_alerts`). Места из
 *   ответа уже помечает `appendOfferingFlags`, повтора нет. Блока нет или
 *   сводка не прочитана — про обстановку не сказано ничего: «тревог нет» мы
 *   не знаем, и уровень не выдумывается;
 * - регистрация группы в МЧС и срок — из `lib/safety/mchs-registration`;
 * - 112.
 *
 * Не дописывается: вопрос не о маршруте; в ответе уже есть 112; вопрос — ЧП
 * (блок 112 ставит `withSosBlock`).
 */

import {
  offeringMatches, offeringSentence, warningsFromBlock, MCHS_UNREAD_NOTE,
} from '@/lib/safety/mchs-bulletin';
import { MCHS_DEADLINE_SHORT, MCHS_LEAD_WORKING_DAYS, MCHS_SOURCE } from '@/lib/safety/mchs-registration';
import { detectEmergency } from '@/lib/safety/sos-detector';

/** Вопрос о выходе на природу: маршрут, поход, вулкан, самостоятельная поездка. */
const ROUTE_Q = /маршрут|поход|поднят|подъ[её]м|восхожд|трек|тропа|тропе|вулкан|сопк|перевал|ледник|кратер|долин[аеуы]\s+гейзер|самостоятельн|дикар|без гида|пешк|сплав|ночёвк|ночевк|палатк|медвед|озер|бухт|остров|кальдер|водопад|горячи[еx]\s+источник|bear|lake|route|hike|hiking|trek|volcano|trail/i;

/** Вопрос о покупке, а не о выходе: «какие туры», «почём», «забронировать». */
const COMMERCIAL_Q = /(?:^|[^а-яё])(?:тур[аыов]?|туров)(?![а-яё])|цен[аыу]|стоит|почём|почем|брон|купить/i;

export function isRouteQuestion(question: string): boolean {
  return ROUTE_Q.test(question) && !COMMERCIAL_Q.test(question);
}

const HAS_112 = /(?:^|\D)112(?:\D|$)/;
const HAS_MCHS_REG = /МЧС[^.\n]{0,80}регистр|регистр[^.\n]{0,80}МЧС/i;

export const ROUTE_112_LINE = 'Если что-то случилось — звоните 112.';
export const ROUTE_SAFETY_LINE =
  `Безопасность: группу на маршрут регистрируйте в МЧС за ${MCHS_LEAD_WORKING_DAYS} рабочих дней до выхода; если что-то случилось — звоните 112.`;

/** Откуда факты строки — для контекста судьи эвала. */
export const ROUTE_SAFETY_SOURCE =
  `РЕГИСТРАЦИЯ ТУРГРУППЫ В МЧС (${MCHS_SOURCE.authority}, ${MCHS_SOURCE.asOf}): ${MCHS_DEADLINE_SHORT}. Единый номер экстренных служб — 112.`;

/**
 * Дописать строку безопасности к ответу о маршруте. `context` — данные хода
 * с блоком предупреждений МЧС (как у `appendOfferingFlags`).
 */
export function appendRouteSafety(answer: string, question: string, context: string): string {
  if (!answer.trim() || !isRouteQuestion(question)) return answer;
  if (detectEmergency(question).detected) return answer;
  if (HAS_112.test(answer)) return answer;

  const lines: string[] = [];
  // Сводка не прочитана — об обстановке молчим (оговорку «безопасно» ставит appendUnreadSafety).
  if (!context.includes(MCHS_UNREAD_NOTE)) {
    for (const w of warningsFromBlock(context)) {
      if (!offeringMatches(question, w) || offeringMatches(answer, w)) continue;
      const s = offeringSentence(w);
      if (!answer.includes(s) && !lines.includes(s)) lines.push(s);
    }
  }
  lines.push(HAS_MCHS_REG.test(answer) ? ROUTE_112_LINE : ROUTE_SAFETY_LINE);
  return `${answer.trim()}\n\n${lines.join('\n')}`;
}
