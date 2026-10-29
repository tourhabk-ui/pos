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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { subscribeNotify, notifyLine, snapshotOf, fingerprintOf, changedFields, type SubscribeOutcome } from '@/lib/mcp/request-notify';
import { notifyStatusOf, REQUEST_STATUS_BY_KEY_IDS_SQL, type StatusRow, type RequestCore } from '@/lib/mcp/request-status';
import { NOTIFY_CHANGED_FIELDS } from '@/lib/mcp/request-notify-schema';
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
