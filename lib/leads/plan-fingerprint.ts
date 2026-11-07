/**
 * lib/leads/plan-fingerprint.ts — отпечаток плана поездки в заявке (аудит
 * планировщика 07.11, волна 2.4, H8).
 *
 * Дубль заявки определялся по телефону и комментарию за сутки. У заявки со
 * страницы сохранённой поездки комментарий — «Маршрут: Маршрут 2027-07-10
 * (5 дн.)», и он одинаков у разных планов на те же даты: человек поменял план
 * и отправил заявку снова — получил прежний лид, а оператор видел старый
 * план. У заявки из планировщика комментарий пустой, и дубля не ловилось
 * вовсе.
 *
 * Теперь у заявки с планом дубль — тот же телефон, тот же комментарий и тот
 * же отпечаток плана: даты, состав, уровень, дни (номер, дата, род, название,
 * зона, тур), жильё стоянок и что ещё нужно. Комментарий остаётся в ключе:
 * агент прикладывает один план к заявкам на разные туры, жильё и машину, и
 * различает их только он. Цены и смета в отпечаток не входят: план тот же,
 * подорожал тур — это та же заявка. Персональных данных в отпечатке нет — их
 * нет и в плане.
 */
import { createHash } from 'node:crypto';
import { asPlanForLead } from '@/lib/planner/plan-for-lead';

/** Отпечаток плана из source_data заявки; не план — null. */
export function planFingerprint(plan: unknown): string | null {
  const p = asPlanForLead(plan);
  if (!p) return null;
  const canonical = [
    p.v,
    p.arrival ?? null,
    p.trip_origin,
    p.budget_tier,
    p.party.adults,
    // Возраст детей — состав, а не порядок ввода.
    [...p.party.children].sort((a, b) => a - b),
    p.days.map((d) => [d.day, d.date, d.type, d.title, d.zone, d.tour?.id ?? null]),
    (p.lodging ?? []).map((l) => [l.accommodation_id, l.check_in, l.check_out]),
    p.needs ? [p.needs.lodging, p.needs.transfer, p.needs.car] : null,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}
