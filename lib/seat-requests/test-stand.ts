/**
 * lib/seat-requests/test-stand.ts — тестовый стенд пилота «Камчатская
 * рыбалка» (24.10, владелец: «я хочу протестировать через макс»).
 *
 * Тестовый оператор «Тестовый оператор Ведар» (flo+operator@vedarai.ru)
 * проходит весь путь запроса мест — запрос, кнопки в MAX, бронь — по своему
 * НЕОПУБЛИКОВАННОМУ туру. Витрина его не показывает (publicTourSql не
 * тронут): запрос открывается только страницей /seat-request/test?tour=<id>
 * (noindex), и только для тура этого оператора. Настоящий партнёр и его
 * чат не задействованы.
 *
 * Убрать стенд — удалить id из списка (и тур в кабинете тестового оператора).
 */
export const TEST_STAND_PARTNER_IDS: readonly string[] = [
  '0c595568-163b-4870-ab03-edf60d1d939e',
];

export function isTestStandPartner(partnerId: string | null | undefined): boolean {
  return !!partnerId && TEST_STAND_PARTNER_IDS.includes(partnerId);
}
