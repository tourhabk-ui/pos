/** Подпись сезона маршрута для людей (02.11): в данных лежат коды `all`/`summer`/`winter`
 * рядом с русским текстом. Код переводим, русский текст оставляем, непонятный латинский код
 * не показываем — лучше пусто, чем «all». Ничего не придумываем.
 *
 * `all` и `all-year` не переводятся в «Круглый год» (#3568, 20.11): код ставил импорт
 * паспортов по умолчанию, и карточка обещала круглый год маршрутам, закрытым зимой
 * (Плоский Толбачик — июнь–сентябрь). Тот же код Кузьмич не называет с 03.11
 * (`lib/ai/route-knowledge`). Подтверждённый круглый год миграция пишет словами. */
const CODES: Record<string, string> = {
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
