/**
 * Уведомление партнёру БЕЗ персональных данных — в тот канал, где он есть.
 *
 * Сначала MAX (основной канал партнёров), при отказе или отсутствии — Telegram.
 * Так уже умело напоминание оператору в Watchdog (`notifyOperatorDirectly`), а
 * напоминания владельцу жилья, прокату и перевозчику и отмена брони жилья
 * владельцу ходили только в Telegram: партнёр с одним MAX не получал ничего и
 * числился «не подключённым к боту». Одна функция вместо четырёх копий —
 * правило, записанное четыре раза, расходится молча.
 *
 * Договор: в `body` нет ПД туриста или гостя — только счёт, даты, название
 * объекта, имя самого партнёра. Имя и телефон человека уходят ТОЛЬКО через
 * `sendPdAlert` (lib/notifications/pd-alert, решение владельца 23.08).
 *
 * Адрес — из правила достижимости (`reachFrom` / `reachForPartner`), не из
 * одной колонки. Исход возвращается: вызывающему нужно знать, ушло ли.
 */
import { maxSendDm } from '@/lib/notifications/max-channel';

export type NoticeChannel = 'max' | 'telegram';

export interface NoticeTarget {
  maxChatId: string | null;
  telegramChatId: string | null;
}

/**
 * @param body HTML без ПД (как в Telegram: <b>, <i>, <a>).
 * @param link куда партнёру идти: в MAX — кнопкой, в Telegram — ссылкой в тексте.
 * @param who  для лога, без ПД: «оператору «Название»».
 */
export async function sendPartnerNotice(
  to: NoticeTarget,
  body: string,
  link: { text: string; url: string },
  who: string,
): Promise<NoticeChannel | null> {
  if (to.maxChatId) {
    const res = await maxSendDm(to.maxChatId, body, { buttons: [link] })
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : 'MAX error' }));
    if (res.ok) return 'max';
    console.error(`[partner-notice] ${who}: не ушло в MAX — ${res.error ?? 'причина не названа'}`);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !to.telegramChatId) return null;
  const text = `${body}\n\n<a href="${link.url}">${link.text}</a>`;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: to.telegramChatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.error(`[partner-notice] ${who}: не ушло в Telegram — HTTP ${res.status}`);
      return null;
    }
    return 'telegram';
  } catch (e) {
    console.error(`[partner-notice] ${who}: не ушло в Telegram — ${e instanceof Error ? e.message : 'fetch error'}`);
    return null;
  }
}
