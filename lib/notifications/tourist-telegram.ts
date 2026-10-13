/**
 * Куда писать туристу в Telegram — одно правило на все рассылки по броням.
 *
 * 13.10 (разбор «как туристы оставляют отзывы»): просьба об отзыве после тура
 * и напоминание накануне искали адрес в users.telegram_chat_id. Эту колонку
 * не пишет никто — миграция 697 только завела её, а привязка Telegram в
 * кабинете пишет users.telegram_id (app/api/telegram/webhook: from.id).
 * Отбор «telegram_chat_id IS NOT NULL» не находил ни одного туриста с сайта,
 * и с самого заведения этого пути (28.08, issue #1422) рассылки отвечали
 * «отправлено 0», не краснея. Одноимённую колонку пишут у partners и
 * operator_members — не у users.
 *
 * В личке бота id чата равен id пользователя, поэтому telegram_id — рабочий
 * адрес. telegram_chat_id остаётся первым: начнут его писать — он точнее.
 * Алиас пользователя в запросе — `u`.
 *
 * Сторож: tests/unit/tourist-telegram-recipient.test.ts.
 */

/** Адрес чата туриста в Telegram для запроса с `JOIN users u`. */
export const TOURIST_TG_CHAT_SQL = 'COALESCE(u.telegram_chat_id, u.telegram_id)';
