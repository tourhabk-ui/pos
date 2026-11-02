/**
 * «Занять места» (план CRM в мессенджере, PR4; решение владельца 02.11):
 * оператор вручную держит места на дату запроса мест, пока сам не освободит.
 * Не бронь и не оплата: статус запроса не меняется. Места на сайте и у
 * Кузьмича уменьшаются сразу (occupiedOnDaySql учитывает удержания), поэтому
 * и «Занять», и «Освободить» — только после «Да» (видно на витрине).
 *
 * Права: запрос мест — только свой (operator_id), повтор не двоит
 * (уникальный индекс активного удержания), больше свободного не занять.
 */

import { pool } from '@/lib/db-pool';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';
import { forgetLiveSeats, liveFreeSeats } from '@/lib/operators/live-seats';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export type HoldPress = { step: 'ask_hold' | 'hold' | 'ask_release' | 'release'; requestId: string };

/** sh:h ask hold · sh:y hold · sh:r ask release · sh:z release · sh:n «Нет». */
export function parseHoldPress(payload: string): HoldPress | 'no' | null {
  if (payload === 'sh:n') return 'no';
  const m = new RegExp(`^sh:([hyrz]):(${UUID})$`, 'i').exec(payload);
  if (!m) return null;
  const step = ({ h: 'ask_hold', y: 'hold', r: 'ask_release', z: 'release' } as const)[m[1]!.toLowerCase() as 'h' | 'y' | 'r' | 'z'];
  return { step, requestId: m[2]!.toLowerCase() };
}

export function holdButtons(requestId: string, held: boolean): Array<{ text: string; payload: string }> {
  const id = requestId.toLowerCase();
  return held
    ? [{ text: 'Освободить места', payload: signPayload(`sh:r:${id}`) }]
    : [{ text: 'Занять места', payload: signPayload(`sh:h:${id}`) }];
}

function confirmRow(step: 'y' | 'z', id: string) {
  return [[{ text: 'Да', payload: signPayload(`sh:${step}:${id}`) }, { text: 'Нет', payload: signPayload('sh:n') }]];
}

const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

interface Req { tour_id: string; d: string; participants: number; held: number | null }

async function loadOwn(partnerId: string, requestId: string): Promise<Req | null> {
  const { rows } = await pool.query<Req>(
    `SELECT r.tour_id::text, r.tour_date::text AS d, r.participants,
            (SELECT h.seats FROM tour_seat_holds h
              WHERE h.subject_kind = 'seat_request' AND h.subject_id = r.id::text AND h.released_at IS NULL) AS held
       FROM tour_seat_requests r
      WHERE r.id::text = $2 AND r.operator_id = $1::uuid`,
    [partnerId, requestId],
  );
  return rows[0] ?? null;
}

export async function holdPress(opts: {
  partnerId: string; userId: string | null; payload: string; via: 'max' | 'telegram'; dialog: boolean;
}): Promise<{ text: string; rows: Array<Array<{ text: string; payload: string }>> } | null> {
  const p = parseHoldPress(opts.payload);
  if (p === null) return null;
  if (p === 'no') return { text: 'Хорошо, места не трогал.', rows: [] };
  // Записи — только в личном диалоге: в группе нажал бы любой участник.
  if (!opts.dialog && (p.step === 'hold' || p.step === 'release')) {
    return { text: 'Места меняются только в личном чате с ботом. Ничего не записал.', rows: [] };
  }
  let req: Req | null;
  try { req = await loadOwn(opts.partnerId, p.requestId); } catch (err) {
    console.error('[seat-holds] запрос не прочитан, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return { text: 'Не удалось прочитать запрос. Места не менял.', rows: [] };
  }
  if (!req) return { text: 'Этого запроса мест среди ваших нет. Ничего не записал.', rows: [] };
  const date = req.d.slice(0, 10);
  const n = req.participants;

  if (p.step === 'ask_hold') {
    if (req.held) return { text: `Уже занято ${req.held} мест на ${fmt(date)}.`, rows: [holdButtons(p.requestId, true)] };
    return {
      text: `Занять ${n} мест на ${fmt(date)} под этот запрос? Это не бронь и не оплата: места просто не увидят другие, пока вы их не освободите.`,
      rows: confirmRow('y', p.requestId),
    };
  }
  if (p.step === 'ask_release') {
    if (!req.held) return { text: 'Удержания по этому запросу нет.', rows: [] };
    return { text: `Освободить ${req.held} мест на ${fmt(date)}? Они снова станут видны на сайте.`, rows: confirmRow('z', p.requestId) };
  }
  try {
    if (p.step === 'hold') {
      if (req.held) return { text: `Уже занято ${req.held} мест на ${fmt(date)}. Повторно не занимал.`, rows: [holdButtons(p.requestId, true)] };
      forgetLiveSeats(req.tour_id);
      const free = await liveFreeSeats(req.tour_id, date);
      if (free === 'failed') return { text: 'Не удалось прочитать свободные места. Ничего не занял.', rows: [] };
      if (free === null) return { text: `Даты ${fmt(date)} нет в календаре тура. Ничего не занял.`, rows: [] };
      if (free < n) return { text: `Свободно только ${free} на ${fmt(date)}, а нужно ${n}. Ничего не занял.`, rows: [] };
      const res = await pool.query(
        `INSERT INTO tour_seat_holds (operator_id, tour_id, hold_date, seats, subject_kind, subject_id, created_by, via)
         VALUES ($1::uuid, $2::bigint, $3::date, $4, 'seat_request', $5, $6::uuid, $7)
         ON CONFLICT DO NOTHING`,
        [opts.partnerId, req.tour_id, date, n, p.requestId, opts.userId, opts.via],
      );
      forgetLiveSeats(req.tour_id);
      if (res.rowCount === 0) return { text: 'Места по этому запросу уже заняты. Повторно не занимал.', rows: [holdButtons(p.requestId, true)] };
      return { text: `Занято ${n} мест на ${fmt(date)}. Это не бронь; держится, пока не освободите.`, rows: [holdButtons(p.requestId, true)] };
    }
    const res = await pool.query(
      `UPDATE tour_seat_holds SET released_at = now(), released_by = $3::uuid
        WHERE operator_id = $1::uuid AND subject_kind = 'seat_request' AND subject_id = $2 AND released_at IS NULL`,
      [opts.partnerId, p.requestId, opts.userId],
    );
    forgetLiveSeats(req.tour_id);
    if (res.rowCount === 0) return { text: 'Удержания уже нет. Ничего не менял.', rows: [] };
    return { text: `Места на ${fmt(date)} освобождены.`, rows: [holdButtons(p.requestId, false)] };
  } catch (err) {
    console.error('[seat-holds] запись не прошла, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return { text: 'Не удалось записать. Места не менял.', rows: [] };
  }
}
