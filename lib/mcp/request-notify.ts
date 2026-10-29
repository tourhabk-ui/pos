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
import { decryptBound, encryptBound, hasEncryptionKey } from '@/lib/encryption';
import { logText } from '@/lib/log/log-text';
import {
  REQUEST_STATUS_BY_KEY_IDS_SQL, buildRequestView, catalogTourOf, issueRequestKey, issueRequestKeyRecord, keyLine,
  type IssuedRequestKey, type RequestCore, type RequestKeyTarget, type StatusRow,
} from '@/lib/mcp/request-status';
import type { RequestKind, RequestState } from '@/lib/mcp/request-status-schema';
import {
  NOTIFY_CHANGED_FIELDS, NOTIFY_DISABLED_REASONS, NOTIFY_HOW_TO_VERIFY,
  type NotifyChangedField, type NotifyDisabledReason,
} from '@/lib/mcp/request-notify-schema';
import { NOTIFY_USER_AGENT, postSigned, signWebhook, type SendFn, type SendOutcome } from '@/lib/mcp/notify-send';
import { checkNotifyUrlShape } from '@/lib/security/notify-url-shape';

/** После скольких неудач подряд подписка отключается (~31 ч по графику ниже). */
export const NOTIFY_MAX_FAILURES = 7;
/** Повтор: 30 мин × 2^(неудач−1), не больше 16 ч: +30 м, +1 ч, +2 ч, +4 ч, +8 ч, +16 ч. */
export const NOTIFY_RETRY_BASE_MIN = 30;
export const NOTIFY_RETRY_CAP_MIN = 960;
/** Бюджеты прогона: всего отправок, на хост за прогон, на хост за сутки (подписок с попыткой), время. */
export const NOTIFY_RUN_SEND_BUDGET = 30;
export const NOTIFY_HOST_RUN_BUDGET = 3;
export const NOTIFY_HOST_DAY_BUDGET = 60;
/** После этого срока новые отправки не начинаются (шаг workflow ждёт 60 с, попытка — до 10 с). */
export const NOTIFY_RUN_TIME_BUDGET_MS = 45_000;
/** Сколько хостов обслуживается одновременно; на хост — одна отправка за раз. */
export const NOTIFY_HOST_WORKERS = 5;
/** Отключённая подписка удаляется через столько дней (152-ФЗ, ст. 5 ч. 7: хост бывает личным доменом). */
export const NOTIFY_RETENTION_DAYS = 30;

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

/**
 * Ключ статуса и, если агент оставил адрес, подписка — хвост ответа целиком.
 * Без адреса — прежний путь без изменений.
 */
export async function issueKeyWithNotify(
  target: RequestKeyTarget, toolName: string, notifyUrl: string | undefined, kind: 'request' | 'stay' = 'request',
): Promise<string> {
  if (!notifyUrl) return keyLine(await issueRequestKey(target, toolName), kind);
  const issued = await issueRequestKeyRecord(target, toolName);
  if (!issued) return `${keyLine(null, kind)} Уведомления не заведены: без ключа статуса подписки нет.`;
  return keyLine(issued.key, kind) + notifyLine(await subscribeNotify(issued, notifyUrl));
}

/** Агент передал notify_url заявке на жильё: подписки нет, и это сказано словами. */
export const STAY_NOTIFY_REFUSAL = ' notify_url для заявки на жильё не заводится: после передачи владельцу её состояние не меняется — ответ владелец даёт звонком, и платформа его не видит.';

// ── Сверка (крон) ───────────────────────────────────────────────────────────

interface LiveRow {
  id: string;
  key_id: string;
  ref: string;
  url_host: string;
  created_at: Date | string;
  baseline_at: Date | string | null;
  last_state: string | null;
  last_date: string | null;
  last_alt_date: string | null;
  last_tour: string | null;
  last_participants: number | null;
  last_fingerprint: string | null;
  delivered_count: number;
  attempts: number;
  next_attempt_at: Date | string | null;
}

interface ClaimedRow { id: string; url_enc: string | null; secret_enc: string | null; delivered_count: number }

export const EXPIRE_SQL = `
  UPDATE agent_request_notify
     SET disabled_at = NOW(), disabled_reason = 'expired', url_enc = NULL, secret_enc = NULL, claimed_until = NULL
   WHERE disabled_at IS NULL AND expires_at <= NOW()`;

/** Удаление отключённых через срок; disabled_reason возвращается для счёта до удаления. */
export const RETENTION_SQL = `
  DELETE FROM agent_request_notify
   WHERE disabled_at IS NOT NULL AND disabled_at < NOW() - ($1::int * INTERVAL '1 day')
  RETURNING disabled_reason`;

export const LIVE_SQL = `
  SELECT id::text, key_id::text, ref, url_host, created_at, baseline_at, last_state,
         last_date::text AS last_date, last_alt_date::text AS last_alt_date, last_tour, last_participants,
         last_fingerprint, delivered_count, attempts, next_attempt_at
    FROM agent_request_notify
   WHERE disabled_at IS NULL AND expires_at > NOW()
     AND (claimed_until IS NULL OR claimed_until < NOW())`;

/** Подписок хоста с попыткой за сутки — суточный бюджет хоста. */
export const HOST_DAY_SQL = `
  SELECT url_host, COUNT(*)::int AS n
    FROM agent_request_notify
   WHERE last_attempt_at > NOW() - INTERVAL '24 hours'
   GROUP BY url_host`;

/** Захват построчный: два планировщика не шлют одно дважды. */
export const CLAIM_SQL = `
  UPDATE agent_request_notify
     SET claimed_until = NOW() + INTERVAL '5 minutes'
   WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL AND (claimed_until IS NULL OR claimed_until < NOW())
  RETURNING id::text, url_enc, secret_enc, delivered_count`;

export const RELEASE_SQL = `UPDATE agent_request_notify SET claimed_until = NULL WHERE id = ANY($1::uuid[])`;

/** Снимок вернулся к доставленному, пока шли повторы: ждать больше нечего. */
export const RESET_SQL = `
  UPDATE agent_request_notify SET attempts = 0, next_attempt_at = NULL, last_error = NULL
   WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL`;

export const DELIVERED_SQL = `
  UPDATE agent_request_notify
     SET ${SNAPSHOT_SET}, last_body_sha256 = $8::char(64), last_delivered_at = NOW(),
         delivered_count = delivered_count + 1, attempts = 0, next_attempt_at = NULL, last_error = NULL,
         last_attempt_at = NOW(), baseline_at = COALESCE(baseline_at, NOW()), claimed_until = NULL
   WHERE id = $1::uuid`;

export const DISABLE_SQL = `
  UPDATE agent_request_notify
     SET disabled_at = NOW(), disabled_reason = $2::varchar, url_enc = NULL, secret_enc = NULL,
         last_error = $3::varchar, last_attempt_at = NOW(), claimed_until = NULL
   WHERE id = $1::uuid AND disabled_at IS NULL`;

export const RETRY_SQL = `
  UPDATE agent_request_notify
     SET attempts = attempts + 1, last_error = $2::varchar, last_attempt_at = NOW(),
         next_attempt_at = NOW() + ($3::int * INTERVAL '1 minute'), claimed_until = NULL
   WHERE id = $1::uuid`;

/** Через сколько минут повтор после `failures`-й неудачи подряд (1-я → 30). */
export function retryDelayMinutes(failures: number): number {
  return Math.min(NOTIFY_RETRY_BASE_MIN * 2 ** Math.max(0, failures - 1), NOTIFY_RETRY_CAP_MIN);
}

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

export interface NotifyRunDeps {
  query?: Query;
  send?: SendFn;
  now?: () => number;
  timeBudgetMs?: number;
}

export interface NotifyRunResult {
  status: 'ok' | 'no_encryption' | 'db_error';
  sqlstate: string | null;
  subscriptions_live: number;
  checked: number;
  changed: number;
  baseline_unknown: number;
  due: number;
  delivered: number;
  /** Отказы приёмников по машинным кодам (http_503, timeout, tls, dns_failed, address_refused…). */
  receiver_failed: Record<string, number>;
  deferred: { run_budget: number; host_run_budget: number; host_day_budget: number; time_budget: number; host_failed: number; claimed_elsewhere: number };
  disabled: Record<NotifyDisabledReason, number>;
  deleted_after_retention: number;
  reset_reverted: number;
  missing_view: number;
  record_failed: number;
  duration_ms: number;
}

function emptyResult(): NotifyRunResult {
  return {
    status: 'ok', sqlstate: null, subscriptions_live: 0, checked: 0, changed: 0, baseline_unknown: 0, due: 0, delivered: 0,
    receiver_failed: {},
    deferred: { run_budget: 0, host_run_budget: 0, host_day_budget: 0, time_budget: 0, host_failed: 0, claimed_elsewhere: 0 },
    disabled: Object.fromEntries(NOTIFY_DISABLED_REASONS.map((r) => [r, 0])) as Record<NotifyDisabledReason, number>,
    deleted_after_retention: 0, reset_reverted: 0, missing_view: 0, record_failed: 0, duration_ms: 0,
  };
}

interface Due {
  live: LiveRow;
  core: RequestCore;
  snap: NotifySnapshot;
  fp: string;
  previous: NotifySnapshot | null;
  toolName: string;
}

function previousOf(l: LiveRow): NotifySnapshot | null {
  if (l.baseline_at === null || l.last_state === null) return null;
  return {
    state: l.last_state as RequestState, date: l.last_date, alt_date: l.last_alt_date,
    tour: l.last_tour, participants: l.last_participants === null ? null : Number(l.last_participants),
  };
}

function time(v: Date | string | null): number {
  return v === null ? 0 : new Date(v).getTime();
}

/**
 * Кого слать в этом прогоне. Хосты, куда уже доставляли, — первыми; внутри
 * хоста — дольше всех ждущие. По кругу между хостами: один хост не вытесняет
 * остальных. Лишнее — в отложенные (следующий прогон), не теряется.
 */
export function planSends(due: Due[], hostDay: Map<string, number>, knownHosts: Set<string>, res: NotifyRunResult): Map<string, Due[]> {
  const byHost = new Map<string, Due[]>();
  for (const d of [...due].sort((a, b) => time(a.live.next_attempt_at ?? a.live.created_at) - time(b.live.next_attempt_at ?? b.live.created_at))) {
    const list = byHost.get(d.live.url_host) ?? [];
    list.push(d);
    byHost.set(d.live.url_host, list);
  }
  const hosts = [...byHost.keys()].sort((a, b) => Number(knownHosts.has(b)) - Number(knownHosts.has(a)));
  const queues = new Map<string, Due[]>();
  for (const h of hosts) {
    const list = byHost.get(h)!;
    const dayLeft = Math.max(0, NOTIFY_HOST_DAY_BUDGET - (hostDay.get(h) ?? 0));
    const allowed = Math.min(NOTIFY_HOST_RUN_BUDGET, dayLeft);
    const overDay = Math.max(0, list.length - dayLeft);
    res.deferred.host_day_budget += Math.min(overDay, list.length);
    res.deferred.host_run_budget += Math.max(0, list.length - overDay - allowed);
    queues.set(h, list.slice(0, allowed));
  }
  const selected = new Map<string, Due[]>();
  let total = 0;
  for (let round = 0; round < NOTIFY_HOST_RUN_BUDGET; round++) {
    for (const h of hosts) {
      const d = queues.get(h)![round];
      if (!d) continue;
      if (total >= NOTIFY_RUN_SEND_BUDGET) { res.deferred.run_budget++; continue; }
      selected.set(h, [...(selected.get(h) ?? []), d]);
      total++;
    }
  }
  return selected;
}

/** Один прогон сверки. Никогда не бросает: исход — в status. */
export async function runRequestNotify(deps: NotifyRunDeps = {}): Promise<NotifyRunResult> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  const send: SendFn = deps.send ?? ((url, body, headers) => postSigned(url, body, headers));
  const now = deps.now ?? Date.now;
  const timeBudget = deps.timeBudgetMs ?? NOTIFY_RUN_TIME_BUDGET_MS;
  const started = now();
  const res = emptyResult();
  const finish = () => { res.duration_ms = Math.max(0, now() - started); return res; };
  let step = 'истечение';

  try {
    res.disabled.expired = (await q(EXPIRE_SQL)).rowCount ?? 0;
    step = 'уборка';
    res.deleted_after_retention = (await q(RETENTION_SQL, [NOTIFY_RETENTION_DAYS])).rowCount ?? 0;
    step = 'живые';
    const live = (await q(LIVE_SQL)).rows as LiveRow[];
    res.subscriptions_live = live.length;
    if (live.length === 0) return finish();
    if (!hasEncryptionKey()) {
      console.error(`${LOG} не смог: ENCRYPTION_KEY не задан, живых подписок ${live.length} — не тронуты`);
      res.status = 'no_encryption';
      return finish();
    }

    step = 'вид заявок';
    const views = new Map<string, StatusRow>();
    for (const row of (await q(REQUEST_STATUS_BY_KEY_IDS_SQL, [live.map((l) => l.key_id)])).rows as StatusRow[]) {
      if (row.key_id) views.set(row.key_id, row);
    }
    step = 'бюджет хостов';
    const hostDay = new Map<string, number>();
    for (const r of (await q(HOST_DAY_SQL)).rows as Array<{ url_host: string; n: number }>) hostDay.set(r.url_host, Number(r.n));
    const knownHosts = new Set(live.filter((l) => Number(l.delivered_count) > 0).map((l) => l.url_host));

    const due: Due[] = [];
    const reverted: string[] = [];
    const nowMs = now();
    for (const l of live) {
      const row = views.get(l.key_id);
      if (!row) { res.missing_view++; continue; }
      res.checked++;
      const core = buildRequestView(row, nowMs);
      const snap = snapshotOf(core, catalogTourOf(row));
      const fp = fingerprintOf(snap);
      const previous = previousOf(l);
      if (previous && fp === l.last_fingerprint) {
        if (Number(l.attempts) > 0) reverted.push(l.id);
        continue;
      }
      res.changed++;
      if (!previous) res.baseline_unknown++;
      if (l.next_attempt_at !== null && time(l.next_attempt_at) > nowMs) continue;
      due.push({ live: l, core, snap, fp, previous, toolName: row.tool_name });
    }
    res.due = due.length;
    if (reverted.length > 0) {
      step = 'сброс повторов';
      res.reset_reverted = (await q(RESET_SQL, [reverted])).rowCount ?? reverted.length;
    }
    if (due.length === 0) return finish();

    const plan = planSends(due, hostDay, knownHosts, res);
    const planned = [...plan.values()].flat();
    if (planned.length === 0) return finish();
    step = 'захват';
    const claimed = new Map<string, ClaimedRow>();
    for (const c of (await q(CLAIM_SQL, [planned.map((d) => d.live.id)])).rows as ClaimedRow[]) claimed.set(c.id, c);
    res.deferred.claimed_elsewhere = planned.length - claimed.size;

    const release: string[] = [];
    const record = async (sql: string, params: unknown[]) => {
      try {
        await q(sql, params);
      } catch (err) {
        res.record_failed++;
        res.status = 'db_error';
        res.sqlstate = sqlstate(err);
        console.error(`${LOG} исход не записан: SQLSTATE=${res.sqlstate}`);
      }
    };

    const sendOne = async (d: Due, c: ClaimedRow): Promise<'network' | 'done'> => {
      const ref = d.live.ref;
      const host = d.live.url_host;
      const url = c.url_enc ? decryptBound(c.url_enc, ref) : null;
      const signingKey = c.secret_enc ? decryptBound(c.secret_enc, ref) : null;
      if (!url || !signingKey) {
        console.error(`${LOG} ref=${ref} не расшифровался при заданном ключе — отключена (undecryptable)`);
        res.disabled.undecryptable++;
        await record(DISABLE_SQL, [d.live.id, 'undecryptable', 'undecryptable']);
        return 'done';
      }
      const body = JSON.stringify(buildNotification({
        ref, tool: d.toolName, core: d.core, snapshot: d.snap, previous: d.previous, observedAt: new Date(nowMs),
      }));
      const id = eventId(ref, Number(c.delivered_count) + 1, d.fp);
      const ts = Math.floor(now() / 1000);
      let outcome: SendOutcome;
      try {
        outcome = await send(url, body, {
          'content-type': 'application/json',
          'user-agent': NOTIFY_USER_AGENT,
          'webhook-id': id,
          'webhook-timestamp': String(ts),
          'webhook-signature': signWebhook(signingKey, id, ts, body),
        });
      } catch {
        // Отправитель не бросает по построению; бросил — это сбой попытки, не прогона.
        outcome = { kind: 'retry', code: 'network', network: true };
      }
      const line = `${LOG} ref=${ref} host=${logText(host, 253)} исход=${outcome.code}`;
      if (outcome.kind === 'delivered') {
        console.info(line);
        res.delivered++;
        await record(DELIVERED_SQL, [d.live.id, d.snap.state, d.snap.date, d.snap.alt_date, d.snap.tour, d.snap.participants, d.fp, sha256(body)]);
        return 'done';
      }
      console.warn(line);
      res.receiver_failed[outcome.code] = (res.receiver_failed[outcome.code] ?? 0) + 1;
      if (outcome.kind === 'gone' || outcome.kind === 'rejected') {
        res.disabled[outcome.kind]++;
        await record(DISABLE_SQL, [d.live.id, outcome.kind, outcome.code]);
        return 'done';
      }
      const failures = Number(d.live.attempts) + 1;
      if (failures >= NOTIFY_MAX_FAILURES) {
        res.disabled.undeliverable++;
        await record(DISABLE_SQL, [d.live.id, 'undeliverable', outcome.code]);
      } else {
        await record(RETRY_SQL, [d.live.id, outcome.code, retryDelayMinutes(failures)]);
      }
      return outcome.network ? 'network' : 'done';
    };

    // Хосты обслуживаются параллельно, внутри хоста — по одной отправке. После
    // сетевого отказа хоста остальное ему — в следующий прогон. После срока
    // прогона новые отправки не начинаются.
    const hostQueue = [...plan.entries()];
    const worker = async () => {
      for (let next = hostQueue.shift(); next; next = hostQueue.shift()) {
        const [, items] = next;
        let hostFailed = false;
        for (const d of items) {
          const c = claimed.get(d.live.id);
          if (!c) continue;
          if (hostFailed) { res.deferred.host_failed++; release.push(d.live.id); continue; }
          if (now() - started >= timeBudget) { res.deferred.time_budget++; release.push(d.live.id); continue; }
          if ((await sendOne(d, c)) === 'network') hostFailed = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(NOTIFY_HOST_WORKERS, hostQueue.length) }, worker));
    if (release.length > 0) await record(RELEASE_SQL, [release]);
    return finish();
  } catch (err) {
    res.status = 'db_error';
    res.sqlstate = sqlstate(err);
    console.error(`${LOG} прогон не удался на шаге «${step}»: SQLSTATE=${res.sqlstate}`);
    return finish();
  }
}
