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
  const hasPlus = digits.startsWith('+');
  const bare = digits.replace(/^\+/, '');
  if (!/^\d{10,15}$/.test(bare)) return null;
  if (/^8\d{10}$/.test(bare)) return `+7${bare.slice(1)}`;
  // Десять цифр без плюса («900 123-45-67») — российский номер без кода
  // страны. Прежде он становился «+9001234567», по которому оператору нечем
  // позвонить (проверка MCP 29.09; то же правило жило только в запросе мест).
  if (!hasPlus && bare.length === 10) return `+7${bare}`;
  return `+${bare}`;
}

/**
 * Маска поля, не вторая нормализация. В заявку по-прежнему уходит
 * `normalizePhone`: иностранный код (не 7 и не 8) эта маска не переписывает
 * в +7, иначе турист не из России не смог бы набрать свой номер.
 * Пустая строка остаётся пустой — «+7» само не подставляется, пока не начали ввод.
 */
export function maskRuPhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  const foreign = trimmed.startsWith('+') && !digits.startsWith('7') && !digits.startsWith('8');
  if (foreign) return `+${digits.slice(0, 15)}`;
  let d = digits;
  if (d.startsWith('8')) d = `7${d.slice(1)}`;
  if (!d.startsWith('7')) d = `7${d}`;
  d = d.slice(0, 11);
  const n = d.slice(1);
  let out = '+7';
  if (n.length) out += ` ${n.slice(0, 3)}`;
  if (n.length > 3) out += ` ${n.slice(3, 6)}`;
  if (n.length > 6) out += `-${n.slice(6, 8)}`;
  if (n.length > 8) out += `-${n.slice(8, 10)}`;
  return out;
}
