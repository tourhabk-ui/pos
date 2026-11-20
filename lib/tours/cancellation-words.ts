/**
 * Условия отмены тура словами — одно правило на карточку, форму заявки, MCP и
 * `/api/tours/[id]` (#3487, 17.11).
 *
 * Повод. У Узона «Края Вулканов» (ID45) поле условий
 * (`operator_tours.cancellation_policy`) пусто, а в правилах безопасности
 * (`safety_notes`, миграция 1176) оператор написал: «При отмене экскурсии из-за
 * погоды деньги возвращаются в полном объёме». Карточка показывала фразу в
 * «Правилах на маршруте», форма заявки писала «Условия отмены оператор не
 * записал», а MCP — «Условия отмены … НЕ ЗАПИСАНЫ». Три поверхности спорили
 * об одном факте, который в базе есть.
 *
 * Правило, в порядке силы:
 *   1. Записан текст условий — он и есть ответ (`policy`).
 *   2. Текста нет, а в правилах безопасности оператор пишет о возврате денег
 *      или удержании — эти фразы и есть ответ, названные словами оператора из
 *      правил безопасности (`safety_notes`). Сроков и процентов сверх них нет.
 *   3. Ни того, ни другого — «не записано» (`none`).
 *
 * Чего здесь нет намеренно: обещания от лица платформы. «При отмене вернём
 * всю сумму» — слова платёжного пути, а оплату Ведар не принимает (§7,
 * `lib/payments/accepting`). Правило возврата при включённой оплате — по-прежнему
 * `computeTourRefund`; этот модуль его не трогает.
 *
 * Отбор фраз — двумя признаками сразу: фраза говорит об отмене («отмена»,
 * «отказ», «не состоялась») И о деньгах («возврат», «деньги», «оплата»,
 * «предоплата», «удерживается», «штраф», проценты). Одного слова мало:
 *   — «возможны задержки, переносы и отмены» — правило о погоде, денег нет;
 *   — «не возвращайтесь к берегу до отбоя тревоги» — правило о цунами
 *     (тур ID124, 20.11): по одному корню «возвращ» оно встало в «Условия
 *     отмены» на карточке, в форме заявки и в MCP. «Возврат» как слово о
 *     деньгах — существительное; глагол «возвращаться» о деньгах говорит
 *     только рядом с «деньги» или «оплата».
 *
 * Сторож: tests/unit/tour-surfaces-agree.test.ts.
 */

import { cancellationTermsForForm, refundTermsRecorded, type TourRefundTerms } from '@/lib/payments/tour-refund';

export interface CancellationFacts {
  cancellation_policy?: string | null;
  safety_notes?: readonly unknown[] | null;
}

export type TourCancellation =
  | { kind: 'policy'; lines: string[] }
  | { kind: 'safety_notes'; lines: string[] }
  | { kind: 'none' };

/** Фраза говорит об отмене поездки. */
const CANCEL_WORD = /(отмен|отказ|не\s+состо)/i;
/** Фраза говорит о деньгах: «возврат» — существительное, не «возвращайтесь». */
const MONEY_WORD = /(возврат(?![а-яё]*ся)|деньг|денежн|оплат|стоимост|сумм|аванс|удерж|штраф|неустойк|%)/i;

/** Фразы правил безопасности о возврате денег или удержании. */
export function cancellationNotesFromSafety(notes: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(notes)) return [];
  return notes
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter((n) => n.length > 0 && CANCEL_WORD.test(n) && MONEY_WORD.test(n));
}

/** Что известно об условиях отмены тура — по правилу выше. */
export function tourCancellation(t: CancellationFacts): TourCancellation {
  const policy = (t.cancellation_policy ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (policy.length > 0) return { kind: 'policy', lines: policy };
  const fromSafety = cancellationNotesFromSafety(t.safety_notes);
  if (fromSafety.length > 0) return { kind: 'safety_notes', lines: fromSafety };
  return { kind: 'none' };
}

/** Подпись к фразам из правил безопасности — одна на карточку, форму и MCP. */
export const SAFETY_NOTES_CANCELLATION_HEAD = 'Об отмене оператор пишет в правилах безопасности тура';

/** Остальное — у оператора: одна оговорка на все поверхности. */
export const CANCELLATION_REST_WITH_OPERATOR = 'Других сроков и процентов оператор не называл — остальное уточняется у него.';

/**
 * Одна строка для формы заявки и `/api/tours/[id]`: текст условий оператора
 * или его слова из правил безопасности. Ничего не записано — `null`: тогда
 * вызывающий говорит своё «не записано» (форма — `cancellationTermsForForm`).
 */
export function cancellationOperatorWords(t: CancellationFacts): string | null {
  const c = tourCancellation(t);
  if (c.kind === 'policy') return `Условия отмены оператора: ${c.lines.join(' ')}`;
  if (c.kind === 'safety_notes') return `${SAFETY_NOTES_CANCELLATION_HEAD}: «${c.lines.join(' ')}» ${CANCELLATION_REST_WITH_OPERATOR}`;
  return null;
}

/**
 * Строка условий в форме заявки. Пока оплату Ведар не принимает и числа
 * условий не записаны, форма говорит словами оператора (текст условий или
 * фразы из правил безопасности), а не «оператор не записал»; нет и их — прежняя
 * строка `cancellationTermsForForm`. Числа записаны или оплата включена —
 * правило возврата `cancellationTermsForForm` без изменений.
 */
export function cancellationLineForForm(
  terms: TourRefundTerms,
  facts: CancellationFacts | null | undefined,
  tourDate: string | null,
  acceptsPayments: boolean,
  now: Date = new Date(),
): string {
  if (!acceptsPayments && !refundTermsRecorded(terms) && facts) {
    const words = cancellationOperatorWords(facts);
    if (words) return `${words} Оплату вы вносите оператору напрямую: Ведар платежи не принимает.`;
  }
  return cancellationTermsForForm(terms, tourDate, acceptsPayments, now);
}
