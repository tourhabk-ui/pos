/**
 * Нормализация телефона в заявках MCP (аудит 08.08, замечание 2: телефон
 * принимался любой строкой ≥5 символов — «привет» прошёл бы как номер).
 *
 * Мягкая валидация, не строго-РФ: платформа российская, но турист бывает
 * иностранным. Правила: только цифры (+ ведущий плюс), 10–15 цифр (E.164),
 * российский 8XXXXXXXXXX приводится к +7XXXXXXXXXX, 7XXXXXXXXXX — к +7…
 * Мусор → null, заявка не создаётся с внятной ошибкой.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  const bare = digits.replace(/^\+/, '');
  if (!/^\d{10,15}$/.test(bare)) return null;
  if (/^8\d{10}$/.test(bare)) return `+7${bare.slice(1)}`;
  return `+${bare}`;
}
