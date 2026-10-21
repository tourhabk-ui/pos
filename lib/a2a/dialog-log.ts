/**
 * Журнал общения A2A — вопрос агента и ответ Кузьмича (решение владельца 13.10:
 * «заведем журнал общения для A2A»; миграция 1225).
 *
 * Журнал запросов (lib/a2a/journal, 1219) говорит, КТО пришёл и чем кончилось,
 * и текста не хранит по построению. Этот — ЧТО спросили и что ответили. Он
 * отдельный, потому что у текста свои правила:
 *
 *  · вопрос и ответ проходят redactPII до записи: телефоны и почты заменяются
 *    плейсхолдерами. Имя человека по тексту не отличить от обычных слов,
 *    поэтому у таблицы срок — RETENTION_DAYS, а не «навсегда»;
 *  · старое удаляется ПЕРЕД каждой записью, а не раз в N записей и не кроном:
 *    при редких диалогах вероятностная уборка держала бы текст месяцами
 *    сверх объявленного срока, а крон — ещё одна вещь, которая может молча не
 *    запуститься. Удаление идёт по индексу created_at, вопрос к Кузьмичу
 *    стоит секунд модели — уборка на этом фоне не видна;
 *  · с 21.10 (решение владельца, миграция 1303) пишутся IP клиента из
 *    доверенного заголовка прокси и User-Agent целиком — чтобы видеть, КТО
 *    гоняет Кузьмича (повод: серия внешних Python-urllib 20–21.10). Срок тот
 *    же RETENTION_DAYS и та же уборка: адрес — ПД, дольше текста не живёт.
 *    contextId по-прежнему только hash.
 *
 * Fire-and-forget: ответ агенту важнее журнала, но отказ записи называется в
 * логе с SQLSTATE (§4.0) — молчащий журнал читался бы как «агенты молчат».
 *
 * Сторож: tests/unit/a2a-dialog-log.test.ts.
 */

import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { redactPII } from '@/lib/security/pii-redact';
import { mcpCallerHash } from '@/lib/mcp/call-log';
import { uaFamily } from '@/lib/mcp/client-id';
import { agentLabel, contextKey } from '@/lib/a2a/journal';

/** Сколько суток живёт текст разговора. Окно страницы /hub/admin/a2a — до 90. */
export const RETENTION_DAYS = 90;
export const QUESTION_MAX = 2000;
export const ANSWER_MAX = 6000;

export type A2aDialogState = 'completed' | 'failed' | 'rejected';

export interface A2aDialogEntry {
  question: string;
  answer: string;
  state: A2aDialogState;
  /** contextId агента — в журнал уходит только hash. */
  contextId?: string | null;
  /** Номер реплики агента в разговоре, с единицы. */
  turn: number;
  durationMs?: number | null;
  ip: string;
  /** IP из доверенного заголовка прокси; null — заголовка не было (не 127.0.0.1). */
  clientIp?: string | null;
  userAgent: string;
  self: boolean;
}

export const CLIENT_IP_MAX = 64;
export const USER_AGENT_MAX = 512;

/** Адрес для журнала: только то, что похоже на IPv4/IPv6, иначе null. */
export function dialogClientIp(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v || v.length > CLIENT_IP_MAX) return null;
  return /^[0-9a-fA-F:.]+$/.test(v) ? v : null;
}

/** User-Agent целиком, без управляющих символов, до USER_AGENT_MAX. */
export function dialogUserAgent(raw: string | null | undefined): string | null {
  const v = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!v) return null;
  return v.length > USER_AGENT_MAX ? v.slice(0, USER_AGENT_MAX) : v;
}

/** Текст для журнала: сперва вычистить телефоны и почты, потом обрезать. */
export function dialogText(raw: string, max: number): string {
  const clean = redactPII(raw).trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function failLog(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  console.error(
    `[a2a-dialog] ${what}:`,
    typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет',
    logText(err instanceof Error ? err.message : err, 200),
  );
}

async function write(entry: A2aDialogEntry): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM a2a_dialogs WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [RETENTION_DAYS],
    );
  } catch (err) {
    // Уборка не прошла — запись всё равно делается: потерять разговор хуже,
    // чем подержать старый день лишнего. Но отказ назван.
    failLog('уборка старых разговоров не прошла', err);
  }
  await pool.query(
    `INSERT INTO a2a_dialogs (agent, ua_family, caller_hash, context_key, turn, question, answer, state, duration_ms, is_self, client_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      agentLabel(entry.userAgent),
      uaFamily(entry.userAgent).slice(0, 24),
      mcpCallerHash(entry.ip, entry.userAgent),
      contextKey(entry.contextId),
      Number.isInteger(entry.turn) && entry.turn >= 1 ? entry.turn : 1,
      dialogText(entry.question, QUESTION_MAX),
      dialogText(entry.answer, ANSWER_MAX),
      entry.state,
      typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
        ? Math.max(0, Math.round(entry.durationMs)) : null,
      entry.self,
      dialogClientIp(entry.clientIp),
      dialogUserAgent(entry.userAgent),
    ],
  );
}

/** Записать реплику разговора. Не бросает и не ждёт: отказ — в лог. */
export function logA2aDialog(entry: A2aDialogEntry): void {
  void write(entry).catch((err: unknown) => failLog('разговор не записан', err));
}
