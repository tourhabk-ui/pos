/**
 * lib/notifications/tg-send.ts
 *
 * Отправка тревоги в Telegram, которая ВОЗВРАЩАЕТ ИСХОД.
 *
 * Правило выведено Watchdog'ом 30.08: до того у него стоял `catch { // Silent
 * fail }`, ответ Telegram не читался вовсе, и тревога могла собраться и не
 * уйти — без строки в логе, при зелёном прогоне. Сторож без исправного рупора
 * неотличим от сторожа, которому не о чем доложить.
 *
 * Находка аудита 08.09: правило осталось жить в одном файле. Евалы Кузьмича и
 * сканер противоречий о безопасности слали `void fetch(...).catch(() => {})`
 * и записывали `alerts_sent: alertText !== null` — то есть «мы решили
 * тревожить» выдавалось за «тревога доставлена». Правило, записанное в одном
 * месте и не исполняемое в другом, — это отсутствующее правило (§12).
 *
 * Отказ НЕ бросает исключение: крон не должен падать из-за Telegram. Но он
 * назван — и в логе, и в возвращённом исходе.
 */

export type TgSendOutcome = { ok: true } | { ok: false; reason: string };

export async function tgSend(scope: string, text: string): Promise<TgSendOutcome> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    // Ненастроенный канал выглядел бы как отсутствие тревог. Молчание по этой
    // причине — тоже недоставка.
    const reason = 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы';
    console.error(`[${scope}] tgSend: ${reason} — тревога никуда не ушла`);
    return { ok: false, reason };
  }
  try {
    const res = await fetch(
      `${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    // HTTP 200 — единственное доказательство доставки, которое у нас есть.
    // Не читать его значит принимать 403 «bot was blocked» за успех.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const reason = `Telegram ответил ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
      console.error(`[${scope}] tgSend: ${reason}`);
      return { ok: false, reason };
    }
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[${scope}] tgSend: ${reason}`);
    return { ok: false, reason };
  }
}
