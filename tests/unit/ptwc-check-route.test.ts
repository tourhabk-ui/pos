// @vitest-environment node
/**
 * /api/cron/ptwc-check — второй свидетель цунами, который ничего не решает
 * за официальную тревогу.
 *
 * Держит связку (вызовом роута с подложенными источником, базой и Telegram):
 *   - PTWC видит угрозу точкам края, официальной тревоги в ленте нет →
 *     дежурный разбужен один раз на бюллетень, запись в журнале решений;
 *   - официальная тревога есть → дежурного не будят (он и так знает);
 *   - PTWC не прочитан → 502 и `failed`, а не «угрозы нет»;
 *   - ни при каком исходе роут не пишет и не снимает `tsunami_warning`;
 *   - недоставленная тревога в журнал не ложится — следующий прогон повторит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { PtwcRead } from '@/lib/services/safety/ptwc';

const poolQuery = vi.fn();
const recordCronRun = vi.fn();
const recordSourceHealth = vi.fn(async () => {});
const appendSafetyEvent = vi.fn(async () => ({ ok: true, id: 1 }));
const tgSend = vi.fn(async () => ({ ok: true }));
const loadPtwcLatest = vi.fn<() => Promise<PtwcRead>>();

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: (...a: unknown[]) => recordCronRun(...a) }));
vi.mock('@/lib/agents/cron-lease', async (orig) => ({
  ...(await orig<typeof import('@/lib/agents/cron-lease')>()),
  claimCronWindow: async () => 'claimed',
}));
vi.mock('@/lib/services/safety/source-health', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/safety/source-health')>()),
  recordSourceHealth: (...a: unknown[]) => recordSourceHealth(...a),
}));
vi.mock('@/lib/safety/ledger', async (orig) => ({
  ...(await orig<typeof import('@/lib/safety/ledger')>()),
  appendSafetyEvent: (...a: unknown[]) => appendSafetyEvent(...a),
}));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgSend(...a) }));
vi.mock('@/lib/services/safety/ptwc', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/safety/ptwc')>()),
  loadPtwcLatest: () => loadPtwcLatest(),
}));

process.env.CRON_SECRET = 'test-cron-secret';

const PKC = { name: 'PETROPAVLOVSK', region: 'RUSSIA', lat: 53.2, lon: 159.6, etaAt: '2025-07-29T23:58:00.000Z' };
const UKAM = { name: 'UST KAMCHATSK', region: 'RUSSIA', lat: 56.1, lon: 162.6, etaAt: '2025-07-30T00:12:00.000Z' };

function threatRead(): PtwcRead {
  return {
    kind: 'ok',
    verdict: 'threat_to_krai',
    index: {
      eventDir: '/events/PHEB/2025/07/29/25210000/2/WEPA40/', twcEventId: '25210000', bulletinNr: 2,
      issuedAt: '2025-07-30T00:16:00.000Z', originTime: '2025-07-29T23:25:00.000Z', magnitude: 8.7,
      lat: 52.2, lon: 160, location: 'OFF THE EAST COAST OF KAMCHATKA RUSSIA',
      messageUrl: 'https://www.tsunami.gov/events/PHEB/2025/07/29/25210000/2/WEPA40/WEPA40.txt',
    },
    message: {
      kind: 'threat', messageNumber: 2, issuedAt: '2025-07-30T00:16:00.000Z', magnitude: 8.7,
      originTime: '2025-07-29T23:25:00.000Z', location: 'OFF THE EAST COAST OF KAMCHATKA RUSSIA',
      threatPassed: false, russiaBand: 'gt3', russiaPreliminary: false,
      etas: [PKC, UKAM], kraiPoints: [PKC, UKAM],
    },
  };
}

async function call(secret = 'test-cron-secret') {
  const { GET } = await import('@/app/api/cron/ptwc-check/route');
  const req = new NextRequest('http://localhost/api/cron/ptwc-check', { headers: { authorization: `Bearer ${secret}` } });
  const res = await GET(req);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** Ответы базы по форме запроса: лента тревог и журнал — раздельно. */
function dbAnswers(opts: { official: 'live' | 'none' | 'down'; noted: boolean }) {
  poolQuery.mockImplementation(async (sql: string) => {
    if (/FROM external_alerts/.test(sql)) {
      if (opts.official === 'down') throw new Error('connection refused');
      return { rows: opts.official === 'live' ? [{ '?column?': 1 }] : [] };
    }
    if (/FROM safety_decision_events/.test(sql)) return { rows: opts.noted ? [{ '?column?': 1 }] : [] };
    throw new Error(`неожиданный запрос: ${sql}`);
  });
}

function writesToAlerts(): boolean {
  return poolQuery.mock.calls.some(([sql]) => /INSERT INTO external_alerts|UPDATE external_alerts|DELETE FROM external_alerts/.test(String(sql)));
}

beforeEach(() => {
  poolQuery.mockReset();
  recordCronRun.mockReset();
  recordSourceHealth.mockClear();
  appendSafetyEvent.mockClear();
  tgSend.mockClear();
  tgSend.mockResolvedValue({ ok: true });
  loadPtwcLatest.mockReset();
});

describe('без секрета', () => {
  it('401, ни похода к PTWC, ни отметки', async () => {
    const { status } = await call('wrong');
    expect(status).toBe(401);
    expect(loadPtwcLatest).not.toHaveBeenCalled();
    expect(recordCronRun).not.toHaveBeenCalled();
  });
});

describe('угроза точкам края без официальной тревоги', () => {
  it('дежурный разбужен, бюллетень записан в журнал, tsunami_warning не тронут', async () => {
    loadPtwcLatest.mockResolvedValue(threatRead());
    dbAnswers({ official: 'none', noted: false });
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, verdict: 'threat_to_krai', official_alert: 'none', duty_alert: 'sent' });

    expect(tgSend).toHaveBeenCalledTimes(1);
    const [scope, text] = tgSend.mock.calls[0] as unknown as [string, string];
    expect(scope).toBe('ptwc-check');
    expect(text).toContain('сообщение №2 от 00:16 UTC 30.07 (12:16 по Камчатке 30.07)');
    expect(text).toContain('M8.7');
    expect(text).toContain('более 3 м');
    expect(text).toContain('Петропавловск-Камчатский 23:58 UTC 29.07 (11:58 по Камчатке 30.07)');
    // Бессрочная официальная тревога — действующая: предикат ленты не теряет NULL.
    const alertsSql = String(poolQuery.mock.calls.find(([sql]) => /FROM external_alerts/.test(String(sql)))?.[0]);
    expect(alertsSql).toMatch(/expires_at IS NULL OR expires_at >/);
    expect(recordSourceHealth.mock.calls[0][1]).toMatchObject([{ label: 'PTWC — тихоокеанский центр цунами (tsunami.gov)' }]);
    expect(text).toContain('официальной тревоги цунами НЕТ');
    expect(text).toContain('не замена официальной тревоги');

    expect(appendSafetyEvent).toHaveBeenCalledTimes(1);
    expect(appendSafetyEvent.mock.calls[0][0]).toMatchObject({
      eventType: 'source_observed', actorType: 'source', actorId: 'ptwc', entityId: null,
      details: { event: '25210000', bulletin: 2, official_alert: 'none' },
    });
    expect(writesToAlerts()).toBe(false);
    expect(recordSourceHealth.mock.calls[0][1]).toMatchObject([{ key: 'ptwc', status: 'ok', rawItems: 1, aliveBy: 'raw_items' }]);
    expect(recordCronRun).toHaveBeenCalledWith('ptwc-check', expect.any(Number), 'success', { items: 2 });
  });

  it('тот же бюллетень во второй раз — дежурного не будят повторно', async () => {
    loadPtwcLatest.mockResolvedValue(threatRead());
    dbAnswers({ official: 'none', noted: true });
    const { body } = await call();
    expect(body.duty_alert).toBe('already_noted');
    expect(tgSend).not.toHaveBeenCalled();
    expect(appendSafetyEvent).not.toHaveBeenCalled();
  });

  it('Telegram не доставил — в журнал не ложится, следующий прогон повторит', async () => {
    loadPtwcLatest.mockResolvedValue(threatRead());
    dbAnswers({ official: 'none', noted: false });
    tgSend.mockResolvedValue({ ok: false, reason: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы' } as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { body } = await call();
    expect(body.duty_alert).toBe('not_sent');
    expect(appendSafetyEvent).not.toHaveBeenCalled();
    expect(err.mock.calls.some(([m]) => String(m).includes('дежурный не разбужен'))).toBe(true);
    err.mockRestore();
  });

  it('ленту прочитать не удалось — будят всё равно, и в тексте так и сказано', async () => {
    loadPtwcLatest.mockResolvedValue(threatRead());
    dbAnswers({ official: 'down', noted: false });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { body } = await call();
    expect(body).toMatchObject({ official_alert: 'unknown', duty_alert: 'sent' });
    expect(String(tgSend.mock.calls[0][1])).toContain('Нашу ленту прочитать не удалось');
    expect(appendSafetyEvent.mock.calls[0][0]).toMatchObject({ details: { official_alert: 'unknown' } });
    err.mockRestore();
  });
});

describe('официальная тревога уже есть', () => {
  it('дежурного не будят, журнал не пишут', async () => {
    loadPtwcLatest.mockResolvedValue(threatRead());
    dbAnswers({ official: 'live', noted: false });
    const { body } = await call();
    expect(body).toMatchObject({ official_alert: 'live', duty_alert: 'official_live' });
    expect(tgSend).not.toHaveBeenCalled();
    expect(appendSafetyEvent).not.toHaveBeenCalled();
    expect(writesToAlerts()).toBe(false);
  });
});

describe('края не касается', () => {
  it('старый бюллетень — успех без тревоги, ленту даже не спрашивают', async () => {
    const read = threatRead();
    loadPtwcLatest.mockResolvedValue({ kind: 'ok', index: read.index, message: null, verdict: 'stale' } as PtwcRead);
    const { body } = await call();
    expect(body).toMatchObject({ success: true, verdict: 'stale', official_alert: null, duty_alert: null, message: null });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(tgSend).not.toHaveBeenCalled();
    expect(recordCronRun).toHaveBeenCalledWith('ptwc-check', expect.any(Number), 'success', { items: 0 });
  });

  it('угроза снята центром или точек края нет — без тревоги', async () => {
    const read = threatRead();
    loadPtwcLatest.mockResolvedValue({ ...read, verdict: 'passed' } as PtwcRead);
    expect((await call()).body).toMatchObject({ verdict: 'passed', duty_alert: null });
    loadPtwcLatest.mockResolvedValue({ ...read, verdict: 'no_krai_threat' } as PtwcRead);
    expect((await call()).body).toMatchObject({ verdict: 'no_krai_threat', duty_alert: null });
    expect(tgSend).not.toHaveBeenCalled();
  });
});

describe('PTWC не прочитан', () => {
  it('502, failed, здоровье источника error с причиной; тревоги нет, tsunami_warning не тронут', async () => {
    loadPtwcLatest.mockResolvedValue({ kind: 'failed', reason: 'HTTP 503 https://www.tsunami.gov/events/json/PHEBWEPA40.json', index: null });
    const { status, body } = await call();
    expect(status).toBe(502);
    expect(body).toMatchObject({ success: false, error: expect.stringContaining('HTTP 503') });
    expect(recordSourceHealth.mock.calls[0][1]).toMatchObject([{ key: 'ptwc', status: 'error', rawItems: 0, error: expect.stringContaining('HTTP 503') }]);
    expect(recordCronRun).toHaveBeenCalledWith('ptwc-check', expect.any(Number), 'failed', { error: expect.stringContaining('PTWC не прочитан') });
    expect(tgSend).not.toHaveBeenCalled();
    expect(writesToAlerts()).toBe(false);
  });
});

describe('роут только читает', () => {
  it('в исходнике нет записи в external_alerts', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/api/cron/ptwc-check/route.ts', 'utf8');
    expect(src).not.toMatch(/INSERT INTO external_alerts|UPDATE external_alerts|DELETE FROM external_alerts/);
    expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });
});
