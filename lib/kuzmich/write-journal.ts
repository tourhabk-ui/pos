/**
 * Журнал пишущих шагов Кузьмича (аудит agents-arch, разрыв №4): заявки из
 * веб-чата, MAX и Telegram (create_booking_request / create_lead /
 * create_trip_request с частями). Строка phase='started' пишется ДО вызова
 * исполнителя, phase='finished' — после: прерванный шаг (деплой, падение)
 * виден как started без finished. Личных данных нет — только id.
 *
 * Идемпотентность: ключ = sha256(канал, сессия, инструмент, аргументы, сутки
 * UTC). Если по ключу уже есть created — исполнитель не вызывается, человеку
 * уходит прежний номер. Если есть started без finished моложе 15 минут —
 * шаг в полёте: бросаем WriteInFlightError, вызывающий отвечает «не могу
 * подтвердить», а не создаёт дубль. Сбой самой записи журнала заявку не
 * блокирует (fail-open), но предупреждение пишется в лог.
 */
import { createHash } from 'crypto';
import { pool } from '@/lib/db-pool';
import { requestOutcome } from '@/lib/agent/request-outcome';

export type WriteChannel = 'web' | 'max' | 'tg';
export type WriteOutcome = 'created' | 'refused' | 'unknown';
export type ToolOut = { kind: string; text?: string } | null;

export class WriteInFlightError extends Error {
  constructor() { super('kuzmich write in flight'); this.name = 'WriteInFlightError'; }
}

const IN_FLIGHT_MS = 15 * 60_000;

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function writeIdempotencyKey(channel: WriteChannel, sessionRef: string, tool: string, args: Record<string, unknown>, now = new Date()): string {
  return createHash('sha256').update(`${channel}|${sessionRef}|${tool}|${stable(args)}|${now.toISOString().slice(0, 10)}`).digest('hex');
}

/** Сессия без id (аноним веб-чата) — хэш, а не сырой IP. */
export function sessionRefFrom(id: string | null | undefined, fallback: string): string {
  if (id) return String(id).slice(0, 120);
  return `anon:${createHash('sha256').update(fallback).digest('hex').slice(0, 16)}`;
}

/** Номер заявки из текста исполнителя: только TRIP-код или числовой номер, не ключ статуса. */
export function requestRefFrom(text: string | undefined): string | null {
  if (!text) return null;
  const trip = /TRIP-[A-Z0-9]{4,20}/.exec(text)?.[0];
  if (trip) return trip;
  const num = /(?:[Зз]аявк[аи]|[Зз]апрос)\s*(?:№|#|номер)\s*(\d{1,12})/.exec(text)?.[1];
  return num ? `#${num}` : null;
}

export function classifyOut(out: ToolOut): { outcome: WriteOutcome; reason: string | null } {
  if (!out) return { outcome: 'unknown', reason: 'no_response' };
  if (out.kind === 'refused' || out.kind === 'rate_limited') return { outcome: 'refused', reason: out.kind };
  if (out.kind !== 'ok' || typeof out.text !== 'string') return { outcome: 'unknown', reason: `kind:${out.kind}`.slice(0, 200) };
  const o = requestOutcome(out.text);
  if (o.kind === 'created') return { outcome: 'created', reason: null };
  if (o.kind === 'not_created') return { outcome: 'refused', reason: 'not_created' };
  return { outcome: 'unknown', reason: 'no_success_marker' };
}

async function append(row: {
  key: string; phase: 'started' | 'finished'; channel: WriteChannel; sessionRef: string; tool: string;
  requestRef?: string | null; outcome?: WriteOutcome | null; reason?: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO kuzmich_write_journal (idempotency_key, phase, channel, session_ref, tool, request_ref, outcome, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.key, row.phase, row.channel, row.sessionRef, row.tool.slice(0, 60), row.requestRef ?? null, row.outcome ?? null, row.reason?.slice(0, 200) ?? null],
    );
  } catch (e) {
    console.warn('[kuzmich-journal] запись не удалась', e instanceof Error ? e.message.slice(0, 160) : '');
  }
}

async function priorState(key: string): Promise<{ created: string | null | undefined; inFlight: boolean }> {
  try {
    const r = await pool.query(
      `SELECT phase, outcome, request_ref, created_at FROM kuzmich_write_journal
        WHERE idempotency_key = $1 ORDER BY id DESC LIMIT 20`,
      [key],
    );
    const rows = r.rows as Array<{ phase: string; outcome: string | null; request_ref: string | null; created_at: Date | string }>;
    const created = rows.find((x) => x.phase === 'finished' && x.outcome === 'created');
    if (created) return { created: created.request_ref ?? null, inFlight: false };
    const last = rows[0];
    const inFlight = !!last && last.phase === 'started' && Date.now() - new Date(last.created_at).getTime() < IN_FLIGHT_MS;
    return { created: undefined, inFlight };
  } catch {
    return { created: undefined, inFlight: false };
  }
}

/** Ответ на повтор уже созданной заявки — текст в форме успеха исполнителя, без ПД. */
export function duplicateOut(requestRef: string | null): ToolOut {
  const ref = requestRef?.startsWith('TRIP-') ? ` Поездка ${requestRef}.` : requestRef ? ` Номер ${requestRef}.` : '';
  return { kind: 'ok', text: `Заявка принята ранее — повтор не создан.${ref} Ключ статуса заявки: выдан в первом ответе.` };
}

export async function journaledWrite(
  meta: { channel: WriteChannel; sessionRef: string; tool: string; args: Record<string, unknown> },
  run: () => Promise<ToolOut>,
): Promise<ToolOut> {
  const key = writeIdempotencyKey(meta.channel, meta.sessionRef, meta.tool, meta.args);
  const prior = await priorState(key);
  if (prior.created !== undefined) return duplicateOut(prior.created);
  if (prior.inFlight) throw new WriteInFlightError();
  const base = { key, channel: meta.channel, sessionRef: meta.sessionRef, tool: meta.tool };
  await append({ ...base, phase: 'started' });
  let out: ToolOut;
  try {
    out = await run();
  } catch (e) {
    await append({ ...base, phase: 'finished', outcome: 'unknown', reason: `threw:${e instanceof Error ? e.name : 'error'}` });
    throw e;
  }
  const c = classifyOut(out);
  await append({ ...base, phase: 'finished', outcome: c.outcome, reason: c.reason, requestRef: c.outcome === 'created' ? requestRefFrom(out?.text) : null });
  return out;
}
