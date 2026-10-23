/**
 * Пилот кабинета прокатчика в MAX.
 *
 * Включается только списком slug в RENTAL_OPERATOR_PILOT_SLUGS (через
 * запятую). Пустая или отсутствующая переменная — кабинет выключен у всех,
 * включая «Лагуну»: чужой оператор и перевозчик этот путь не видят.
 *
 * Привязка чата — та же ссылка op_, что у любого партнёра
 * (lib/partners/channel-link): её выдаёт администратор, «Старт» по ней пишет
 * partners.max_chat_id. Обычный «Старт» без ссылки привязку не создаёт.
 *
 * Одноразовая ссылка администратора adm_ (lib/max/admin-link, #2746) сюда не
 * подходит: она привязывает человека с ролью администратора, а не карточку
 * прокатчика, и живёт 10 минут. Префикс другой, запись — в другую таблицу.
 */

import { escapeHtml } from '@/lib/text/escape-html';

export function rentalPilotSlugs(raw: string | undefined = process.env.RENTAL_OPERATOR_PILOT_SLUGS): readonly string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const slug = part.trim().toLowerCase();
    if (!slug || seen.has(slug) || slug.length > 80) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

export function isRentalPilotSlug(slug: string | null | undefined, raw?: string): boolean {
  if (!slug) return false;
  return rentalPilotSlugs(raw).includes(slug.trim().toLowerCase());
}

/** Ответ в MAX после «Старт» по ссылке op_, когда партнёр в пилоте. Канал шлёт HTML. */
export function rentalPilotBoundText(partnerName: string): string {
  return `Готово: вы подключены как прокатчик «${escapeHtml(partnerName)}». `
    + 'Сюда будут приходить заявки на прокат с именем и телефоном заказчика.';
}

/**
 * Уже привязанный прокатчик нажал обычный «Старт» без новой ссылки.
 * Привязку это не меняет — и текст не обещает того, чего кабинет ещё не делает.
 */
export function rentalPilotGreeting(partnerName: string): string {
  return `Вы подключены как прокатчик «${escapeHtml(partnerName)}». `
    + 'Этот «Старт» без ссылки ничего не переключает: чат уже ваш, заявки на прокат приходят сюда.';
}
