/**
 * Правка профиля оператора: у текстового поля три исхода, не два.
 *
 *   строка      — записать;
 *   '' или null — ОЧИСТИТЬ;
 *   undefined   — не трогать.
 *
 * До 25.09 клиент слал `x.trim() || undefined`, а сервер умел только
 * «записать» — стёртый телефон оставался в базе под сообщением «Профиль
 * сохранён» (аудит кабинета оператора, пакет «Г», п.3).
 *
 * Сторож: `tests/unit/operator-profile-patch.test.ts`.
 */

/** '' и null — «очистить»; undefined — «не трогать». */
export function isCleared(v: string | null | undefined): v is '' | null {
  return v === null || v === '';
}

/** Слить объект JSON-колонки (contacts, location): пустое значение удаляет ключ. */
export function mergeClearable(
  current: Record<string, unknown>,
  patch: Record<string, string | null | undefined>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isCleared(value)) delete next[key];
    else next[key] = value;
  }
  return next;
}
