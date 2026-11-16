/**
 * lib/chat/inbound-seen.ts — повтор входящего апдейта Telegram и MAX, по базе.
 *
 * Задача #3433 п. 1 (слово владельца 16.11 «Оба шага»). Память процесса
 * (lib/telegram/update-dedup, lib/max/update-dedup) пустеет при перезапуске, а
 * Telegram и MAX повторяют апдейт, на который не дождались ответа, — как раз
 * когда процесс упал или перезапускался. Повтор давал второй ответ человеку и
 * второе касание в CRM. Теперь первая доставка ключа записывается в
 * chat_inbound_seen (миграция 1448), и повтор узнаётся и после перезапуска.
 *
 * Порядок: сначала память процесса (без похода в базу на частом повторе), затем
 * база. Три исхода у базы (§4.0): «новый», «повтор», «не смог» — при последнем
 * решает память процесса, как было до этой правки, и отказ уходит в лог (ключ
 * апдейта ПД не содержит). Ответ базы не ждётся дольше двух секунд: вебхук
 * Telegram отвечает 200 после этой проверки.
 *
 * Ключ — только номер апдейта, без текста, имени и чата. Строки старше суток
 * удаляет каждая сотая запись.
 */
import { pool } from '@/lib/db-pool';

export type InboundSource = 'telegram' | 'max_message' | 'max_callback';
export type InboundVerdict = 'new' | 'repeat';
export type InboundDbVerdict = InboundVerdict | 'unknown';

const DB_WAIT_MS = 2000;
const CLEANUP_EVERY = 100;
let writes = 0;

/** Записать доставку ключа. hits = 1 — первая доставка, больше — повтор; иначе «не смог». */
export async function recordInboundInDb(source: InboundSource, key: string): Promise<InboundDbVerdict> {
  if (!key || key.length > 200) return 'unknown';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = pool.query<{ hits: number }>(
      `INSERT INTO chat_inbound_seen (source, update_key) VALUES ($1, $2)
       ON CONFLICT (source, update_key) DO UPDATE SET hits = chat_inbound_seen.hits + 1
       RETURNING hits`,
      [source, key],
    );
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), DB_WAIT_MS); });
    const res = await Promise.race([query, timeout]);
    if (res === 'timeout') {
      // Запрос мог дойти позже — его ошибка не должна стать необработанной.
      query.catch((err: unknown) => logInboundFailure('запись после срока', err));
      logInboundFailure('база не ответила за 2 с', null);
      return 'unknown';
    }
    const hits = Array.isArray(res?.rows) && res.rows.length === 1 ? Number(res.rows[0]?.hits) : NaN;
    if (!Number.isInteger(hits) || hits < 1) return 'unknown';
    writes += 1;
    if (writes % CLEANUP_EVERY === 0) {
      pool.query(`DELETE FROM chat_inbound_seen WHERE received_at < now() - interval '1 day'`)
        .catch((err: unknown) => logInboundFailure('очистка', err));
    }
    return hits === 1 ? 'new' : 'repeat';
  } catch (err) {
    logInboundFailure('запись', err);
    return 'unknown';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Повтор ли апдейт. memoryRepeat — проверка памяти процесса (она же отмечает
 * ключ виденным); база спрашивается, только если память его не видела.
 */
export async function isRepeatedInbound(
  source: InboundSource,
  key: string,
  memoryRepeat: () => boolean,
): Promise<boolean> {
  if (memoryRepeat()) return true;
  return (await recordInboundInDb(source, key)) === 'repeat';
}

function logInboundFailure(step: string, err: unknown): void {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  const msg = err instanceof Error ? err.message : '';
  console.error(`[chat/inbound-seen] ${step} не удалась${code ? ` (${code})` : ''}${msg ? `: ${msg}` : ''} — повтор решает память процесса`);
}
