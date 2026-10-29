/**
 * Уведомление агенту об изменении заявки (слово владельца 29.10: «делай, я
 * не знал про эту дыру»). Подписка при создании заявки и сверка по
 * расписанию; объявление — lib/mcp/request-notify-schema, отправка —
 * lib/mcp/notify-send, хранение — миграция 1348.
 *
 * ── Почему сверка, а не подвязка к дверям ──────────────────────────────────
 * Лиды меняют десять файлов, брони — двадцать один, а «нет ответа» у запроса
 * мест наступает по часам без единой записи в базу. Подвязка к каждой двери
 * молча пропускала бы новую. Сверка — единственный производитель, который
 * видит всё, что видит get_request_status, потому что она и есть тот же
 * читатель: вид заявки собирает та же buildRequestView, сравнивается с
 * последним доставленным снимком, разница уходит POST'ом.
 *
 * ── Исходы прогона — три, не два (§4.0) ────────────────────────────────────
 * - ok: база прочиталась, каждая отправка получила исход. Отказ приёмника
 *   (сеть, таймаут, TLS, DNS, коды HTTP) — исход ЭТОГО приёмника: попытка
 *   засчитывается, дальше график повторов. Вывод «это наша сеть» из отказов
 *   чужих адресов не делается: адреса выбирает чужой человек, и два хоста,
 *   глотающих TCP, держали бы красным всё сердцебиение safety-кронов 90 дней
 *   (критика 29.10).
 * - no_encryption: живые подписки есть, а ENCRYPTION_KEY не задан — «не
 *   смог», подписки не трогаются (это не вина приёмников).
 * - db_error: SQL упал — SQLSTATE в лог и в ответ.
 *
 * ── Что уходит наружу ──────────────────────────────────────────────────────
 * Тело — состояние, даты, тур из каталога, число человек, тексты
 * get_request_status. Имени, телефона, комментария, направления, набранного
 * человеком, номеров лида и брони, страницы с ключом — нет. Ключа статуса в
 * теле нет: им же человек подтверждает согласие на обработку ПД, а тело
 * оседает в логах чужих прокси.
 *
 * В лог — `ref` и хост, без пути и query (там бывают токены приёмника). В
 * ответ крона (он печатается в публичный лог Actions) — только числа и
 * машинные коды, никогда текст ошибки: в нём бывает хост приёмника.
 */

import { createHash, randomBytes } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { encryptBound, hasEncryptionKey } from '@/lib/encryption';
import { logText } from '@/lib/log/log-text';
import {
  REQUEST_STATUS_BY_KEY_IDS_SQL, buildRequestView, catalogTourOf,
  type IssuedRequestKey, type RequestCore, type StatusRow,
} from '@/lib/mcp/request-status';
import type { RequestKind, RequestState } from '@/lib/mcp/request-status-schema';
import {
  NOTIFY_CHANGED_FIELDS, NOTIFY_HOW_TO_VERIFY, type NotifyChangedField,
} from '@/lib/mcp/request-notify-schema';
import { checkNotifyUrlShape } from '@/lib/security/notify-url-shape';

const LOG = '[agent-notify]';

function sha256(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('hex');
}

function sqlstate(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'none';
}

// ── Снимок и отпечаток ─────────────────────────────────────────────────────

/** Что сверка сравнивает: ровно NOTIFY_CHANGED_FIELDS. Тур — только из каталога. */
export interface NotifySnapshot {
  state: RequestState;
  date: string | null;
  alt_date: string | null;
  tour: string | null;
  participants: number | null;
}

export function snapshotOf(core: RequestCore, catalogTour: string | null): NotifySnapshot {
  return { state: core.state, date: core.date, alt_date: core.alt_date, tour: catalogTour, participants: core.participants };
}

export function fingerprintOf(s: NotifySnapshot): string {
  return sha256(JSON.stringify(NOTIFY_CHANGED_FIELDS.map((f) => s[f] ?? null)));
}

/** Что изменилось; прошлого снимка нет — изменилось всё (неизвестно, что было). */
export function changedFields(prev: NotifySnapshot | null, cur: NotifySnapshot): NotifyChangedField[] {
  if (!prev) return [...NOTIFY_CHANGED_FIELDS];
  return NOTIFY_CHANGED_FIELDS.filter((f) => (prev[f] ?? null) !== (cur[f] ?? null));
}

/**
 * webhook-id: повтор того же снимка — тот же id (приёмник отсечёт дубль);
 * следующая доставка — новый id, даже если снимок вернулся к прежнему (A→B→A:
 * перенос туда и обратно, ручные статусы в любом порядке — критика 29.10).
 * `seq` — номер доставки (delivered_count + 1).
 */
export function eventId(ref: string, seq: number, fingerprint: string): string {
  return `evt_${sha256(`${ref}:${seq}:${fingerprint}`).slice(0, 32)}`;
}

export interface RequestNotification {
  type: 'request.updated';
  ref: string;
  kind: RequestKind;
  tool: string;
  state: RequestState;
  previous_state: RequestState | null;
  changed: NotifyChangedField[];
  human: string;
  next: string;
  date: string | null;
  previous_date: string | null;
  requested_date: string | null;
  alt_date: string | null;
  tour: string | null;
  participants: number | null;
  observed_at: string;
  reason: 'baseline_unknown' | null;
  hint: string;
}

/** Тело уведомления — поимённо, без ПД by construction: полей для них нет. */
export function buildNotification(a: {
  ref: string; tool: string; core: RequestCore; snapshot: NotifySnapshot; previous: NotifySnapshot | null; observedAt: Date;
}): RequestNotification {
  return {
    type: 'request.updated',
    ref: a.ref,
    kind: a.core.kind,
    tool: a.tool,
    state: a.snapshot.state,
    previous_state: a.previous?.state ?? null,
    changed: changedFields(a.previous, a.snapshot),
    human: a.core.human,
    next: a.core.next,
    date: a.snapshot.date,
    previous_date: a.previous?.date ?? null,
    requested_date: a.core.requested_date,
    alt_date: a.snapshot.alt_date,
    tour: a.snapshot.tour,
    participants: a.snapshot.participants,
    observed_at: a.observedAt.toISOString(),
    reason: a.previous ? null : 'baseline_unknown',
    hint: 'Подробности — get_request_status с ключом статуса этой заявки.',
  };
}

// ── Подписка при создании заявки ────────────────────────────────────────────

export type SubscribeOutcome =
  | { ok: true; ref: string; signingKey: string }
  | { ok: false; reason: 'no_encryption' | 'db_error' | 'no_key' };

const SNAPSHOT_SET = `last_state = $2::varchar, last_date = $3::date, last_alt_date = $4::date,
       last_tour = $5::varchar, last_participants = $6::int, last_fingerprint = $7::char(64)`;

/**
 * База отсчёта: что знала заявка в момент подписки — тем же читателем. Отказ
 * не роняет ответ (заявка, ключ и подписка уже есть): строка в лог, а первый
 * прогон сверки пошлёт текущее с reason baseline_unknown — честное «не знаю,
 * что было до», а не молчаливый пропуск изменения.
 */
async function recordBaseline(notifyId: string, keyId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query<StatusRow>(REQUEST_STATUS_BY_KEY_IDS_SQL, [[keyId]]);
    const row = rows[0];
    if (!row) {
      console.error(`${LOG} база отсчёта не записана: ключ не прочитан`);
      return false;
    }
    const snap = snapshotOf(buildRequestView(row, Date.now()), catalogTourOf(row));
    await pool.query(
      `UPDATE agent_request_notify SET baseline_at = NOW(), ${SNAPSHOT_SET} WHERE id = $1::uuid`,
      [notifyId, snap.state, snap.date, snap.alt_date, snap.tour, snap.participants, fingerprintOf(snap)],
    );
    return true;
  } catch (err) {
    console.error(`${LOG} база отсчёта не записана: SQLSTATE=${sqlstate(err)}`);
    return false;
  }
}

/**
 * Завести подписку на уже выданный ключ — вторым запросом: ключ статуса не
 * зависит от подписки (критика 29.10). Сбой здесь — заявка и ключ остаются,
 * агент слышит «уведомления не заведены» и опрашивает.
 */
export async function subscribeNotify(key: IssuedRequestKey, rawUrl: string): Promise<SubscribeOutcome> {
  const shape = checkNotifyUrlShape(rawUrl);
  if (!shape.ok || !key.keyId) {
    console.error(`${LOG} подписка не заведена: ${shape.ok ? 'нет строки ключа' : 'адрес не прошёл проверку формы'}`);
    return { ok: false, reason: 'no_key' };
  }
  if (!hasEncryptionKey()) {
    console.error(`${LOG} подписка не заведена: ENCRYPTION_KEY не задан`);
    return { ok: false, reason: 'no_encryption' };
  }
  const ref = `nr_${randomBytes(16).toString('base64url')}`;
  const signingKey = `whsec_${randomBytes(32).toString('base64')}`;
  const urlEnc = encryptBound(shape.url.toString(), ref);
  const keyEnc = encryptBound(signingKey, ref);
  if (!urlEnc || !keyEnc) {
    console.error(`${LOG} подписка не заведена: шифрование не удалось`);
    return { ok: false, reason: 'no_encryption' };
  }
  let notifyId: string;
  try {
    const { rows } = await pool.query<{ id: string }>(
      // Срок — ровно срок ключа, из его строки (не через JS Date: тот теряет
      // микросекунды, и подписка истекала бы раньше ключа).
      `INSERT INTO agent_request_notify (key_id, ref, url_enc, url_host, secret_enc, expires_at)
       VALUES ($1::uuid, $2::varchar, $3::text, $4::varchar, $5::text,
               (SELECT k.expires_at FROM agent_request_keys k WHERE k.id = $1::uuid))
       RETURNING id::text AS id`,
      [key.keyId, ref, urlEnc, shape.host, keyEnc],
    );
    if (!rows[0]) throw Object.assign(new Error('нет строки'), { code: 'P0002' });
    notifyId = rows[0].id;
  } catch (err) {
    console.error(`${LOG} подписка не заведена: SQLSTATE=${sqlstate(err)}`);
    return { ok: false, reason: 'db_error' };
  }
  await recordBaseline(notifyId, key.keyId);
  console.info(`${LOG} подписка ${ref} host=${logText(shape.host, 253)}`);
  return { ok: true, ref, signingKey };
}

/** Хвост ответа пишущего инструмента про уведомления. */
export function notifyLine(o: SubscribeOutcome): string {
  if (!o.ok) {
    return ' Уведомления об изменении заявки не заведены: сбой на стороне Ведара. Заявка создана; о переменах узнавайте опросом get_request_status.';
  }
  return ` Уведомления об изменении заявки: номер подписки ${o.ref}; ключ подписи ${o.signingKey} — показан один раз, сохраните его у себя и не публикуйте.`
    + ' На notify_url придёт POST с JSON, когда изменятся состояние, дата, предложенная дата, тур или число человек.'
    + ` ${NOTIFY_HOW_TO_VERIFY}`
    + ' Сверка идёт по расписанию примерно раз в 30 минут, срок не гарантирован — задержка бывает часами; get_request_status отвечает сразу.'
    + ' Подписка живёт столько же, сколько ключ статуса (90 дней); ответ 410 её отключает. В теле нет ни ключа статуса, ни имени и телефона.';
}
