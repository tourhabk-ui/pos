/**
 * Повтор сообщения MAX — тот же mid, доставленный второй раз.
 *
 * Вебхук MAX отвечает только после цикла модели: у помощника кабинета до
 * четырёх ходов водопада, а xAI отвечает за 13–43 с. Если MAX доставит тот же
 * апдейт повторно, вторая копия снова уходила помощнику — и в CRM ложились два
 * касания «звонок» или две задачи с двумя напоминаниями, а партнёр получал два
 * ответа (проверка CRM и каналов 25.10). Поток дат защищён по mid своей
 * колонкой (seats_source_mid), путь кабинета — ничем. Telegram держит такой же
 * список по update_id (lib/telegram/update-dedup.ts).
 *
 * Заверенный и незаверенный апдейты помнятся раздельно: незаверенный запрос с
 * чужим mid не должен отсечь настоящее сообщение, пришедшее после него.
 *
 * Это первая ступень: память процесса пустеет при перезапуске, поэтому вебхук
 * спрашивает и базу (lib/chat/inbound-seen, #3433) — повтор после перезапуска
 * тоже узнаётся. База не ответила — решает эта память, как раньше.
 */

const TTL_MS = 15 * 60 * 1000;
const MAX_SEEN = 2000;
const seen = new Map<string, number>();

/** true — это сообщение (mid) уже обрабатывалось в последние 15 минут. */
export function isRepeatedMaxMessage(mid: string, verified: boolean, now: number = Date.now()): boolean {
  return seenBefore(`${verified ? 'v' : 'u'}:${mid}`, now);
}

/**
 * true — это нажатие (callback_id заверенного апдейта) уже исполнялось в
 * последние 15 минут (#3433: до этого нажатия не отсекались вовсе).
 */
export function isRepeatedMaxCallback(callbackId: string, now: number = Date.now()): boolean {
  return seenBefore(`c:${callbackId}`, now);
}

function seenBefore(key: string, now: number): boolean {
  // Порядок вставки совпадает с порядком времени: старые — в начале.
  for (const [k, at] of seen) {
    if (now - at <= TTL_MS) break;
    seen.delete(k);
  }
  if (seen.has(key)) return true;
  seen.set(key, now);
  if (seen.size > MAX_SEEN) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

/** Для тестов: забыть все виденные сообщения. */
export function clearMaxMessageDedup(): void {
  seen.clear();
}
