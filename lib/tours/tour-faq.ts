/**
 * Вопросы и ответы о туре (слово владельца 17.11 «2 да но аккуратно»).
 *
 * Блок нужен для ИИ-поиска: он цитирует страницу, которая отвечает на вопрос
 * прямо, одним абзацем. Google расширенные сниппеты FAQ снял 07.05.2026, так
 * что в обычной выдаче блок ничего не даст, и владелец это знает.
 *
 * «Аккуратно» здесь — три правила:
 *
 *  1. **Ответ — из данных тура, и только теми словами, что уже на карточке.**
 *     Каждый ответ собирает та же функция, что рисует раздел карточки, MCP и
 *     `/api/tours` (#3487): цена — `priceWithUnitWords`, длительность —
 *     `cardDuration`, сезон — `tourSeasonWords`, отмена — `tourCancellation`,
 *     подвоз — `pickupForCard`. Своих формулировок у блока нет, и разойтись с
 *     разделом выше ему нечем.
 *  2. **Без ответа нет и вопроса.** Не записано — вопроса нет. «Уточните у
 *     оператора» вместо ответа выдало бы нашу неосведомлённость за условие тура.
 *  3. **Блок говорит не больше агентов.** Размер группы называется, только
 *     когда гид записал «группа не ограничена»: число `max_participants` у части
 *     туров — техническая заглушка, и MCP его фактом не называет
 *     (`groupSentenceIfUnlimited`). Ответ, который процитирует чужой поиск, не
 *     может быть смелее ответа нашего же агента.
 *
 * Разметка FAQPage строится из того же массива, что и видимый блок
 * (`components/faq/FaqSection`): невидимых ответов в ней нет.
 *
 * Сторож: tests/unit/tour-faq.test.tsx.
 */

import { priceWithUnitWords } from '@/lib/tours/price-label';
import { cardDuration, type CardFactsInput } from '@/lib/tours/card-facts';
import { tourSeasonWords, SEASON_NOT_RECORDED, type CalendarRange, type SeasonFacts } from '@/lib/tours/season-words';
import { groupSentenceIfUnlimited, type GroupSizeFacts } from '@/lib/tours/group-size';
import {
  tourCancellation,
  SAFETY_NOTES_CANCELLATION_HEAD,
  CANCELLATION_REST_WITH_OPERATOR,
  type CancellationFacts,
} from '@/lib/tours/cancellation-words';
import { pickupForCard } from '@/lib/tours/pickup';
import type { FaqItem } from '@/lib/seo/faq';

export type { FaqItem } from '@/lib/seo/faq';

/**
 * Кто подтверждает и как платить — одна строка на карточку (под ценой) и на
 * блок вопросов. Зависит от выключателя приёма оплаты (§7,
 * `lib/payments/accepting`).
 */
export function tourPaymentLine(acceptsPayments: boolean): string {
  return acceptsPayments
    ? 'Дату и детали подтверждает оператор — оплата только после подтверждения.'
    : 'Дату и детали подтверждает оператор. Оплата — ему напрямую, после подтверждения: Ведар платежи не принимает.';
}

export interface TourFaqInput extends CardFactsInput, SeasonFacts, GroupSizeFacts, CancellationFacts {
  title: string;
  price_unit?: string | null;
  pickup_type?: string | null;
  pickup_details?: string | null;
  meeting_point?: string | null;
  operator_name?: string | null;
}

const withDot = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

export function tourFaq(
  t: TourFaqInput,
  opts: { acceptsPayments: boolean; calendar?: CalendarRange | null },
): FaqItem[] {
  const name = `«${t.title}»`;
  const items: FaqItem[] = [];

  const price = priceWithUnitWords(t.base_price, t.price_unit);
  if (price) items.push({ question: `Сколько стоит тур ${name}?`, answer: withDot(price) });

  items.push({ question: `Как записаться на тур ${name} и как его оплатить?`, answer: tourPaymentLine(opts.acceptsPayments) });

  const duration = cardDuration(t);
  if (duration) items.push({ question: `Сколько длится тур ${name}?`, answer: `${duration}.` });

  const season = tourSeasonWords(t, opts.calendar);
  if (season !== SEASON_NOT_RECORDED) {
    items.push({
      question: `Когда проходит тур ${name}?`,
      answer: season.startsWith('не записан') ? withDot(`Сезон ${season}`) : withDot(`Сезон: ${season}`),
    });
  }

  const group = groupSentenceIfUnlimited(t);
  if (group) items.push({ question: `Сколько человек в группе тура ${name}?`, answer: group });

  const pickup = pickupForCard(t.pickup_type, t.pickup_details, t.meeting_point);
  if (pickup) {
    items.push({
      question: `Как попасть на тур ${name}?`,
      answer: [withDot(pickup.title), pickup.summary, ...pickup.lines.map(withDot)].join(' '),
    });
  }

  const cancellation = tourCancellation(t);
  if (cancellation.kind === 'policy') {
    items.push({
      question: `Можно ли отменить тур ${name}?`,
      answer: `${cancellation.lines.map(withDot).join(' ')} Условия оператора.`,
    });
  } else if (cancellation.kind === 'safety_notes') {
    items.push({
      question: `Можно ли отменить тур ${name}?`,
      answer: `${SAFETY_NOTES_CANCELLATION_HEAD}: ${cancellation.lines.map(withDot).join(' ')} ${CANCELLATION_REST_WITH_OPERATOR}`,
    });
  }

  const operator = (t.operator_name ?? '').trim();
  if (operator) items.push({ question: `Кто проводит тур ${name}?`, answer: `Тур проводит «${operator}».` });

  return items;
}
