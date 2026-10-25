/**
 * Пилот кабинета прокатчика в MAX.
 *
 * Включается списком slug в RENTAL_OPERATOR_PILOT_SLUGS (через запятую).
 * Переменная не задана — список равен одному названному пилоту
 * `laguna-prokat`: остальные операторы этот путь не видят, а кабинет «Лагуны»
 * не ждёт ручной записи в панели. Пустая строка — никого: так кабинет
 * выключают, не снимая код.
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

/** Пилот, когда переменную не задали. Пустая строка его не включает. */
const NAMED_PILOT_WHEN_UNSET = ['laguna-prokat'] as const;

export function rentalPilotSlugs(raw: string | undefined = process.env.RENTAL_OPERATOR_PILOT_SLUGS): readonly string[] {
  if (raw === undefined) return [...NAMED_PILOT_WHEN_UNSET];
  if (raw.trim() === '') return [];
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
    + 'Сюда будут приходить заявки на прокат с именем и телефоном заказчика. '
    + 'Под заявкой — «Беру» и «Не могу»: «Беру» отмечает эти дни занятыми.';
}

/**
 * Уже привязанный прокатчик нажал обычный «Старт» без новой ссылки.
 * Привязку это не меняет — и текст не обещает того, чего кабинет ещё не делает.
 */
export function rentalPilotGreeting(partnerName: string): string {
  return `Вы подключены как прокатчик «${escapeHtml(partnerName)}». `
    + 'Этот «Старт» без ссылки ничего не переключает: чат уже ваш, заявки на прокат приходят сюда. '
    + 'На заявке — «Беру» и «Не могу».';
}

/**
 * То же для Telegram. Заявка с именем и телефоном заказчика уходит в MAX
 * (lib/notifications/partner-request-notify); в Telegram приходит только
 * заглушка без контактов и без кнопок, и то когда в MAX не доставилось.
 * Ответить на заявку здесь можно только из списка «Заявки».
 */
export function rentalPilotTelegramGreeting(partnerName: string): string {
  return `Вы подключены как прокатчик «${escapeHtml(partnerName)}». `
    + 'Этот «Старт» без ссылки ничего не переключает. '
    + 'Заявка на прокат с именем и телефоном заказчика приходит в MAX. '
    + 'Сюда — только короткое уведомление без контактов и без кнопок, когда в MAX её доставить не удалось. '
    + 'Ответить «Беру» или «Не могу» здесь можно в «Заявках».';
}
