// @vitest-environment node
/**
 * Уведомление агенту об изменении заявки (слово владельца 29.10: «делай, я
 * не знал про эту дыру»; миграция 1348).
 *
 * Держит подписку: адрес и ключ подписи в базу — только шифртекстом,
 * привязанным к ref строки (переставленный в другую строку не
 * расшифровывается); ключ подписи — whsec_ + 32 случайных байта; без
 * ENCRYPTION_KEY подписка не заводится и это сказано агенту; сбой записи
 * подписки — заявка и ключ живы, агенту «не заведены»; база отсчёта пишется
 * тем же читателем, что get_request_status, и её отказ не роняет ответ; в
 * логах — хост, без пути и query. Поле notify в get_request_status говорит
 * агенту три слова, а не внутренние причины.
 *
 * Подпись — Standard Webhooks, сверяется НЕЗАВИСИМОЙ реализацией в тесте
 * (node:crypto по спецификации, не импортом той же функции) и эталонным
 * вектором спецификации. webhook-id: повтор снимка — тот же id, следующая
 * доставка — новый, и возврат к прежнему снимку (A→B→A) — тоже новый. Тело
 * — ровно поля схемы, без ПД: ни имени, ни телефона, ни направления,
 * набранного человеком, ни страницы с ключом.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { createHmac, randomBytes } from 'node:crypto';
import {
  subscribeNotify, notifyLine, snapshotOf, fingerprintOf, changedFields, eventId, buildNotification, type SubscribeOutcome,
} from '@/lib/mcp/request-notify';
import { notifyStatusOf, buildRequestView, catalogTourOf, REQUEST_STATUS_BY_KEY_IDS_SQL, type StatusRow, type RequestCore } from '@/lib/mcp/request-status';
import { NOTIFY_CHANGED_FIELDS, REQUEST_NOTIFICATION_SCHEMA } from '@/lib/mcp/request-notify-schema';
import { signWebhook } from '@/lib/mcp/notify-send';
import { decryptBound } from '@/lib/encryption';

const ENC = 'a'.repeat(64);
const KEY = { key: 'K'.repeat(32), keyId: '11111111-1111-1111-1111-111111111111' };
const URL_WITH_SECRETS = 'https://hooks.agent-example.ru/vedar/in?sig=abc123&user=7';

const ROW: StatusRow = {
  key_id: KEY.keyId, tool_name: 'create_booking_request', lead_id: 'L', seat_request_id: null,
  lead_status: 'new', route_title: 'Вулкан Горелый', lead_requested_date: '2027-07-15',
  booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
  seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null, seat_tour: null,
  lead_consent_at: null, lead_consent_source: null, seat_consent_at: null, seat_consent_source: null,
  stay_request_id: null, stay_accommodation_id: null, stay_name: null, stay_check_in: null, stay_check_out: null, stay_guests: null,
  stay_owner_channel: null, stay_platform_channel: null, stay_delivery_recorded_at: null, stay_consent_at: null, stay_consent_source: null,
};

let errSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
const logged = () => [...errSpy.mock.calls, ...infoSpy.mock.calls].map((c) => c.map(String).join(' ')).join('\n');

beforeEach(() => {
  query.mockReset();
  process.env.ENCRYPTION_KEY = ENC;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
  vi.restoreAllMocks();
});

describe('подписка при создании заявки', () => {
  it('в базу — шифртекст адреса и ключа, привязанный к ref; хост открыт; срок — срок ключа; ключ подписи — whsec_ 32 байта', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO agent_request_notify')) return { rows: [{ id: 'N1' }] };
      if (sql === REQUEST_STATUS_BY_KEY_IDS_SQL) return { rows: [ROW] };
      return { rows: [], rowCount: 1 };
    });
    const o = await subscribeNotify(KEY, URL_WITH_SECRETS) as Extract<SubscribeOutcome, { ok: true }>;
    expect(o.ok).toBe(true);
    expect(o.ref).toMatch(/^nr_[A-Za-z0-9_-]{22}$/);
    expect(o.signingKey).toMatch(/^whsec_/);
    expect(Buffer.from(o.signingKey.slice(6), 'base64')).toHaveLength(32);

    const [sql, params] = query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO agent_request_notify'))!;
    expect(sql).not.toMatch(/WHERE NOT EXISTS/);
    // Срок подписки — из строки ключа, в том же запросе.
    expect(sql).toContain('(SELECT k.expires_at FROM agent_request_keys k WHERE k.id = $1::uuid)');
    const [keyId, ref, urlEnc, host, secretEnc] = params as [string, string, string, string, string];
    expect([keyId, ref, host]).toEqual([KEY.keyId, o.ref, 'hooks.agent-example.ru']);
    // Ни адреса, ни ключа подписи открытым текстом в параметрах записи.
    expect(JSON.stringify(params)).not.toContain('abc123');
    expect(JSON.stringify(params)).not.toContain(o.signingKey);
    expect(decryptBound(urlEnc, o.ref)).toBe(URL_WITH_SECRETS);
    expect(decryptBound(secretEnc, o.ref)).toBe(o.signingKey);
    // Шифртекст, переставленный в чужую строку, не расшифровывается.
    expect(decryptBound(urlEnc, 'nr_AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('база отсчёта — тем же читателем (вид без отметки прочтения): состояние и тур каталога, не направление человека', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO agent_request_notify')) return { rows: [{ id: 'N1' }] };
      if (sql === REQUEST_STATUS_BY_KEY_IDS_SQL) return { rows: [{ ...ROW, tool_name: 'request_charter', route_title: 'Ул. Тестовая, 1' }] };
      return { rows: [], rowCount: 1 };
    });
    await subscribeNotify(KEY, URL_WITH_SECRETS);
    const base = query.mock.calls.find((c) => String(c[0]).includes('baseline_at = NOW()'))!;
    expect(base[1]).toEqual(['N1', 'awaiting_operator', null, null, null, null, expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(query.mock.calls.find((c) => c[0] === REQUEST_STATUS_BY_KEY_IDS_SQL)![1]).toEqual([[KEY.keyId]]);
  });

  it('отказ базы отсчёта не роняет подписку: ok, строка в лог с SQLSTATE', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO agent_request_notify')) return { rows: [{ id: 'N1' }] };
      if (sql === REQUEST_STATUS_BY_KEY_IDS_SQL) throw Object.assign(new Error('boom'), { code: '57P01' });
      return { rows: [], rowCount: 1 };
    });
    expect((await subscribeNotify(KEY, URL_WITH_SECRETS)).ok).toBe(true);
    expect(logged()).toContain('база отсчёта не записана: SQLSTATE=57P01');
  });

  it('нет ENCRYPTION_KEY — подписка не заводится, записи нет, причина названа', async () => {
    delete process.env.ENCRYPTION_KEY;
    expect(await subscribeNotify(KEY, URL_WITH_SECRETS)).toEqual({ ok: false, reason: 'no_encryption' });
    expect(query).not.toHaveBeenCalled();
    expect(logged()).toContain('ENCRYPTION_KEY не задан');
  });

  it('запись упала — db_error с SQLSTATE; в логе ни пути, ни query адреса', async () => {
    query.mockRejectedValue(Object.assign(new Error('insert failed for https://hooks.agent-example.ru/vedar/in?sig=abc123'), { code: '23505' }));
    expect(await subscribeNotify(KEY, URL_WITH_SECRETS)).toEqual({ ok: false, reason: 'db_error' });
    expect(logged()).toContain('SQLSTATE=23505');
    expect(logged()).not.toMatch(/vedar\/in|sig=|abc123/);
  });

  it('успешная подписка пишет в лог ref и хост — без пути и query', async () => {
    query.mockImplementation(async (sql: string) => (sql.includes('INSERT INTO agent_request_notify') ? { rows: [{ id: 'N1' }] } : { rows: [ROW], rowCount: 1 }));
    await subscribeNotify(KEY, URL_WITH_SECRETS);
    expect(logged()).toContain('host=hooks.agent-example.ru');
    expect(logged()).not.toMatch(/vedar\/in|sig=|abc123/);
  });

  it('без строки ключа подписки нет', async () => {
    expect(await subscribeNotify({ ...KEY, keyId: null }, URL_WITH_SECRETS)).toEqual({ ok: false, reason: 'no_key' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('хвост ответа', () => {
  it('подписка есть — номер, ключ подписи один раз, как проверять подпись и защищаться от повтора, срок без обещания', () => {
    const line = notifyLine({ ok: true, ref: 'nr_x', signingKey: 'whsec_y' });
    expect(line).toContain('nr_x');
    expect(line).toContain('whsec_y');
    expect(line).toMatch(/показан один раз/);
    expect(line).toMatch(/Standard Webhooks/);
    expect(line).toMatch(/старше 5 минут/);
    expect(line).toMatch(/webhook-id/);
    expect(line).toMatch(/observed_at/);
    expect(line).toMatch(/срок не гарантирован/);
    expect(line).not.toMatch(/\b(secret|token|password)\b/i);
  });

  it('подписки нет — сказано, что заявка создана и что опрашивать', () => {
    for (const reason of ['no_encryption', 'db_error', 'no_key'] as const) {
      const line = notifyLine({ ok: false, reason });
      expect(line).toMatch(/не заведены/);
      expect(line).toMatch(/Заявка создана/);
      expect(line).toMatch(/get_request_status/);
    }
  });
});

describe('поле notify в get_request_status', () => {
  it('нет строки — null; живая — active; причины наружу тремя словами', () => {
    expect(notifyStatusOf({ ...ROW })).toBeNull();
    expect(notifyStatusOf({ ...ROW, notify_ref: 'nr_a', notify_disabled_reason: null })).toEqual({ ref: 'nr_a', active: true, disabled_reason: null });
    const reason = (r: string) => notifyStatusOf({ ...ROW, notify_ref: 'nr_a', notify_disabled_reason: r })?.disabled_reason;
    expect(reason('gone')).toBe('gone');
    expect(reason('rejected')).toBe('undeliverable');
    expect(reason('undeliverable')).toBe('undeliverable');
    expect(reason('undecryptable')).toBe('vedar_failure');
    expect(notifyStatusOf({ ...ROW, notify_ref: 'nr_a', notify_disabled_reason: 'gone' })?.active).toBe(false);
  });
});

describe('снимок и отпечаток', () => {
  const core = { state: 'confirmed', date: '2027-07-15', alt_date: null, participants: 2 } as unknown as RequestCore;

  it('отпечаток — ровно поля NOTIFY_CHANGED_FIELDS: тексты human/next в него не входят', () => {
    const a = snapshotOf(core, 'Вулкан Горелый');
    expect(Object.keys(a).sort()).toEqual([...NOTIFY_CHANGED_FIELDS].sort());
    expect(fingerprintOf(a)).toBe(fingerprintOf(snapshotOf({ ...core, human: 'другое', next: 'другое' } as RequestCore, 'Вулкан Горелый')));
    for (const f of NOTIFY_CHANGED_FIELDS) {
      const b = { ...a, [f]: f === 'participants' ? 3 : f === 'state' ? 'cancelled' : 'X' };
      expect(fingerprintOf(b), f).not.toBe(fingerprintOf(a));
      expect(changedFields(a, b), f).toEqual([f]);
    }
    expect(changedFields(null, a)).toEqual([...NOTIFY_CHANGED_FIELDS]);
  });
});

describe('подпись Standard Webhooks', () => {
  /** Независимо от кода: по спецификации, ключ — base64 после whsec_, подписывается "id.timestamp.тело". */
  const reference = (secret: string, id: string, ts: number, body: string) =>
    `v1,${createHmac('sha256', Buffer.from(secret.split('_')[1]!, 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;

  it('эталонный вектор спецификации', () => {
    expect(signWebhook('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'))
      .toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('совпадает с независимой реализацией на случайных данных, в том числе с кириллицей в теле', () => {
    for (let i = 0; i < 20; i++) {
      const secret = `whsec_${randomBytes(32).toString('base64')}`;
      const body = JSON.stringify({ human: 'Бронь по заявке отменена.', n: i });
      const id = `evt_${randomBytes(8).toString('hex')}`;
      expect(signWebhook(secret, id, 1_800_000_000 + i, body)).toBe(reference(secret, id, 1_800_000_000 + i, body));
    }
  });
});

describe('webhook-id', () => {
  it('повтор того же снимка — тот же id; следующая доставка — новый; A→B→A — три разных id', () => {
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);
    expect(eventId('nr_x', 1, A)).toBe(eventId('nr_x', 1, A));
    expect(eventId('nr_x', 1, A)).toMatch(/^evt_[0-9a-f]{32}$/);
    const ids = [eventId('nr_x', 1, A), eventId('nr_x', 2, B), eventId('nr_x', 3, A)];
    expect(new Set(ids).size).toBe(3);
    expect(eventId('nr_y', 1, A)).not.toBe(eventId('nr_x', 1, A));
  });
});

describe('тело уведомления', () => {
  // Заявка на машину: в route_title — направление, набранное человеком.
  const PD_ROW: StatusRow = {
    ...ROW, tool_name: 'request_charter', route_title: 'Ул. Тестовая, 5, кв. 7 — забрать в 6 утра',
    booking_status: 'cancelled', booking_date: '2027-07-20', booking_participants: 6, booking_tour: null,
  };

  it('ровно поля схемы; human/next — те же строки, что у get_request_status; без ПД и без страницы с ключом', () => {
    const core = buildRequestView(PD_ROW, Date.parse('2027-07-01T00:00:00Z'));
    const snapshot = snapshotOf(core, catalogTourOf(PD_ROW));
    const previous = { ...snapshot, state: 'confirmed' as const };
    const body = buildNotification({ ref: 'nr_x', tool: 'request_charter', core, snapshot, previous, observedAt: new Date('2027-07-02T03:00:00Z') });
    expect(Object.keys(body).sort()).toEqual(Object.keys(REQUEST_NOTIFICATION_SCHEMA.properties).sort());
    expect([...REQUEST_NOTIFICATION_SCHEMA.required].sort()).toEqual(Object.keys(body).sort());
    expect(body).toMatchObject({
      type: 'request.updated', ref: 'nr_x', kind: 'lead', state: 'cancelled', previous_state: 'confirmed', changed: ['state'],
      human: core.human, next: core.next, date: '2027-07-20', participants: 6, tour: null, reason: null,
      observed_at: '2027-07-02T03:00:00.000Z',
    });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/Тестовая|кв\. 7|request-status|consent|page|lead_id|\+7/);
  });

  it('база отсчёта неизвестна — previous_* null, изменилось всё, reason baseline_unknown', () => {
    const core = buildRequestView(ROW, Date.now());
    const body = buildNotification({ ref: 'nr_x', tool: 'create_booking_request', core, snapshot: snapshotOf(core, null), previous: null, observedAt: new Date() });
    expect(body).toMatchObject({ previous_state: null, previous_date: null, reason: 'baseline_unknown', changed: [...NOTIFY_CHANGED_FIELDS] });
  });
});

// ── Сверка (крон) ──────────────────────────────────────────────────────────
// Пул и отправка подложены: SQL сверки исполняется на настоящем PostgreSQL в
// tests/integration/mcp-request-status.pg.test.ts, здесь — правила прогона на
// граничных данных (график повторов, бюджеты, исходы, тело и подпись).

import {
  runRequestNotify, retryDelayMinutes, NOTIFY_MAX_FAILURES, NOTIFY_HOST_RUN_BUDGET,
  EXPIRE_SQL, RETENTION_SQL, LIVE_SQL, HOST_DAY_SQL, CLAIM_SQL, RELEASE_SQL, RESET_SQL, DELIVERED_SQL, DISABLE_SQL, RETRY_SQL,
} from '@/lib/mcp/request-notify';
import { encryptBound } from '@/lib/encryption';
import type { SendOutcome } from '@/lib/mcp/notify-send';

interface Sub {
  id: string; key_id: string; ref: string; url_enc: string | null; secret_enc: string | null; url_host: string;
  created_at: Date; expires_at: number; baseline_at: Date | null;
  last_state: string | null; last_date: string | null; last_alt_date: string | null; last_tour: string | null; last_participants: number | null;
  last_fingerprint: string | null; last_body_sha256: string | null; delivered_count: number; attempts: number;
  next_attempt_at: number | null; last_attempt_at: number | null; last_error: string | null; claimed_until: number | null;
  disabled_at: number | null; disabled_reason: string | null;
}

const MIN = 60_000;
const SIGNING = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

/** Память вместо базы: каждое выражение сверки узнаётся по своей константе. */
function fakeDb(clock: { now: number }) {
  const subs = new Map<string, Sub>();
  const views = new Map<string, StatusRow>();
  const fail = new Map<string, Error>();
  const calls: string[] = [];
  const live = (s: Sub) => s.disabled_at === null && s.expires_at > clock.now;
  const disable = (s: Sub, reason: string, err: string | null) => {
    Object.assign(s, { disabled_at: clock.now, disabled_reason: reason, url_enc: null, secret_enc: null, last_error: err, last_attempt_at: clock.now, claimed_until: null });
  };
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    const f = fail.get(sql);
    if (f) throw f;
    const ids = (params[0] ?? []) as string[];
    if (sql === EXPIRE_SQL) {
      let n = 0;
      for (const s of subs.values()) if (s.disabled_at === null && s.expires_at <= clock.now) { disable(s, 'expired', s.last_error); n++; }
      return { rows: [], rowCount: n };
    }
    if (sql === RETENTION_SQL) {
      let n = 0;
      for (const [id, s] of subs) if (s.disabled_at !== null && s.disabled_at < clock.now - Number(params[0]) * 86_400_000) { subs.delete(id); n++; }
      return { rows: [], rowCount: n };
    }
    if (sql === LIVE_SQL) {
      const rows = [...subs.values()].filter((s) => live(s) && (s.claimed_until === null || s.claimed_until < clock.now)).map((s) => ({
        ...s, next_attempt_at: s.next_attempt_at === null ? null : new Date(s.next_attempt_at),
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql === REQUEST_STATUS_BY_KEY_IDS_SQL) return { rows: ids.map((k) => views.get(k)).filter(Boolean), rowCount: 0 };
    if (sql === HOST_DAY_SQL) {
      const m = new Map<string, number>();
      for (const s of subs.values()) if (s.last_attempt_at !== null && s.last_attempt_at > clock.now - 86_400_000) m.set(s.url_host, (m.get(s.url_host) ?? 0) + 1);
      return { rows: [...m].map(([url_host, n]) => ({ url_host, n })), rowCount: m.size };
    }
    if (sql === CLAIM_SQL) {
      const rows = ids.map((id) => subs.get(id)!).filter((s) => s && s.disabled_at === null && (s.claimed_until === null || s.claimed_until < clock.now));
      for (const s of rows) s.claimed_until = clock.now + 5 * MIN;
      return { rows: rows.map((s) => ({ id: s.id, url_enc: s.url_enc, secret_enc: s.secret_enc, delivered_count: s.delivered_count })), rowCount: rows.length };
    }
    if (sql === RELEASE_SQL) { for (const id of ids) subs.get(id)!.claimed_until = null; return { rows: [], rowCount: ids.length }; }
    if (sql === RESET_SQL) { for (const id of ids) Object.assign(subs.get(id)!, { attempts: 0, next_attempt_at: null, last_error: null }); return { rows: [], rowCount: ids.length }; }
    const s = subs.get(String(params[0]));
    if (sql === DELIVERED_SQL) {
      const [, st, d, ad, tour, p, fp, bodySha] = params as [string, string, string | null, string | null, string | null, number | null, string, string];
      Object.assign(s!, {
        last_state: st, last_date: d, last_alt_date: ad, last_tour: tour, last_participants: p, last_fingerprint: fp, last_body_sha256: bodySha,
        delivered_count: s!.delivered_count + 1, attempts: 0, next_attempt_at: null, last_error: null, last_attempt_at: clock.now,
        baseline_at: s!.baseline_at ?? new Date(clock.now), claimed_until: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql === DISABLE_SQL) { if (s!.disabled_at === null) disable(s!, String(params[1]), String(params[2])); return { rows: [], rowCount: 1 }; }
    if (sql === RETRY_SQL) {
      Object.assign(s!, { attempts: s!.attempts + 1, last_error: params[1], last_attempt_at: clock.now, next_attempt_at: clock.now + Number(params[2]) * MIN, claimed_until: null });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`неизвестный запрос: ${sql.slice(0, 60)}`);
  };
  let n = 0;
  /** view — заявка и при подписке, и сейчас; change — что изменилось после подписки. */
  const add = (o: { host?: string; url?: string; view?: Partial<StatusRow>; change?: Partial<StatusRow>; baseline?: boolean; delivered?: number } = {}): Sub => {
    n++;
    const ref = `nr_${String(n).padStart(22, 'A')}`;
    const host = o.host ?? 'hooks.agent-example.ru';
    const url = o.url ?? `https://${host}/in/${n}?sig=s${n}`;
    const key_id = `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    const view: StatusRow = { ...ROW, key_id, ...o.view };
    views.set(key_id, { ...view, ...o.change });
    const sub: Sub = {
      id: `sub-${n}`, key_id, ref, url_enc: encryptBound(url, ref), secret_enc: encryptBound(SIGNING, ref), url_host: host,
      created_at: new Date(clock.now - n * 1000), expires_at: clock.now + 90 * 86_400_000, baseline_at: null,
      last_state: null, last_date: null, last_alt_date: null, last_tour: null, last_participants: null, last_fingerprint: null, last_body_sha256: null,
      delivered_count: o.delivered ?? 0, attempts: 0, next_attempt_at: null, last_attempt_at: null, last_error: null, claimed_until: null,
      disabled_at: null, disabled_reason: null,
    };
    if (o.baseline !== false) {
      const snap = snapshotOf(buildRequestView(view, clock.now), catalogTourOf(view));
      Object.assign(sub, { baseline_at: new Date(clock.now), last_state: snap.state, last_date: snap.date, last_alt_date: snap.alt_date, last_tour: snap.tour, last_participants: snap.participants, last_fingerprint: fingerprintOf(snap) });
    }
    subs.set(sub.id, sub);
    return sub;
  };
  return { subs, views, fail, calls, query, add };
}

function fakeSend(clock: { now: number }, answer: (url: string) => SendOutcome | Promise<SendOutcome>, costMs = 0) {
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const send = async (url: string, body: string, headers: Record<string, string>) => {
    sent.push({ url, body, headers });
    clock.now += costMs;
    return answer(url);
  };
  return { send, sent };
}

const OK: SendOutcome = { kind: 'delivered', code: 'http_200' };
const T0 = Date.parse('2027-07-01T00:00:00Z');

describe('сверка: изменение → одно уведомление', () => {
  it('изменилось состояние — один POST, тело без ПД, подпись проверяется независимо, лог — хост без пути', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add({ view: { tool_name: 'request_charter', route_title: 'Ул. Тестовая, 5, кв. 7' } });
    db.views.get(s.key_id)!.booking_status = 'confirmed';
    db.views.get(s.key_id)!.booking_date = '2027-07-20';
    const { send, sent } = fakeSend(clock, () => OK);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(r).toMatchObject({ status: 'ok', subscriptions_live: 1, checked: 1, changed: 1, due: 1, delivered: 1 });
    expect(sent).toHaveLength(1);
    const { url, body, headers } = sent[0]!;
    expect(url).toBe('https://hooks.agent-example.ru/in/1?sig=s1');
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ ref: s.ref, state: 'confirmed', previous_state: 'awaiting_operator', changed: ['state', 'date'], date: '2027-07-20', previous_date: null, tour: null });
    expect(body).not.toMatch(/Тестовая|кв\. 7|request-status|whsec_|consent/);
    // Подпись — независимо, по спецификации.
    const expected = `v1,${createHmac('sha256', Buffer.from(SIGNING.slice(6), 'base64')).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64')}`;
    expect(headers['webhook-signature']).toBe(expected);
    expect(headers['webhook-id']).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(headers['webhook-timestamp']).toBe(String(Math.floor(clock.now / 1000)));
    expect(headers['content-type']).toBe('application/json');
    expect(logged()).toContain(`ref=${s.ref} host=hooks.agent-example.ru исход=http_200`);
    expect(logged() + warn.mock.calls.join(' ')).not.toMatch(/\/in\/1|sig=s1/);
    expect(db.subs.get(s.id)).toMatchObject({ last_state: 'confirmed', last_date: '2027-07-20', delivered_count: 1, attempts: 0, claimed_until: null });
    expect(db.subs.get(s.id)!.last_body_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Повтор прогона без изменения — ни одного уведомления.
    const again = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(again).toMatchObject({ status: 'ok', checked: 1, changed: 0, delivered: 0 });
    expect(sent).toHaveLength(1);
  });

  it('база отсчёта не записалась — уходит текущее с reason baseline_unknown; дальше — обычная сверка', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    db.add({ baseline: false });
    const { send, sent } = fakeSend(clock, () => OK);
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(r).toMatchObject({ baseline_unknown: 1, delivered: 1 });
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ reason: 'baseline_unknown', previous_state: null, state: 'awaiting_operator' });
    expect((await runRequestNotify({ query: db.query, send, now: () => clock.now })).delivered).toBe(0);
  });

  it('другая дата у запроса мест — alt_date в теле и в changed', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const seat = { lead_id: null, seat_request_id: 'S', seat_status: 'pending' as const, deadline_at: new Date(T0 + 3_600_000), answered_at: null, seat_date: '2027-07-15', seat_participants: 2, seat_tour: 'Вулкан Горелый' };
    const s = db.add({ view: seat });
    Object.assign(db.views.get(s.key_id)!, { seat_status: 'other_date', alt_date: '2027-07-18', answered_at: new Date(T0) });
    const { send, sent } = fakeSend(clock, () => OK);
    await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ kind: 'seat_request', state: 'other_date', previous_state: 'awaiting_operator', alt_date: '2027-07-18', changed: ['state', 'alt_date'], tour: 'Вулкан Горелый' });
  });
});

describe('сверка: отказ приёмника — повтор по графику, предел — отключение', () => {
  it('график: +30 м, +1 ч, +2 ч, +4 ч, +8 ч, +16 ч; 7-я неудача — undeliverable, адрес стёрт', async () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMinutes)).toEqual([30, 60, 120, 240, 480, 960]);
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add();
    db.views.get(s.key_id)!.lead_status = 'contacted';
    const { send, sent } = fakeSend(clock, () => ({ kind: 'retry', code: 'http_503', network: false }));
    await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(db.subs.get(s.id)).toMatchObject({ attempts: 1, last_error: 'http_503', next_attempt_at: T0 + 30 * MIN });
    // До срока повтора — не шлём.
    clock.now += 10 * MIN;
    const early = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(early).toMatchObject({ changed: 1, due: 0 });
    expect(sent).toHaveLength(1);
    for (let i = 2; i <= NOTIFY_MAX_FAILURES; i++) {
      clock.now = db.subs.get(s.id)!.next_attempt_at ?? clock.now;
      await runRequestNotify({ query: db.query, send, now: () => clock.now });
    }
    expect(sent).toHaveLength(NOTIFY_MAX_FAILURES);
    expect(db.subs.get(s.id)).toMatchObject({ disabled_reason: 'undeliverable', url_enc: null, secret_enc: null });
    expect(notifyStatusOf({ ...ROW, notify_ref: s.ref, notify_disabled_reason: 'undeliverable' })).toEqual({ ref: s.ref, active: false, disabled_reason: 'undeliverable' });
  });

  it('410 — отключение сразу, адрес и ключ стёрты; больше не шлём', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add();
    db.views.get(s.key_id)!.lead_status = 'lost';
    const { send, sent } = fakeSend(clock, () => ({ kind: 'gone', code: 'http_410' }));
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(r.disabled.gone).toBe(1);
    expect(db.subs.get(s.id)).toMatchObject({ disabled_reason: 'gone', url_enc: null, secret_enc: null, last_error: 'http_410' });
    db.views.get(s.key_id)!.lead_status = 'contacted';
    await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(sent).toHaveLength(1);
  });

  it('404 — адрес не приёмник: отключение с первого ответа (наружу — undeliverable)', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add();
    db.views.get(s.key_id)!.lead_status = 'lost';
    const { send } = fakeSend(clock, () => ({ kind: 'rejected', code: 'http_404' }));
    await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(db.subs.get(s.id)).toMatchObject({ disabled_reason: 'rejected', url_enc: null });
    expect(notifyStatusOf({ ...ROW, notify_ref: s.ref, notify_disabled_reason: 'rejected' })?.disabled_reason).toBe('undeliverable');
  });

  it('адрес разрешился во внутренний — обычный повтор, а не отдельное немедленное отключение (не оракул)', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add();
    db.views.get(s.key_id)!.lead_status = 'lost';
    const { send } = fakeSend(clock, () => ({ kind: 'retry', code: 'address_refused', network: true }));
    await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(db.subs.get(s.id)).toMatchObject({ disabled_at: null, attempts: 1, last_error: 'address_refused', next_attempt_at: T0 + 30 * MIN });
  });

  it('два новых хоста глотают TCP — прогон «хорошо», попытки засчитаны каждому (критика 29.10: не 502)', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const a = db.add({ host: 'a.agent-example.ru' });
    const b = db.add({ host: 'b.agent-example.ru' });
    for (const s of [a, b]) db.views.get(s.key_id)!.lead_status = 'lost';
    const { send } = fakeSend(clock, () => ({ kind: 'retry', code: 'timeout', network: true }));
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(r.status).toBe('ok');
    expect(r.receiver_failed).toEqual({ timeout: 2 });
    for (const s of [a, b]) expect(db.subs.get(s.id)).toMatchObject({ attempts: 1, next_attempt_at: T0 + 30 * MIN });
  });

  it('пока идут повторы, снимок изменился ещё раз — новый id, previous_* от последнего доставленного; тот же снимок — тот же id', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add();
    const v = db.views.get(s.key_id)!;
    v.lead_status = 'contacted';
    let answer: SendOutcome = { kind: 'retry', code: 'http_503', network: false };
    const { send, sent } = fakeSend(clock, () => answer);
    await runRequestNotify({ query: db.query, send, now: () => clock.now });
    clock.now = db.subs.get(s.id)!.next_attempt_at!;
    await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(sent[1]!.headers['webhook-id']).toBe(sent[0]!.headers['webhook-id']);
    v.lead_status = 'lost';
    clock.now = db.subs.get(s.id)!.next_attempt_at!;
    answer = OK;
    await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(sent[2]!.headers['webhook-id']).not.toBe(sent[1]!.headers['webhook-id']);
    expect(JSON.parse(sent[2]!.body)).toMatchObject({ state: 'declined', previous_state: 'awaiting_operator' });
  });

  it('снимок вернулся к доставленному, пока шли повторы — ждать нечего: попытки сброшены, POST нет', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add();
    const v = db.views.get(s.key_id)!;
    v.lead_status = 'contacted';
    const { send, sent } = fakeSend(clock, () => ({ kind: 'retry', code: 'http_503', network: false }));
    await runRequestNotify({ query: db.query, send, now: () => clock.now });
    v.lead_status = 'new';
    clock.now += 31 * MIN;
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(r).toMatchObject({ changed: 0, reset_reverted: 1 });
    expect(sent).toHaveLength(1);
    expect(db.subs.get(s.id)).toMatchObject({ attempts: 0, next_attempt_at: null });
  });
});

describe('сверка: бюджеты — один хост не съедает прогон', () => {
  it('30 подписок одного хоста, хост висит: уходит один запрос, остальное — в следующий прогон', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    for (let i = 0; i < 30; i++) db.add({ host: 'slow.agent-example.ru', change: { lead_status: 'lost' } });
    const { send, sent } = fakeSend(clock, () => ({ kind: 'retry', code: 'timeout', network: true }), 10_000);
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(sent).toHaveLength(1);
    expect(r.deferred).toMatchObject({ host_failed: NOTIFY_HOST_RUN_BUDGET - 1, host_run_budget: 30 - NOTIFY_HOST_RUN_BUDGET });
    expect(clock.now - T0).toBeLessThanOrEqual(10_000);
    // Отложенные не наказаны попыткой и не держат захват.
    expect([...db.subs.values()].filter((s) => s.attempts > 0)).toHaveLength(1);
    expect([...db.subs.values()].filter((s) => s.claimed_until !== null)).toHaveLength(0);
  });

  it('хосты по кругу: у каждого не больше трёх за прогон; срок прогона — новые отправки не начинаются', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    for (const h of ['a', 'b']) for (let i = 0; i < 5; i++) db.add({ host: `${h}.agent-example.ru`, change: { lead_status: 'lost' } });
    const { send, sent } = fakeSend(clock, () => OK);
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(r.delivered).toBe(6);
    expect(sent.filter((x) => x.url.includes('://a.')).length).toBe(3);
    expect(r.deferred.host_run_budget).toBe(4);

    const clock2 = { now: T0 };
    const db2 = fakeDb(clock2);
    for (let i = 0; i < 12; i++) db2.add({ host: `h${i}.agent-example.ru`, change: { lead_status: 'lost' } });
    const slow = fakeSend(clock2, () => OK, 20_000);
    const r2 = await runRequestNotify({ query: db2.query, send: slow.send, now: () => clock2.now, timeBudgetMs: 45_000 });
    expect(r2.deferred.time_budget).toBeGreaterThan(0);
    expect(slow.sent.length + r2.deferred.time_budget).toBe(12);
  });

  it('суточный бюджет хоста исчерпан — отправки нет, отложено', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    for (let i = 0; i < 60; i++) {
      const s = db.add({ host: 'busy.agent-example.ru' });
      s.last_attempt_at = T0 - 3_600_000;
    }
    const fresh = db.add({ host: 'busy.agent-example.ru', change: { lead_status: 'lost' } });
    const { send, sent } = fakeSend(clock, () => OK);
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(sent).toHaveLength(0);
    expect(r.deferred.host_day_budget).toBe(1);
    expect(db.subs.get(fresh.id)!.attempts).toBe(0);
  });
});

describe('сверка: исходы прогона и хранение', () => {
  it('нет ENCRYPTION_KEY при живых подписках — «не смог», подписки не тронуты', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add({ change: { lead_status: 'lost' } });
    delete process.env.ENCRYPTION_KEY;
    const { send, sent } = fakeSend(clock, () => OK);
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(r.status).toBe('no_encryption');
    expect(sent).toHaveLength(0);
    expect(db.subs.get(s.id)).toMatchObject({ disabled_at: null, attempts: 0 });
  });

  it('строка не расшифровалась при заданном ключе — отключена undecryptable, наружу vedar_failure', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add({ change: { lead_status: 'lost' } });
    s.url_enc = encryptBound('https://other.agent-example.ru/x', 'nr_ЧУЖОЙ');
    const { send, sent } = fakeSend(clock, () => OK);
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(r).toMatchObject({ status: 'ok' });
    expect(r.disabled.undecryptable).toBe(1);
    expect(sent).toHaveLength(0);
    expect(db.subs.get(s.id)!.disabled_reason).toBe('undecryptable');
    expect(notifyStatusOf({ ...ROW, notify_ref: s.ref, notify_disabled_reason: 'undecryptable' })?.disabled_reason).toBe('vedar_failure');
  });

  it('SQL упал — db_error с SQLSTATE; текста ошибки (в нём бывает хост) в результате нет', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    db.add({ change: { lead_status: 'lost' } });
    db.fail.set(LIVE_SQL, Object.assign(new Error('invalid input value "https://hooks.agent-example.ru/in"'), { code: '22P02' }));
    const r = await runRequestNotify({ query: db.query, send: fakeSend(clock, () => OK).send, now: () => clock.now });
    expect(r).toMatchObject({ status: 'db_error', sqlstate: '22P02' });
    expect(JSON.stringify(r)).not.toMatch(/hooks|invalid input/);
    expect(logged()).toContain('SQLSTATE=22P02');
    expect(logged()).not.toMatch(/hooks\.agent-example/);
  });

  it('исход доставки не записался — прогон называет db_error, отправка не повторяется в этом прогоне', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    db.add({ change: { lead_status: 'lost' } });
    db.fail.set(DELIVERED_SQL, Object.assign(new Error('x'), { code: '40001' }));
    const { send, sent } = fakeSend(clock, () => OK);
    const r = await runRequestNotify({ query: db.query, send, now: () => clock.now });
    expect(r).toMatchObject({ status: 'db_error', sqlstate: '40001', record_failed: 1 });
    expect(sent).toHaveLength(1);
  });

  it('истекла — отключена expired, адрес стёрт; через 30 дней после отключения строка удалена', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add();
    s.expires_at = T0 - 1;
    const r = await runRequestNotify({ query: db.query, send: fakeSend(clock, () => OK).send, now: () => clock.now });
    expect(r.disabled.expired).toBe(1);
    expect(db.subs.get(s.id)).toMatchObject({ disabled_reason: 'expired', url_enc: null, secret_enc: null });
    clock.now += 31 * 86_400_000;
    const later = await runRequestNotify({ query: db.query, send: fakeSend(clock, () => OK).send, now: () => clock.now });
    expect(later.deleted_after_retention).toBe(1);
    expect(db.subs.has(s.id)).toBe(false);
  });

  it('строку держит другой прогон — не шлём её второй раз', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    const s = db.add({ change: { lead_status: 'lost' } });
    const { send, sent } = fakeSend(clock, () => OK);
    const realQuery = db.query;
    const q = async (sql: string, params?: unknown[]) => {
      if (sql === CLAIM_SQL) db.subs.get(s.id)!.claimed_until = clock.now + 60_000;
      return realQuery(sql, params);
    };
    const r = await runRequestNotify({ query: q, send, now: () => clock.now });
    expect(r.deferred.claimed_elsewhere).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('ответ прогона — только числа и коды: ни хоста, ни адреса', async () => {
    const clock = { now: T0 };
    const db = fakeDb(clock);
    db.add({ change: { lead_status: 'lost' } });
    const r = await runRequestNotify({ query: db.query, send: fakeSend(clock, () => ({ kind: 'retry', code: 'tls', network: true })).send, now: () => clock.now });
    expect(JSON.stringify(r)).not.toMatch(/agent-example|https?:|\/in\//);
  });
});

// ── Объявление (правило 10.09: объявленное — с производителем и потребителем) ──
import { PUBLIC_MCP_TOOLS, PARAM_ENGLISH, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { NOTIFY_TOOL_NAMES, NOTIFY_URL_PROPERTY, NOTIFY_TOOL_PHRASE, NOTIFY_DISABLED_REASONS } from '@/lib/mcp/request-notify-schema';
import { GET_REQUEST_STATUS_TOOL, NOTIFY_PUBLIC_REASONS } from '@/lib/mcp/request-status-schema';
import { readFileSync } from 'node:fs';

describe('объявление notify_url', () => {
  it('поле есть ровно у четырёх инструментов уведомлений — у жилья нет; описание и английский слой называют его', () => {
    const withField = PUBLIC_MCP_TOOLS.filter((t) => (t.inputSchema as { properties?: Record<string, unknown> }).properties?.notify_url).map((t) => t.name);
    expect(withField.sort()).toEqual([...NOTIFY_TOOL_NAMES].sort());
    for (const name of NOTIFY_TOOL_NAMES) {
      const t = PUBLIC_MCP_TOOLS.find((x) => x.name === name)!;
      expect(t.description, name).toContain(NOTIFY_TOOL_PHRASE.trim());
      const prop = (t.inputSchema as { properties: Record<string, { type: string; description: string }> }).properties.notify_url;
      expect(prop.type).toBe(NOTIFY_URL_PROPERTY.type);
      expect(prop.description).toContain(NOTIFY_URL_PROPERTY.description);
      expect(PARAM_ENGLISH[name]?.notify_url?.lead, name).toMatch(/Standard Webhooks/);
      expect(PARAM_ENGLISH[name]?.notify_url?.lead, name).not.toMatch(/\b(secret|token|password)\b/i);
      // В обязательных поле не стоит: старые агенты не ломаются.
      expect((t.inputSchema as { required: string[] }).required).not.toContain('notify_url');
    }
  });

  it('get_request_status объявляет notify и requested_date; словарь причин наружу — подмножество внутреннего', () => {
    const props = GET_REQUEST_STATUS_TOOL.outputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('notify');
    expect(props).toHaveProperty('requested_date');
    expect(GET_REQUEST_STATUS_TOOL.description).toMatch(/notify_url/);
    expect(GET_REQUEST_STATUS_TOOL.description).toMatch(/requested_date/);
    expect(NOTIFY_PUBLIC_REASONS).not.toContain('expired');
    expect(NOTIFY_PUBLIC_REASONS).not.toContain('address_refused');
    // Каждая внутренняя причина CHECK миграции 1348 переводится в слово наружу.
    const migration = readFileSync('migrations/1348_agent_request_notify.sql', 'utf8');
    for (const r of NOTIFY_DISABLED_REASONS) {
      expect(migration).toContain(`'${r}'`);
      expect(NOTIFY_PUBLIC_REASONS).toContain(notifyStatusOf({ ...ROW, notify_ref: 'nr_a', notify_disabled_reason: r })!.disabled_reason);
    }
  });

  it('версия MCP — в коде и в server.json одна, 2.8.0 (новое поле на входе и в ответе)', () => {
    const manifest = JSON.parse(readFileSync('server.json', 'utf8')) as { version: string };
    expect(MCP_SERVER_INFO.version).toBe('2.8.0');
    expect(manifest.version).toBe(MCP_SERVER_INFO.version);
  });
});
