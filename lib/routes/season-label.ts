/** Подпись сезона маршрута для людей (02.11): в данных лежат коды `all`/`summer`/`winter`
 * рядом с русским текстом. Код переводим, русский текст оставляем, непонятный латинский код
 * не показываем — лучше пусто, чем «all». Ничего не придумываем. */
const CODES: Record<string, string> = {
  all: 'Круглый год',
  'all-year': 'Круглый год',
  summer: 'Лето',
  winter: 'Зима',
  spring: 'Весна',
  autumn: 'Осень',
  fall: 'Осень',
};

export function seasonLabel(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const code = CODES[s.toLowerCase()];
  if (code) return code;
  if (/^[a-z_\-\s]+$/i.test(s)) return null;
  return s;
}
