import Link from 'next/link';
import { plural } from '@/lib/home/data-freshness';
import { OFFER_ORDER_NOTE } from '@/lib/tours/offer-order';

/**
 * Тур к дню плана выбран правилом 1в (слово владельца 29.10) — одним из
 * нескольких продавцов вида. Строка называет, сколько ещё туров этого вида,
 * и ведёт в каталог с фильтром вида: план не выбирает продавца за туриста
 * молча. Без слов «дешевле» и «лучше». Один тур вида — строки нет.
 *
 * Сторож: tests/unit/plan-tour-rule.test.tsx.
 */
export function PlanKindOffers({ activityType, offers }: { activityType: string; offers?: number }) {
  if (typeof offers !== 'number' || offers < 2) return null;
  const more = offers - 1;
  return (
    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
      Этого вида ещё {more} {plural(more, 'предложение', 'предложения', 'предложений')} —{' '}
      <Link href={`/catalog?activity_type=${encodeURIComponent(activityType)}`} style={{ color: 'var(--ocean)' }}>
        все в каталоге
      </Link>
    </p>
  );
}

/** Подпись правила над днями плана: как выбран тур к дню. */
export const PLAN_TOUR_RULE_RU = `Тур к дню — первый из туров этого вида по правилу витрин. ${OFFER_ORDER_NOTE.ru}`;

export function PlanTourRule() {
  return (
    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{PLAN_TOUR_RULE_RU}</p>
  );
}
