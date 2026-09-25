/**
 * Отказ базы в кабинете гида называется вслух (§4.0): имя проверки и SQLSTATE.
 *
 * Кабинет гида прожил месяцы на пустых `catch`: профиль не сохранялся
 * (42703 на несуществующих колонках), заработок не читался (42883 на
 * сравнении uuid с bigint), уведомление об ответе на отзыв не уходило (23514
 * на priority='medium'), и ни одна из поломок не оставила строки в логе.
 */

export function sqlState(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'нет';
}

export function logGuideFailure(check: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[guide] ${check} не выполнился: sqlstate=${sqlState(err)}`, msg);
}
