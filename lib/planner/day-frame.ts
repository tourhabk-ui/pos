/**
 * Рамка поездки на экране планировщика: подпись «Прилёт»/«Вылет» и запрет
 * двигать день — по ТИПУ дня, а не по месту в списке (разбор планера 14.11,
 * экран-8).
 *
 * У жителя края дней прилёта и отъезда нет (lib/planner/trip-origin), а экран
 * подписывал первый и последний день «Прилёт» и «Вылет» и запирал их: у
 * «Мутновского вулкана» первым днём не было ни «Удалить», ни перетаскивания.
 *
 * Сторож: tests/unit/planner-day-frame.test.ts.
 */
export interface DayFrame {
  /** Подпись рейса у дня; нет — день не рамка поездки. */
  badge?: string;
  /** День рамки: не удаляется и не переставляется. */
  locked: boolean;
}

export function dayFrame(
  day: { type: string },
  flight: { arrival?: string; departure?: string } = {},
): DayFrame {
  if (day.type === 'arrival') return { badge: flight.arrival || 'Прилёт', locked: true };
  if (day.type === 'departure') return { badge: flight.departure || 'Вылет', locked: true };
  return { locked: false };
}
