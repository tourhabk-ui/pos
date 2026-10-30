/**
 * lib/leads/lead-people.ts — сколько людей в заявке, только записанное.
 *
 * `leads.group_size` заведена с DEFAULT 1 (083) и не пишется ни одной дверью:
 * взять её значит сказать партнёру «человек: 1» про заявку на вахтовку на
 * двадцать человек (ревью 30.10, §4.0). Число есть только там, где его дала
 * дверь, — в `source_data`:
 *  - `passengers` — заявка на машину (форма перевозчика, MCP request_charter);
 *  - `participants` — заявка на бронь тура через MCP (create_booking_request).
 * Нет числа — NULL, и подпись его не называет.
 *
 * Значение приходит из jsonb: целое берётся только целым числом из цифр —
 * строка или дробь не роняет весь запрос ошибкой приведения.
 */

/** SQL-выражение числа людей лида `alias` (литерал псевдонима, не ввод). */
export function leadPeopleSql(alias: 'l'): string {
  return `(CASE
            WHEN (${alias}.source_data->>'passengers') ~ '^[0-9]{1,4}$' THEN (${alias}.source_data->>'passengers')::int
            WHEN (${alias}.source_data->>'participants') ~ '^[0-9]{1,4}$' THEN (${alias}.source_data->>'participants')::int
          END)`;
}
