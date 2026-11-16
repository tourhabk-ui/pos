/**
 * Повтор апдейта Telegram — тот же update_id, доставленный второй раз.
 *
 * Bot API повторяет апдейт, если вебхук ответил не вовремя. С переводом живого
 * входа на общий мозг (TG-BRAIN, 15.10) ответ туристу идёт циклом инструментов
 * — до потолка 60 с и запасной водопад, — и повтор дал бы второй ответ и вторую
 * запись истории.
 *
 * Это первая ступень: память процесса пустеет при перезапуске, поэтому вебхук
 * спрашивает и базу (lib/chat/inbound-seen, #3433) — повтор после перезапуска
 * тоже узнаётся. База не ответила — решает эта память, как раньше.
 */

const TTL_MS = 15 * 60 * 1000;
const MAX_SEEN = 2000;
const seen = new Map<number, number>();

/** true — этот update_id уже обрабатывался в последние 15 минут. */
export function isRepeatedTelegramUpdate(updateId: number, now: number = Date.now()): boolean {
  // Порядок вставки совпадает с порядком времени: старые — в начале.
  for (const [id, at] of seen) {
    if (now - at <= TTL_MS) break;
    seen.delete(id);
  }
  if (seen.has(updateId)) return true;
  seen.set(updateId, now);
  if (seen.size > MAX_SEEN) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

/** Для тестов: забыть все виденные апдейты (как после перезапуска процесса). */
export function clearTelegramUpdateDedup(): void {
  seen.clear();
}
