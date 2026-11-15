/**
 * Заявка внешнего агента в два вызова (#3399, п. 4, lib/mcp/human-confirmation):
 * первый вызов — черновик с кодом, второй — с кодом. Тестам, которые судят
 * исход записи, нужен код из черновика.
 */
export function confirmationCodeOf(text: string): string {
  const m = /confirmation: "([0-9a-z]{1,10}\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{22})"/.exec(text);
  if (!m) throw new Error(`В ответе нет кода подтверждения: ${text.slice(0, 300)}`);
  return m[1];
}

/** Черновик первого шага: заявка не создана, код выдан. */
export function isDraft(text: string): boolean {
  return /Черновик: заявка ещё НЕ создана/.test(text);
}
