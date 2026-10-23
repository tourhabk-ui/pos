/**
 * lib/kuzmich/delivery-claim-guard.ts — утверждения Кузьмича о доставке
 * сверяются с инструментами этого же хода (15.10).
 *
 * Повод — снимок владельца 15.10: внешний агент прислал по A2A «проверка
 * доставки сообщения в MAX через Кузьмича, всё ли дошло?», и Кузьмич ответил
 * «Сообщение дошло, связка работает» — не вызвав ни одного инструмента. Дойти
 * было некуда: у Кузьмича нет инструмента, который что-то отправляет
 * оператору; заявка оператору идёт только через create_lead,
 * create_booking_request, create_stay_request, request_charter или create_car_rental_request — другим
 * путём, с согласием человека. Модель отчиталась о действии, которого не
 * совершала. На живой заявке такой ответ стоит дороже: турист решит, что
 * оператор уведомлён, и будет ждать ответа, которого не будет.
 *
 * Это тот же класс ошибки, что «безопасно, можно идти» без данных
 * (safety-claim-guard, #2300), и чинится тем же приёмом — не абзацем в
 * промпте, а детерминированной сверкой (§8: «критичные факты — только из
 * инструментов, самоотчётам модели не верить»).
 *
 * Правило: утверждение «дошло / доставлено / передал оператору / заявка
 * отправлена / связка работает» считается обоснованным, только если в этом
 * ходе был инструмент из DELIVERY_TOOLS, принёсший данные. Иначе предложение
 * с утверждением заменяется честной строкой — целиком, как километраж «от
 * города» (distance-guard): оставить фразу «дошло» рядом с поправкой значило
 * бы показать ложь и опровержение вместе, и человек запомнит первое.
 *
 * Под отрицанием («не доставлено», «сообщения я не отправляю») — не
 * утверждение, не трогается.
 *
 * Модуль чистый: текст и журнал инструментов на входе, текст и вердикт на
 * выходе. Сторож: tests/unit/kuzmich-delivery-claim-guard.test.ts.
 */

import type { ToolRun } from '@/lib/agents/eval/grounding';
import { isNegated } from './safety-eval';

/**
 * Инструменты, после которых слова о доставке имеют основание. В цикле
 * Кузьмича (KUZMICH_TOOLS) их нет вовсе: заявки пишут MCP и A2A другим путём.
 * Список держится на случай, если такой инструмент в цикле появится, — тогда
 * он обязан попасть сюда вместе с производителем (§10.09).
 */
export const DELIVERY_TOOLS: ReadonlySet<string> = new Set([
  'create_lead', 'create_booking_request', 'create_stay_request', 'request_charter', 'create_car_rental_request',
]);

/**
 * «Дошло» и родня — граница слова руками: JS \b кириллицу не знает.
 * Ловится утверждение о том, что сообщение/заявка ДОСТАВЛЕНЫ или ПЕРЕДАНЫ
 * кому-то, и обещание «связка/канал работает» как итог проверки доставки.
 */
const DELIVERY_CLAIM_RE = /(?<![а-яё])(дошл[оаи]|доставлен[оаы]?|доставил[аи]?|передал[аи]? (оператору|партн[её]ру|заявку|сообщение)|отправил[аи]? (оператору|партн[её]ру|заявку|сообщение)|заявк[аи] (отправлен[аы]|передан[аы]|ушл[аи]|принят[аы] оператором)|сообщени[ея] (отправлен[оы]|передан[оы]|доставлен[оы])|оператор (уведомл[её]н|получил|извещ[её]н)|(связка|канал|доставка) работает)(?![а-яё])/giu;

export const DELIVERY_HONEST_LINE =
  'Поправка: сам я сообщения операторам не отправляю и доставку не проверял. '
  + 'Заявка уходит оператору только через форму заявки или инструмент заявки с твоим согласием — после неё я скажу, принята ли она.';

export type DeliveryVerdict =
  | 'none'          // утверждений о доставке нет
  | 'backed'        // в этом ходе был инструмент заявки с данными
  | 'unbacked';     // сказано «дошло», а отправлять было нечем

export interface DeliveryGuardResult {
  text: string;
  verdict: DeliveryVerdict;
  /** Вырезанные предложения — для лога и теста, не для показа. */
  removed: string[];
  /** Совпавшие фразы — для журнала разбора. */
  phrases: string[];
}

function splitSentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
}

/** Утверждения о доставке в тексте, не под отрицанием. */
export function findDeliveryClaims(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(DELIVERY_CLAIM_RE)) {
    if (isNegated(answer, m.index ?? 0, m[0].length)) continue;
    out.push(m[0]);
  }
  return out;
}

/**
 * Сверить слова о доставке с журналом хода. `toolRuns === null` — ответ
 * пришёл без инструментов (запасной путь): отправить было нечем, значит
 * любое «дошло» — без опоры.
 */
export function guardDeliveryClaims(answer: string, toolRuns: readonly ToolRun[] | null): DeliveryGuardResult {
  const phrases = findDeliveryClaims(answer);
  if (phrases.length === 0) return { text: answer, verdict: 'none', removed: [], phrases };

  const delivered = (toolRuns ?? []).some((r) => DELIVERY_TOOLS.has(r.name) && r.producedData);
  if (delivered) return { text: answer, verdict: 'backed', removed: [], phrases };

  const removed: string[] = [];
  const paragraphs = answer.split(/\n\s*\n/).map((para) => {
    const sentences = splitSentences(para);
    if (sentences.length === 0) return para;
    const kept: string[] = [];
    let inserted = false;
    for (const s of sentences) {
      const claims = [...s.matchAll(DELIVERY_CLAIM_RE)].filter((m) => !isNegated(s, m.index ?? 0, m[0].length));
      if (claims.length === 0) { kept.push(s); continue; }
      removed.push(s);
      if (!inserted) { kept.push(DELIVERY_HONEST_LINE); inserted = true; }
    }
    return kept.join(' ');
  });

  return { text: paragraphs.join('\n\n'), verdict: 'unbacked', removed, phrases };
}
