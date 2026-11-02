/**
 * Обстановка на день выезда (#2969, 03.11) — суждение, слова и крон вызовом.
 *
 * Держит:
 *  - три исхода: риск (что именно), «не смог проверить» (что именно),
 *    «спокойно» — только когда проверено всё;
 *  - туристу — только при риске, без совета отменить; повтор — только при
 *    изменении; без канала — «нет канала» в журнал, а не тишина;
 *  - оператору — при риске, решение за ним;
 *  - строка в «Сегодня» оператора есть всегда: и «спокойно», и «не проверялась»,
 *    и «не прочиталась».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  judgeSituation, situationLine, situationFingerprint, touristSituationText, operatorSituationText,
} from '@/lib/trips/situation';
import { departureSituationLine, todayScreen } from '@/lib/chat-cabinet/screens';

const alert = (over: Record<string, unknown> = {}) => ({
  id: 1, alert_type: 'weather', severity: 2, title: 'Штормовое предупреждение: ветер до 25 м/с',
  description: null, affected_zones: ['avachinsky'], expires_at: '2099-11-06T00:00:00Z', source_url: null, ...over,
});

describe('judgeSituation — три исхода', () => {
  it('опасная погода и предупреждение по зоне — риск, по пункту на источник', () => {
    const s = judgeSituation({
      weather: { kind: 'hazard', labels: ['ветер до 72 км/ч'] },
      officials: [alert()], officialsUnassessed: false,
      zoneDanger: { name: 'Авачинская группа', level: 'high' },
    });
    expect(s.kind).toBe('risk');
    expect(situationLine(s)).toBe('есть риски — погода: ветер до 72 км/ч; официальное предупреждение: Штормовое предупреждение: ветер до 25 м/с; опасность в зоне «Авачинская группа»: высокая.');
  });
  it('источник погоды не ответил — «не смог проверить погоду», а не «спокойно»', () => {
    const s = judgeSituation({ weather: { kind: 'unknown', reason: 'прогноз не загрузился (timeout)' }, officials: [], officialsUnassessed: false, zoneDanger: null });
    expect(s.kind).toBe('unknown');
    expect(situationLine(s)).toMatch(/^опасного не найдено, но не смог проверить погоду — прогноз не загрузился/);
    expect(situationLine(s)).not.toMatch(/спокойно/);
  });
  it('нет координат, лента не прочиталась, зона не прочиталась — каждое названо', () => {
    const s = judgeSituation({ weather: null, officials: 'failed', officialsUnassessed: false, zoneDanger: 'failed' });
    expect(s).toEqual({ kind: 'unknown', risks: [], unchecked: [
      'погоду — у тура не записаны координаты',
      'официальные предупреждения — лента не прочиталась',
      'оценку опасности зоны — не прочиталась',
    ] });
  });
  it('риск при частичной непроверке — риск, и непроверенное дописано', () => {
    const s = judgeSituation({ weather: { kind: 'fog' }, officials: 'failed', officialsUnassessed: false, zoneDanger: null });
    expect(s.kind).toBe('risk');
    expect(situationLine(s)).toBe('есть риски — погода: туман. Не проверено: официальные предупреждения — лента не прочиталась.');
  });
  it('спокойно — только когда проверено всё; умеренная опасность зоны — не риск', () => {
    const s = judgeSituation({ weather: { kind: 'calm', description: 'облачно' }, officials: [], officialsUnassessed: false, zoneDanger: { name: 'Север', level: 'moderate' } });
    expect(s.kind).toBe('calm');
    expect(situationLine(s)).toMatch(/^спокойно/);
    expect(judgeSituation({ weather: { kind: 'calm', description: 'ясно' }, officials: [], officialsUnassessed: true, zoneDanger: null }).kind).toBe('unknown');
  });
  it('отпечаток меняется только с тем, что говорится человеку', () => {
    const a = judgeSituation({ weather: { kind: 'hazard', labels: ['ветер до 72 км/ч'] }, officials: [], officialsUnassessed: false, zoneDanger: null });
    const b = judgeSituation({ weather: { kind: 'hazard', labels: ['ветер до 80 км/ч'] }, officials: [], officialsUnassessed: false, zoneDanger: null });
    expect(situationFingerprint(a)).not.toBe(situationFingerprint(b));
    expect(situationFingerprint(a)).toBe(situationFingerprint({ ...a }));
  });
});

describe('слова туристу и оператору', () => {
  const s = judgeSituation({ weather: { kind: 'hazard', labels: ['ветер до 72 км/ч'] }, officials: [], officialsUnassessed: false, zoneDanger: null });
  it('туристу — факты, решает оператор, 112; совета отменить нет', () => {
    const t = touristSituationText({ tourTitle: 'Авачинский', date: '2099-11-05', situation: s });
    expect(t).toMatch(/^Поездка «Авачинский» 05\.11: по данным Ведара есть риски — погода: ветер до 72 км\/ч\./);
    expect(t).toMatch(/Решение о выезде принимает оператор тура/);
    expect(t).toMatch(/112/);
    expect(t).not.toMatch(/отмени|перенес|безопасн/i);
  });
  it('оператору — решение за ним; сказано, ушло ли туристам', () => {
    const o = operatorSituationText({ tourTitle: 'Авачинский', date: '2099-11-05', situation: s, travellers: 3, touristsInformed: 2 });
    expect(o).toMatch(/^Выезд «Авачинский» 05\.11 \(броней и заявок: 3\): есть риски/);
    expect(o).toMatch(/Решение о выезде — за вами: Ведар ничего не отменяет и не переносит\./);
    expect(o).toMatch(/ушла: 2/);
    expect(operatorSituationText({ tourTitle: 'А', date: '2099-11-05', situation: s, travellers: 1, touristsInformed: 0 })).toMatch(/ничего не отправил/);
  });
});

describe('«Сегодня» оператора: строка обстановки на каждый выезд — всегда', () => {
  const inbox = { items: [], failed: [] } as never;
  const base = { inbox, today: '2099-11-04', tomorrow: '2099-11-05', nowMs: Date.parse('2099-11-04T00:00:00Z') };
  it('риск, спокойно, не проверялась — по строке на выезд, с временем проверки', () => {
    const screen = todayScreen({ ...base, departures: [
      { date: '2099-11-04', tourId: 1, title: 'Авачинский', people: 4, bookings: 2, situation: { kind: 'risk', line: 'есть риски — погода: ветер до 72 км/ч.', checkedAt: '2099-11-03 05:00:00+00' } },
      { date: '2099-11-05', tourId: 2, title: 'Мутновский', people: 2, bookings: 1, situation: { kind: 'calm', line: 'спокойно: в прогнозе нет опасной погоды.', checkedAt: '2099-11-03T05:00:00Z' } },
      { date: '2099-11-05', tourId: 3, title: 'Рыбалка', people: 1, bookings: 1, situation: null },
    ] });
    const text = screen.text;
    expect(text).toContain('— обстановка «Авачинский»: есть риски — погода: ветер до 72 км/ч. (проверено 03.11 17:00 по Камчатке)');
    expect(text).toContain('— обстановка «Мутновский»: спокойно');
    expect(text).toContain('— обстановка «Рыбалка»: не проверялась.');
    expect(text.indexOf('обстановка «Авачинский»')).toBeLessThan(text.indexOf('Завтра'));
  });
  it('обстановка не прочиталась — так и сказано у каждого выезда', () => {
    const screen = todayScreen({ ...base, situationsFailed: true, departures: [{ date: '2099-11-04', tourId: 1, title: 'Авачинский', people: 4, bookings: 2 }] });
    expect(screen.text).toContain('— обстановка «Авачинский»: не прочиталась, это не «спокойно».');
  });
  it('название тура экранируется', () => {
    expect(departureSituationLine({ date: 'x', title: '<b>X</b>', people: 1, bookings: 1, situation: null }, false)).toContain('«&lt;b&gt;X&lt;/b&gt;»');
  });
});

// ── Крон trip-reminders вызовом ─────────────────────────────────────────────

const store = vi.hoisted(() => ({
  tours: [] as unknown[],
  recipients: [] as unknown[],
  last: new Map<string, string>(),
  notices: [] as Array<Record<string, unknown>>,
  saved: [] as unknown[],
  forecast: null as unknown,
}));
vi.mock('@/lib/trips/situation-store', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/trips/situation-store')>();
  return {
    ...orig,
    loadDepartingTours: vi.fn(async () => store.tours),
    loadTouristRecipients: vi.fn(async () => store.recipients),
    saveSituation: vi.fn(async (...a: unknown[]) => { store.saved.push(a); }),
    lastSentFingerprint: vi.fn(async (k: string, r: string) => store.last.get(`${k}|${r}`) ?? null),
    logNotice: vi.fn(async (n: Record<string, unknown>) => { store.notices.push(n); }),
    liveSources: () => ({
      forecast: async () => store.forecast,
      officials: async () => [],
      zone: async () => null,
    }),
  };
});
const tgSend = vi.fn(async () => ({ ok: true }));
const maxSendDm = vi.fn(async () => ({ ok: true }));
const sendPdAlert = vi.fn(async () => ({ channel: 'max', delivered: true, reason: 'ok' }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgSend(...(a as [])) }));
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: (...a: unknown[]) => maxSendDm(...(a as [])) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => sendPdAlert(...(a as [])) }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: async () => ({ reachable: true, maxChatId: '77', telegramChatId: null }) }));
const runs: unknown[] = [];
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: (...a: unknown[]) => { runs.push(a); } }));

const NOW = new Date('2099-11-03T05:00:00Z'); // 17:00 по Камчатке 03.11 → послезавтра 05.11
const tour = (over: Record<string, unknown> = {}) => ({
  tourId: 36, date: '2099-11-05', title: 'Авачинский', operatorId: 'op-1', activityType: 'hiking', locationType: 'volcano',
  zone: 'avachinsky', lat: 53.25, lng: 158.83, travellers: 2, ...over,
});
const forecast = (windKmh: number | null) => ({ ok: true, days: [{ date: '2099-11-05', weatherCode: 3, windKmh, description: 'облачно' }] });

async function runCron() {
  process.env.CRON_SECRET = 's3cret';
  const { GET } = await import('@/app/api/cron/trip-reminders/route');
  const res = await GET(new Request('http://localhost/api/cron/trip-reminders', { headers: { Authorization: 'Bearer s3cret' } }) as never);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('крон trip-reminders: туристу и оператору — только при риске', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    store.tours = [tour()];
    store.recipients = [
      { kind: 'tourist_booking', ref: 'b1', tourId: 36, channel: 'max', chatId: '501' },
      { kind: 'tourist_lead', ref: 'l1', tourId: 36, channel: null, chatId: null },
    ];
    store.last.clear(); store.notices = []; store.saved = []; runs.length = 0;
    tgSend.mockClear(); maxSendDm.mockClear(); sendPdAlert.mockClear();
  });

  it('ветер 72 км/ч послезавтра: туристу в MAX и оператору — «есть риски»; без канала — в журнал', async () => {
    store.forecast = forecast(72);
    const { status, body } = await runCron();
    vi.useRealTimers();
    expect(status).toBe(200);
    expect(body).toMatchObject({ dates: { tomorrow: '2099-11-04', target: '2099-11-05' }, tourists_sent: 1, no_channel: 1, operators_sent: 1 });
    expect(maxSendDm).toHaveBeenCalledWith('501', expect.stringContaining('есть риски — погода: ветер до 72 км/ч'));
    expect(sendPdAlert.mock.calls[0]![0]).toMatchObject({ to: { maxChatId: '77' } });
    expect(String((sendPdAlert.mock.calls[0]![0] as { text: string }).text)).toMatch(/Решение о выезде — за вами/);
    expect(store.notices.map((n) => [n.kind, n.outcome])).toEqual([
      ['tourist_booking', 'sent'], ['tourist_lead', 'no_channel'], ['operator', 'sent'],
    ]);
    expect(store.saved).toHaveLength(1);
  });

  it('прогноз не ответил: туристу ничего, в журнал «не риск», строка для оператора записана', async () => {
    store.forecast = { ok: false, reason: 'timeout' };
    const { body } = await runCron();
    vi.useRealTimers();
    expect(body).toMatchObject({ tourists_sent: 0, operators_sent: 0, situations: { unknown: 1 } });
    expect(maxSendDm).not.toHaveBeenCalled();
    expect(sendPdAlert).not.toHaveBeenCalled();
    const saved = store.saved[0] as [number, string, { kind: string; unchecked: string[] }];
    expect(saved[2].kind).toBe('unknown');
    expect(saved[2].unchecked[0]).toMatch(/^погоду — прогноз не загрузился/);
    expect(store.notices.every((n) => n.outcome === 'not_risk')).toBe(true);
  });

  it('спокойно: туристу и оператору не шлём', async () => {
    store.forecast = forecast(10);
    const { body } = await runCron();
    vi.useRealTimers();
    expect(body).toMatchObject({ tourists_sent: 0, operators_sent: 0, situations: { calm: 1 } });
    expect(maxSendDm).not.toHaveBeenCalled();
  });

  it('повтор без изменений не отправляется', async () => {
    store.forecast = forecast(72);
    const { judgeSituation: j, situationFingerprint: f } = await import('@/lib/trips/situation');
    const fp = f(j({ weather: { kind: 'hazard', labels: ['ветер до 72 км/ч'] }, officials: [], officialsUnassessed: false, zoneDanger: null }));
    store.last.set('tourist_booking|b1', fp);
    store.last.set('operator|op-1:36', fp);
    const { body } = await runCron();
    vi.useRealTimers();
    expect(body).toMatchObject({ tourists_sent: 0, unchanged: 1, operators_sent: 0 });
    expect(maxSendDm).not.toHaveBeenCalled();
    expect(sendPdAlert).not.toHaveBeenCalled();
  });

  it('без секрета — 401', async () => {
    vi.useRealTimers();
    const { GET } = await import('@/app/api/cron/trip-reminders/route');
    const res = await GET(new Request('http://localhost/api/cron/trip-reminders') as never);
    expect(res.status).toBe(401);
  });
});
