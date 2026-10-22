/**
 * «Открой даты словами» (22.10, этап C, §6–§7): предложение между сообщением
 * оператора и нажатием «Открыть» — таблица operator_chat_date_proposals
 * (миграция 1315). Здесь только база: что прочитать, как завести, как
 * захватить при нажатии. Слова человеку — texts.ts, порядок проверок — flow.ts.
 *
 * ── Нажатие «Открыть» — одна транзакция ───────────────────────────────────
 *
 *   1. строка предложения ЭТОГО партнёра и ЭТОГО чата под FOR UPDATE: чужое
 *      предложение — «не найдено в этом чате», а не чужая запись;
 *   2. статус: исполненное (done/refused) — повтор ничего не пишет и
 *      отвечает прежним итогом; заменённое, отменённое, истёкшее, черновик —
 *      свой ответ, записи нет;
 *   3. запись — той же функцией, что у кабинета (`openTourDatesTx`), в режиме
 *      чата: закрытые оператором даты и даты вне сезона не открываются
 *      (решения владельца 22.10), уже открытые не трогаются, ниже записанных
 *      места не ставятся, цена не меняется; тур — под блокировкой гейта брони;
 *   4. итог — в ту же строку `WHERE status = 'ready' AND used_at IS NULL`,
 *      ровно одна строка, иначе откат.
 * Второе нажатие (и одновременное) ждёт блокировку строки и видит `done`.
 * Отказ базы — откат целиком: предложение остаётся `ready`, ничего не
 * записано, в лог — имя проверки и SQLSTATE.
 *
 * Чего здесь нет: текста фразы и user_id из MAX — ни в строке, ни в логе.
 *
 * Повторы MAX (та же копия апдейта): фраза — `source_mid`, ответ числом мест
 * — `seats_source_mid`, нажатие «Открыть» — статус строки, выбор того же
 * тура — `tour_id` строки. Ни один повтор не пишет второй раз и не уходит
 * помощнику кабинета.
 *
 * Поправка текстом (четвёртый ревью 22.10): любой ответ потока дат на новую
 * фразу — отказ, вопрос — переводит действующее предложение чата в
 * `superseded`, «отмена», «стоп», «не надо» — в `cancelled` (`retireActive`).
 * Иначе кнопка «Открыть» под прежним предложением писала бы и после того, как
 * оператор поправился словами.
 *
 * Та же фраза ещё раз при действующем таком же предложении — то же
 * предложение, и срок его продлевается: текст снова говорит «действует 30
 * минут», и это правда.
 *
 * Сторож: tests/integration/chat-open-dates.pg.test.ts.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { scrubErrorText } from '@/lib/client-errors/scrub';
import {
  type OpenDatesInput, type PreviewDatesOutcome, openTourDatesTx, previewTourDates,
} from '@/lib/tours/availability-open';
import type { ChatTour } from './parse';
import { PROPOSAL_TTL_MIN, type StoredOutcome, readStoredOutcome } from './texts';

const CHANNEL = 'max';

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}
/** Отказ — в лог: имя проверки и SQLSTATE; текст ошибки — вычищенный (телефоны, почты, ключи). */
function logFail(check: string, err: unknown): void {
  console.error(`[chat-dates] ${check} — отказ базы, SQLSTATE ${sqlstate(err)}`,
    scrubErrorText(err instanceof Error ? err.message : String(err), 200));
}

/** Настройки записи из чата — одни на превью и на нажатие (решения владельца 22.10). */
export function chatOpenInput(partnerId: string, tourId: string, dates: string[], seats: number, today: string): OpenDatesInput {
  return {
    operatorId: partnerId,
    tourId,
    rows: dates.map((date) => ({ date, slots: seats })),
    // Право чата — даты и места, цена — нет ни при каких правах.
    mayPrice: false,
    inactiveTour: 'refuse',
    skipExisting: true,
    // Закрытое оператором («Шторм») открывает только он, в кабинете.
    closedDates: 'keep',
    today,
    enforceSeason: true,
  };
}

// ── Чтение ────────────────────────────────────────────────────────────────

/**
 * Туры партнёра для выбора: не удалённые; скрытые читаются со своим флагом —
 * фраза, назвавшая скрытый тур, получает «тур скрыт», а не «не нашёл».
 * Это кабинет оператора (свои туры), не витрина. null — не прочитались.
 */
export async function readPartnerTours(partnerId: string): Promise<ChatTour[] | null> {
  try {
    const { rows } = await pool.query<ChatTour>(
      `SELECT id::text AS id, title, COALESCE(is_active, FALSE) AS active
         FROM operator_tours
        WHERE operator_id = $1::uuid AND deleted_at IS NULL
        ORDER BY title, id
        LIMIT 200`,
      [partnerId],
    );
    return rows;
  } catch (err) {
    logFail('туры партнёра для чата', err);
    return null;
  }
}

/** Автоподтверждение броней у оператора: true / false / null — не смог проверить. */
export async function readAutoConfirm(partnerId: string): Promise<boolean | null> {
  try {
    const { rows } = await pool.query<{ on: boolean }>(
      `SELECT COALESCE(os.auto_confirm_bookings, FALSE) AS on
         FROM partners p
         LEFT JOIN operator_settings os ON os.user_id = p.user_id
        WHERE p.id = $1::uuid`,
      [partnerId],
    );
    return rows[0] ? rows[0].on === true : null;
  } catch (err) {
    logFail('автоподтверждение оператора', err);
    return null;
  }
}

/** Превью дат: null — не прочиталось (в лог), и предложение говорит «не смог проверить». */
export async function previewDates(input: OpenDatesInput): Promise<PreviewDatesOutcome | null> {
  try {
    return await previewTourDates(pool, input);
  } catch (err) {
    logFail('превью дат для чата', err);
    return null;
  }
}

// ── Заведение ─────────────────────────────────────────────────────────────

export interface NewProposal {
  partnerId: string;
  chatId: number;
  sourceMid: string | null;
  tourId: string | null;
  candidateIds: string[] | null;
  dates: string[];
  seats: number | null;
  priceMentioned: boolean;
  weekdayWords: boolean;
  /** Правило фразы словами («будни июля 2027»); null — перечень дат. */
  rule: string | null;
  /** Время сообщения по часам MAX (мс); null — не пришло. */
  sentAtMs: number | null;
}

/**
 * Строка старше сообщения — её можно снять или заменить. Повтор старого
 * сообщения (MAX шлёт апдейт ещё раз) не трогает предложение, заведённое
 * позже него (шестой ревью). Параметр — время сообщения в мс или NULL.
 */
const OLDER_THAN = (n: number): string =>
  `($${n}::double precision IS NULL OR source_sent_at IS NULL OR source_sent_at < to_timestamp($${n}::double precision / 1000))`;

export type CreateResult =
  | { kind: 'created'; id: string }
  /** Повтор того же сообщения MAX: ничего не шлём второй раз. */
  | { kind: 'duplicate_mid' }
  /** Действующее предложение с тем же туром, местами и датами — шлём его же. */
  | { kind: 'same_active'; id: string }
  /** В чате действует предложение новее этого сообщения: старое его не заменяет. */
  | { kind: 'stale' }
  | { kind: 'failed' };

const ACTIVE_COLS = `id::text AS id`;

/**
 * Завести предложение одной транзакцией (§6): повтор сообщения — ничего;
 * то же самое уже ждёт — оно же; иначе прежние draft/ready чата заменяются,
 * новое вставляется. Две копии одного апдейта упираются в уникальный индекс:
 * вставка без цели конфликта молчит (`ON CONFLICT DO NOTHING`), и вторая копия
 * видит первую по `source_mid`.
 */
export async function createProposal(p: NewProposal): Promise<CreateResult> {
  const status = p.tourId !== null && p.seats !== null ? 'ready' : 'draft';
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const dupe = async (): Promise<boolean> => {
      if (p.sourceMid === null) return false;
      const r = await client!.query(
        `SELECT 1 FROM operator_chat_date_proposals
          WHERE channel = $1 AND chat_id = $2::bigint AND source_mid = $3`,
        [CHANNEL, String(p.chatId), p.sourceMid],
      );
      return (r.rowCount ?? 0) > 0;
    };
    if (await dupe()) {
      await client.query('ROLLBACK');
      return { kind: 'duplicate_mid' };
    }
    const newer = await client.query(
      `SELECT 1 FROM operator_chat_date_proposals
        WHERE channel = $1 AND chat_id = $2::bigint AND status IN ('draft', 'ready') AND NOT ${OLDER_THAN(3)}`,
      [CHANNEL, String(p.chatId), p.sentAtMs],
    );
    if ((newer.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return { kind: 'stale' };
    }
    const same = await client.query<{ id: string }>(
      `SELECT ${ACTIVE_COLS} FROM operator_chat_date_proposals
        WHERE channel = $1 AND chat_id = $2::bigint AND partner_id = $3::uuid
          AND status IN ('draft', 'ready') AND expires_at > NOW()
          AND tour_id IS NOT DISTINCT FROM $4::bigint
          AND candidate_tour_ids IS NOT DISTINCT FROM $5::bigint[]
          AND seats IS NOT DISTINCT FROM $6::int
          AND dates = $7::date[]
        FOR UPDATE`,
      [CHANNEL, String(p.chatId), p.partnerId, p.tourId, p.candidateIds, p.seats, p.dates],
    );
    if (same.rows[0]) {
      // Копия того же сообщения, закоммиченная между первой проверкой и этой,
      // — повтор, а не «то же самое ещё раз»: второе сообщение не шлётся.
      const repeated = await dupe();
      if (!repeated) {
        // Та же фраза ещё раз — то же предложение, показанное заново: срок
        // продлевается, иначе «действует 30 минут» в новом тексте было бы неправдой.
        await client.query(
          `UPDATE operator_chat_date_proposals SET expires_at = NOW() + make_interval(mins => $2::int) WHERE id = $1::uuid`,
          [same.rows[0].id, PROPOSAL_TTL_MIN],
        );
      }
      await client.query('COMMIT');
      return repeated ? { kind: 'duplicate_mid' } : { kind: 'same_active', id: same.rows[0].id };
    }
    // Две попытки: вставка может упереться в действующее предложение другой
    // копии, закоммиченное между нашей заменой и вставкой; вторая замена его
    // уже видит (READ COMMITTED — новый снимок на каждое выражение).
    for (let attempt = 0; attempt < 2; attempt++) {
      await client.query(
        `UPDATE operator_chat_date_proposals SET status = 'superseded'
          WHERE channel = $1 AND chat_id = $2::bigint AND status IN ('draft', 'ready')`,
        [CHANNEL, String(p.chatId)],
      );
      const ins = await client.query<{ id: string }>(
        `INSERT INTO operator_chat_date_proposals
           (partner_id, channel, chat_id, source_mid, tour_id, candidate_tour_ids, dates, seats,
            price_mentioned, weekday_words, status, expires_at, rule_words, source_sent_at)
         VALUES ($1::uuid, $2, $3::bigint, $4, $5::bigint, $6::bigint[], $7::date[], $8::int,
                 $9::boolean, $10::boolean, $11, NOW() + make_interval(mins => $12::int), $13::text,
                 to_timestamp($14::double precision / 1000))
         ON CONFLICT DO NOTHING
         RETURNING id::text AS id`,
        [p.partnerId, CHANNEL, String(p.chatId), p.sourceMid, p.tourId, p.candidateIds, p.dates, p.seats,
          p.priceMentioned, p.weekdayWords, status, PROPOSAL_TTL_MIN, p.rule, p.sentAtMs],
      );
      if (ins.rows[0]) {
        await client.query('COMMIT');
        return { kind: 'created', id: ins.rows[0].id };
      }
      if (await dupe()) {
        await client.query('ROLLBACK');
        return { kind: 'duplicate_mid' };
      }
    }
    throw new Error('предложение не вставилось дважды: действующее в чате держит другая копия');
  } catch (err) {
    logFail('заведение предложения', err);
    await rollback(client);
    client = null;
    return { kind: 'failed' };
  } finally {
    client?.release();
  }
}

async function rollback(client: PoolClient | null): Promise<void> {
  if (!client) return;
  try {
    await client.query('ROLLBACK');
    client.release();
  } catch (err) {
    // Откат не прошёл — соединение не возвращается в пул как годное.
    logFail('откат транзакции предложения', err);
    client.release(err instanceof Error ? err : true);
  }
}

// ── Черновик: ответ числом мест ───────────────────────────────────────────

export interface ProposalState {
  id: string;
  tourId: string | null;
  candidateIds: string[];
  dates: string[];
  seats: number | null;
  priceMentioned: boolean;
  weekdayWords: boolean;
  rule: string | null;
  status: string;
}

interface StateRow {
  id: string;
  tour_id: string | null;
  candidate_tour_ids: string[] | null;
  dates: string[];
  seats: number | null;
  price_mentioned: boolean;
  weekday_words: boolean;
  rule_words: string | null;
  status: string;
  outcome: unknown;
  used_at: Date | null;
  expired: boolean;
}
const STATE_COLS = `id::text AS id, tour_id::text AS tour_id, candidate_tour_ids::text[] AS candidate_tour_ids,
  dates::text[] AS dates, seats, price_mentioned, weekday_words, rule_words, status, outcome, used_at,
  (expires_at <= NOW()) AS expired`;

function stateOf(r: StateRow): ProposalState {
  return {
    id: r.id, tourId: r.tour_id, candidateIds: r.candidate_tour_ids ?? [], dates: r.dates, seats: r.seats,
    priceMentioned: r.price_mentioned, weekdayWords: r.weekday_words, rule: r.rule_words, status: r.status,
  };
}

export type SeatsFill =
  | { kind: 'none' }
  | { kind: 'filled'; state: ProposalState }
  /** Это сообщение (mid) уже заполнило места: повтор апдейта MAX, ничего не шлём. */
  | { kind: 'duplicate_mid' }
  | { kind: 'failed' };

/**
 * Число мест к черновику этого чата, который ждёт мест, — только когда тур
 * уже выбран: о местах спрашивают после тура. Пока тур выбирается, голое
 * число — это номер тура, написанный вместо кнопки, а не места (ревью 22.10:
 * «2» в ответ на «1. Вулкан Горелый / 2. Летняя рыбалка» записывалось двумя
 * местами, о которых никто не спрашивал). Черновика нет — `none`: число
 * уходит помощнику, как раньше. Число вне 1…500 сюда не доходит — его
 * отклоняет вызывающий.
 */
export async function fillDraftSeats(
  partnerId: string, chatId: number, seats: number, sourceMid: string | null, sentAtMs: number | null = null,
): Promise<SeatsFill> {
  try {
    const { rows } = await pool.query<StateRow>(
      `UPDATE operator_chat_date_proposals
          SET seats = $3::int,
              status = 'ready',
              expires_at = NOW() + make_interval(mins => $4::int),
              seats_source_mid = $5::text
        WHERE channel = 'max' AND chat_id = $1::bigint AND partner_id = $2::uuid
          AND status = 'draft' AND tour_id IS NOT NULL AND seats IS NULL AND expires_at > NOW()
          AND ${OLDER_THAN(6)}
          -- Запоздалая копия уже засчитанного ответа не заполняет НОВЫЙ черновик:
          -- старое «8» — ответ на прежний вопрос, а не на этот.
          AND NOT EXISTS (
            SELECT 1 FROM operator_chat_date_proposals o
             WHERE o.channel = 'max' AND o.chat_id = $1::bigint AND o.seats_source_mid = $5::text
          )
        RETURNING ${STATE_COLS}`,
      [String(chatId), partnerId, seats, PROPOSAL_TTL_MIN, sourceMid, sentAtMs],
    );
    if (rows[0]) return { kind: 'filled', state: stateOf(rows[0]) };
    // Черновика, ждущего мест, нет. Если это сообщение уже заполнило места
    // (вторая копия апдейта ждала блокировку строки и увидела ready), — повтор.
    // Проверка ПОСЛЕ UPDATE: до него первая копия могла быть ещё не закоммичена.
    if (sourceMid !== null) {
      const dup = await pool.query(
        `SELECT 1 FROM operator_chat_date_proposals
          WHERE channel = 'max' AND chat_id = $1::bigint AND partner_id = $2::uuid AND seats_source_mid = $3::text`,
        [String(chatId), partnerId, sourceMid],
      );
      if ((dup.rowCount ?? 0) > 0) return { kind: 'duplicate_mid' };
    }
    return { kind: 'none' };
  } catch (err) {
    logFail('места к черновику предложения', err);
    return { kind: 'failed' };
  }
}

/**
 * Поправка текстом (шапка): действующее предложение чата (draft, ready) — в
 * `superseded` или, по «отмена», в `cancelled`. Число снятых строк; null —
 * не смог (в лог), и вызывающий говорит, что прежняя кнопка ещё жива. Чат —
 * весь, как у замены в `createProposal`: действующее предложение у чата одно.
 */
export async function retireActive(
  chatId: number, status: 'superseded' | 'cancelled', sentAtMs: number | null = null,
): Promise<number | null> {
  try {
    const upd = await pool.query(
      `UPDATE operator_chat_date_proposals SET status = $2
        WHERE channel = $3 AND chat_id = $1::bigint AND status IN ('draft', 'ready') AND ${OLDER_THAN(4)}`,
      [String(chatId), status, CHANNEL, sentAtMs],
    );
    return upd.rowCount ?? 0;
  } catch (err) {
    logFail('снятие предложения поправкой', err);
    return null;
  }
}

/**
 * Чего ждёт действующий черновик этого чата: `tour` — выбора тура кнопкой,
 * `seats` — числа мест, `none` — черновика нет; null — не смог прочитать.
 * Без записи.
 */
export async function draftWaiting(partnerId: string, chatId: number): Promise<'tour' | 'seats' | 'none' | null> {
  try {
    const { rows } = await pool.query<{ waits: 'tour' | 'seats' | 'none' }>(
      `SELECT CASE WHEN tour_id IS NULL THEN 'tour' WHEN seats IS NULL THEN 'seats' ELSE 'none' END AS waits
         FROM operator_chat_date_proposals
        WHERE channel = 'max' AND chat_id = $1::bigint AND partner_id = $2::uuid
          AND status = 'draft' AND expires_at > NOW()
        LIMIT 1`,
      [String(chatId), partnerId],
    );
    return rows[0]?.waits ?? 'none';
  } catch (err) {
    logFail('черновик предложения: чего ждёт', err);
    return null;
  }
}

// ── Нажатия ───────────────────────────────────────────────────────────────

/** Почему нажатие не исполняется — по статусу строки. */
export type PressBlocked =
  | { kind: 'not_found' }
  | { kind: 'done_before'; usedAt: Date | null; outcome: StoredOutcome | null }
  | { kind: 'superseded' }
  | { kind: 'cancelled' }
  | { kind: 'expired' }
  | { kind: 'failed' };

function blockedBy(r: StateRow | undefined): PressBlocked | null {
  if (!r) return { kind: 'not_found' };
  if (r.status === 'done' || r.status === 'refused') {
    return { kind: 'done_before', usedAt: r.used_at, outcome: readStoredOutcome(r.outcome) };
  }
  if (r.status === 'superseded') return { kind: 'superseded' };
  if (r.status === 'cancelled') return { kind: 'cancelled' };
  if (r.expired) return { kind: 'expired' };
  return null;
}

const LOCK_ROW = `SELECT ${STATE_COLS} FROM operator_chat_date_proposals
  WHERE id = $1::uuid AND channel = 'max' AND chat_id = $2::bigint AND partner_id = $3::uuid
  FOR UPDATE`;

export type OpenPress =
  | PressBlocked
  | { kind: 'need_tour' }
  | { kind: 'need_seats' }
  | { kind: 'done'; outcome: StoredOutcome };

/** Нажатие «Открыть» (см. шапку). */
export async function pressOpen(partnerId: string, chatId: number, proposalId: string, today: string): Promise<OpenPress> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query<StateRow>(LOCK_ROW, [proposalId, String(chatId), partnerId]);
    const row = rows[0];
    const blocked = blockedBy(row);
    if (blocked || !row) {
      await client.query('ROLLBACK');
      return blocked ?? { kind: 'not_found' };
    }
    if (row.status === 'draft') {
      await client.query('ROLLBACK');
      return row.tour_id === null ? { kind: 'need_tour' } : { kind: 'need_seats' };
    }
    if (row.status !== 'ready' || row.tour_id === null || row.seats === null) {
      throw new Error(`предложение в состоянии ${row.status} без тура или мест`);
    }

    const out = await openTourDatesTx(client, chatOpenInput(partnerId, row.tour_id, row.dates, row.seats, today));
    const outcome: StoredOutcome = out.ok
      ? { kind: 'done', tourTitle: out.tour.title, seats: row.seats, written: out.written, perDate: out.perDate }
      : out.reason === 'tour_inactive'
        ? { kind: 'refused', reason: 'tour_inactive', title: out.title }
        : { kind: 'refused', reason: 'tour_not_found' };
    const upd = await client.query(
      `UPDATE operator_chat_date_proposals
          SET status = $2, outcome = $3::jsonb, used_at = NOW()
        WHERE id = $1::uuid AND status = 'ready' AND used_at IS NULL`,
      [proposalId, out.ok ? 'done' : 'refused', JSON.stringify(outcome)],
    );
    if (upd.rowCount !== 1) throw new Error(`итог предложения записан в ${upd.rowCount ?? 0} строк вместо одной`);
    await client.query('COMMIT');
    return { kind: 'done', outcome };
  } catch (err) {
    logFail('нажатие «Открыть»', err);
    await rollback(client);
    client = null;
    return { kind: 'failed' };
  } finally {
    client?.release();
  }
}

export type CancelPress = PressBlocked | { kind: 'cancelled_now' };

/** «Не надо»: draft/ready этого партнёра и чата — в cancelled. */
export async function pressCancel(partnerId: string, chatId: number, proposalId: string): Promise<CancelPress> {
  try {
    const upd = await pool.query(
      `UPDATE operator_chat_date_proposals SET status = 'cancelled'
        WHERE id = $1::uuid AND channel = 'max' AND chat_id = $2::bigint AND partner_id = $3::uuid
          AND status IN ('draft', 'ready')`,
      [proposalId, String(chatId), partnerId],
    );
    if (upd.rowCount === 1) return { kind: 'cancelled_now' };
    const { rows } = await pool.query<StateRow>(
      `SELECT ${STATE_COLS} FROM operator_chat_date_proposals
        WHERE id = $1::uuid AND channel = 'max' AND chat_id = $2::bigint AND partner_id = $3::uuid`,
      [proposalId, String(chatId), partnerId],
    );
    return blockedBy(rows[0]) ?? { kind: 'not_found' };
  } catch (err) {
    logFail('нажатие «Не надо»', err);
    return { kind: 'failed' };
  }
}

export type TourPress = PressBlocked | { kind: 'stale_button' } | { kind: 'chosen'; state: ProposalState };

/**
 * Выбор тура кнопкой: индекс в candidate_tour_ids, а не id тура в payload.
 * Индекс за концом массива — «кнопка устарела», а не NULL в tour_id (строка
 * ready без тура нарушила бы ocdp_ready_complete и ответила бы «база не
 * ответила»).
 *
 * Тот же тур ещё раз (двойное касание, повтор callback от MAX) — `chosen` с
 * нынешним состоянием и без UPDATE: срок не продлевается, строка не
 * меняется, оператор видит своё предложение, а не «кнопка устарела» (второй
 * ревью 22.10). Другой тур после выбора — «кнопка устарела»: предложение с
 * кнопкой «Открыть» уже показано с прежним туром, и подменить тур под ним
 * значило бы открыть не то, что человек видел.
 */
export async function pressTour(partnerId: string, chatId: number, proposalId: string, index: number): Promise<TourPress> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query<StateRow>(LOCK_ROW, [proposalId, String(chatId), partnerId]);
    const row = rows[0];
    const blocked = blockedBy(row);
    if (blocked || !row) {
      await client.query('ROLLBACK');
      return blocked ?? { kind: 'not_found' };
    }
    if (row.tour_id !== null) {
      // Не заблокирована — значит draft или ready, тур уже выбран.
      await client.query('ROLLBACK');
      return row.candidate_tour_ids?.[index] === row.tour_id ? { kind: 'chosen', state: stateOf(row) } : { kind: 'stale_button' };
    }
    if (row.status !== 'draft') {
      await client.query('ROLLBACK');
      return { kind: 'stale_button' };
    }
    const upd = await client.query<StateRow>(
      `UPDATE operator_chat_date_proposals
          SET tour_id = candidate_tour_ids[$2::int + 1],
              status = CASE WHEN seats IS NULL THEN 'draft' ELSE 'ready' END,
              expires_at = NOW() + make_interval(mins => $3::int)
        WHERE id = $1::uuid AND status = 'draft' AND tour_id IS NULL
          AND $2::int >= 0 AND $2::int < COALESCE(cardinality(candidate_tour_ids), 0)
        RETURNING ${STATE_COLS}`,
      [proposalId, index, PROPOSAL_TTL_MIN],
    );
    await client.query('COMMIT');
    return upd.rows[0] ? { kind: 'chosen', state: stateOf(upd.rows[0]) } : { kind: 'stale_button' };
  } catch (err) {
    logFail('выбор тура кнопкой', err);
    await rollback(client);
    client = null;
    return { kind: 'failed' };
  } finally {
    client?.release();
  }
}
