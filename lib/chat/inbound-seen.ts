/**
 * lib/chat/inbound-seen.ts — входящий апдейт Telegram и MAX: повтор, отметка
 * «обработано» и подхват недоделанного после перезапуска.
 *
 * Задача #3433 п. 1 (слово владельца 16.11 «Оба шага»).
 *
 * Шаг 1 (миграция 1448). Память процесса (lib/telegram/update-dedup,
 * lib/max/update-dedup) пустеет при перезапуске, а Telegram и MAX повторяют
 * апдейт, на который не дождались ответа, — как раз когда процесс упал. Первая
 * доставка ключа записывается в chat_inbound_seen, и повтор узнаётся и после
 * перезапуска.
 *
 * Шаг 2 (миграция 1449). Повтор повтору рознь: если прежний запуск взял апдейт
 * и умер, не закончив, его повтор — не дубль, а единственный шанс ответить.
 * Поэтому у строки есть запуск (boot_id), отметка «обработано» и число
 * подхватов. Апдейт, который взял ДРУГОЙ запуск и не закончил за 15 минут,
 * подхватывается один раз — так MAX, повторивший апдейт после падения,
 * получает ответ. Telegram сам не повторяет (ему 200 отвечается до
 * обработки), поэтому его сообщение лежит в строке до отметки, и новый запуск
 * подбирает его сам (claimStaleTelegram, вызов — GET вебхука при старте).
 *
 * Порядок: сначала память процесса, затем база. Три исхода у базы (§4.0):
 * «новый», «повтор», «не смог» — при последнем решает память процесса, как до
 * этой правки, и отказ уходит в лог (ключ апдейта ПД не содержит, текст
 * сообщения в лог не пишется). Ответ базы не ждётся дольше двух секунд.
 *
 * ПД: сообщение Telegram (payload) лежит, пока идёт обработка, — отметка
 * «обработано» его стирает, а не подобранное стирается через 15 минут.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '@/lib/db-pool';

export type InboundSource = 'telegram' | 'max_message' | 'max_callback';
export type InboundVerdict = 'new' | 'repeat';
export type InboundDbVerdict = InboundVerdict | 'unknown';

const DB_WAIT_MS = 2000;
const CLEANUP_EVERY = 100;
/** Сколько ждёт недоделанный апдейт, прежде чем считаться потерянным, — и сколько живёт сообщение в строке. */
export const INBOUND_STALE_MINUTES = 15;
let writes = 0;

/**
 * Запуск процесса. В globalThis, а не в переменной модуля: Next собирает роуты
 * отдельными бандлами, и у Telegram и MAX была бы своя копия модуля — два
 * «запуска» в одном процессе.
 */
export function inboundBootId(): string {
  const g = globalThis as { __vedarInboundBootId?: string };
  g.__vedarInboundBootId ??= randomUUID();
  return g.__vedarInboundBootId;
}

async function withDeadline<T>(query: Promise<T>, step: string): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), DB_WAIT_MS); });
  try {
    const res = await Promise.race([query, timeout]);
    if (res === 'timeout') {
      // Запрос мог дойти позже — его ошибка не должна стать необработанной.
      query.catch((err: unknown) => logInboundFailure(`${step} после срока`, err));
      logInboundFailure(`${step}: база не ответила за 2 с`, null);
    }
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SeenRow {
  hits: unknown;
  boot_id: unknown;
  processed: unknown;
  attempts: unknown;
  fresh: unknown;
}

/**
 * Записать доставку ключа. Первая доставка — «новый». Повтор апдейта, который
 * взял другой запуск, не закончил и не старше 15 минут, подхватывается один раз
 * — тоже «новый». Остальное — «повтор». Ответ не той формы, ошибка, молчание —
 * «не смог».
 *
 * payload — сообщение, которое новый запуск сможет подобрать сам (только
 * Telegram: MAX повторяет апдейт сам).
 */
export async function recordInboundInDb(
  source: InboundSource,
  key: string,
  opts: { payload?: unknown } = {},
): Promise<InboundDbVerdict> {
  if (!key || key.length > 200) return 'unknown';
  const boot = inboundBootId();
  try {
    // DO UPDATE меняет только hits: остальные поля в RETURNING — прежние,
    // по ним и решается, недоделан ли апдейт чужим запуском.
    const res = await withDeadline(pool.query<SeenRow>(
      `INSERT INTO chat_inbound_seen (source, update_key, boot_id, payload) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (source, update_key) DO UPDATE SET hits = chat_inbound_seen.hits + 1
       RETURNING hits, boot_id, processed_at IS NOT NULL AS processed, attempts,
                 received_at > now() - make_interval(mins => $5) AS fresh`,
      [source, key, boot, opts.payload === undefined ? null : JSON.stringify(opts.payload), INBOUND_STALE_MINUTES],
    ), 'запись');
    if (res === 'timeout') return 'unknown';
    const row = Array.isArray(res?.rows) && res.rows.length === 1 ? res.rows[0] : null;
    const hits = Number(row?.hits);
    if (!row || !Number.isInteger(hits) || hits < 1) return 'unknown';
    countWrite();
    if (hits === 1) return 'new';
    const abandoned = row.processed === false && row.boot_id !== boot && Number(row.attempts) < 1 && row.fresh === true;
    if (!abandoned) return 'repeat';
    return await takeOver(source, key, boot);
  } catch (err) {
    logInboundFailure('запись', err);
    return 'unknown';
  }
}

/** Взять недоделанный чужим запуском апдейт. Условие повторено в WHERE: два повтора не возьмут его оба. */
async function takeOver(source: InboundSource, key: string, boot: string): Promise<InboundDbVerdict> {
  const res = await withDeadline(pool.query(
    `UPDATE chat_inbound_seen SET boot_id = $3, attempts = attempts + 1
     WHERE source = $1 AND update_key = $2 AND processed_at IS NULL
       AND boot_id IS DISTINCT FROM $3 AND attempts < 1
       AND received_at > now() - make_interval(mins => $4)
     RETURNING 1 AS taken`,
    [source, key, boot, INBOUND_STALE_MINUTES],
  ), 'подхват');
  if (res === 'timeout' || !Array.isArray(res?.rows)) return 'unknown';
  if (res.rows.length === 1) {
    console.error(`[chat/inbound-seen] ${source}: апдейт, брошенный прежним запуском, подхвачен`);
    return 'new';
  }
  return 'repeat';
}

/**
 * Повтор ли апдейт. memoryRepeat — проверка памяти процесса (она же отмечает
 * ключ виденным); база спрашивается, только если память его не видела.
 * «new» — апдейт взят этим запуском: по окончании обработки — markInboundDone.
 */
export async function admitInbound(
  source: InboundSource,
  key: string,
  memoryRepeat: () => boolean,
  opts: { payload?: unknown } = {},
): Promise<InboundDbVerdict> {
  if (memoryRepeat()) return 'repeat';
  return recordInboundInDb(source, key, opts);
}

export async function isRepeatedInbound(
  source: InboundSource,
  key: string,
  memoryRepeat: () => boolean,
): Promise<boolean> {
  return (await admitInbound(source, key, memoryRepeat)) === 'repeat';
}

/**
 * Обработка закончилась — успехом или ошибкой: заново не исполняется то, что
 * могло исполниться наполовину. Сообщение из строки стирается. Отметка — только
 * своей строки (взятой этим запуском).
 */
export async function markInboundDone(source: InboundSource, key: string): Promise<void> {
  if (!key || key.length > 200) return;
  try {
    await withDeadline(pool.query(
      `UPDATE chat_inbound_seen SET processed_at = now(), payload = NULL
       WHERE source = $1 AND update_key = $2 AND boot_id = $3 AND processed_at IS NULL`,
      [source, key, inboundBootId()],
    ), 'отметка');
  } catch (err) {
    logInboundFailure('отметка', err);
  }
}

export type StaleClaim =
  | { ok: true; items: Array<{ key: string; payload: unknown }> }
  | { ok: false };

/**
 * Взять сообщения Telegram, брошенные прежним запуском: не обработаны, не
 * старше 15 минут, ещё не подхватывались. Берутся один раз (attempts), и два
 * подборщика не возьмут одно (SKIP LOCKED).
 */
export async function claimStaleTelegram(limit = 20): Promise<StaleClaim> {
  try {
    // Сначала стереть то, что подбирать уже поздно: тихий бот мог не набрать
    // сотни записей, на которой стирает countWrite.
    await withDeadline(pool.query(
      `UPDATE chat_inbound_seen SET payload = NULL
       WHERE payload IS NOT NULL AND received_at < now() - make_interval(mins => $1)`,
      [INBOUND_STALE_MINUTES],
    ), 'стирание сообщений');
    const res = await withDeadline(pool.query<{ update_key: string; payload: unknown }>(
      `UPDATE chat_inbound_seen c SET boot_id = $1, attempts = c.attempts + 1
       WHERE (c.source, c.update_key) IN (
         SELECT source, update_key FROM chat_inbound_seen
         WHERE source = 'telegram' AND processed_at IS NULL AND payload IS NOT NULL
           AND boot_id IS DISTINCT FROM $1 AND attempts < 1
           AND received_at > now() - make_interval(mins => $3)
         ORDER BY received_at LIMIT $2
         FOR UPDATE SKIP LOCKED)
       RETURNING c.update_key, c.payload`,
      [inboundBootId(), limit, INBOUND_STALE_MINUTES],
    ), 'подбор');
    if (res === 'timeout' || !Array.isArray(res?.rows)) return { ok: false };
    return { ok: true, items: res.rows.map((r) => ({ key: String(r.update_key), payload: r.payload })) };
  } catch (err) {
    logInboundFailure('подбор', err);
    return { ok: false };
  }
}

function countWrite(): void {
  writes += 1;
  if (writes % CLEANUP_EVERY !== 0) return;
  pool.query(`DELETE FROM chat_inbound_seen WHERE received_at < now() - interval '1 day'`)
    .catch((err: unknown) => logInboundFailure('очистка', err));
  // Сообщение, которое никто не подобрал за 15 минут, в строке не лежит.
  pool.query(
    `UPDATE chat_inbound_seen SET payload = NULL
     WHERE payload IS NOT NULL AND received_at < now() - make_interval(mins => $1)`,
    [INBOUND_STALE_MINUTES],
  ).catch((err: unknown) => logInboundFailure('стирание сообщений', err));
}

function logInboundFailure(step: string, err: unknown): void {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  const msg = err instanceof Error ? err.message : '';
  const tail = step.startsWith('запись') || step.startsWith('подхват') ? ' — повтор решает память процесса' : '';
  console.error(`[chat/inbound-seen] ${step} не удалась${code ? ` (${code})` : ''}${msg ? `: ${msg}` : ''}${tail}`);
}
