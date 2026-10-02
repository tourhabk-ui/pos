/**
 * МТС Exolve — SMS, звонок дежурному и приём событий.
 *
 * Держит связку: модуль зовёт ровно те адреса и поля, что в документации
 * (сверено 01.10), «не настроен» не выдаётся ни за «отправлено», ни за
 * «сбой», ответ без идентификатора — не «отправлено», ключ не уходит в лог,
 * звонок дежурному несёт только заглушку без данных и будит лишь на
 * тревогах сторожа, а приём событий заперт секретом и SMS-команд не исполняет.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRuPhone, sendExolveSms, makeExolveVoiceCall, exolveConfigured, TTS_MAX } from '@/lib/notifications/exolve';
import { isVerifiedExolveEvent, maskPhone, UNDELIVERED } from '@/lib/notifications/exolve-events';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf-8');
const KEY = 'test-key-not-real-0123456789';

describe('номер', () => {
  it('российские формы приводятся к 7XXXXXXXXXX', () => {
    expect(normalizeRuPhone('+7 914 123-45-67')).toBe('79141234567');
    expect(normalizeRuPhone('8 (914) 1234567')).toBe('79141234567');
    expect(normalizeRuPhone('9141234567')).toBe('79141234567');
  });
  it('прочее не угадывается', () => {
    expect(normalizeRuPhone('+1 415 555 0100')).toBeNull();
    expect(normalizeRuPhone('12345')).toBeNull();
    expect(normalizeRuPhone('')).toBeNull();
  });
});

describe('отправка', () => {
  const fetchMock = vi.fn();
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  beforeEach(() => {
    fetchMock.mockReset();
    errSpy.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('EXOLVE_API_KEY', KEY);
    vi.stubEnv('EXOLVE_NUMBER', '+7 999 000-11-22');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('без ключа или номера — not_configured, и в сеть не ходим', async () => {
    vi.stubEnv('EXOLVE_API_KEY', '');
    expect(exolveConfigured()).toBe(false);
    expect((await sendExolveSms('79141234567', 'x')).status).toBe('not_configured');
    expect((await makeExolveVoiceCall('79141234567', 'x')).status).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SMS — адрес, Bearer и поля из документации', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message_id: '439166538239448536' }), { status: 200 }));
    const r = await sendExolveSms('+7 914 123 45 67', 'Тест');
    expect(r).toEqual({ status: 'sent', id: '439166538239448536' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.exolve.ru/messaging/v1/SendSMS');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body)).toEqual({ number: '79990001122', destination: '79141234567', text: 'Тест' });
  });

  it('звонок — синтез речи, русский голос', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ call_id: '7374422070618357761' }), { status: 200 }));
    const r = await makeExolveVoiceCall('79141234567', 'Тревога');
    expect(r).toEqual({ status: 'sent', id: '7374422070618357761' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.exolve.ru/call/v1/MakeVoiceMessage');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ source: '79990001122', destination: '79141234567', tts: { text: 'Тревога', voice: 1, lang: 1 } });
  });

  it('200 без идентификатора — сбой, а не «отправлено»', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    expect((await sendExolveSms('79141234567', 'x')).status).toBe('failed');
  });

  it('отказ сервера — сбой с причиной, ключа в логе нет', async () => {
    fetchMock.mockResolvedValue(new Response('destination is not permitted for delivery', { status: 400 }));
    const r = await sendExolveSms('79141234567', 'x');
    expect(r.status).toBe('failed');
    expect(r.status === 'failed' && r.reason).toMatch(/HTTP 400 destination is not permitted/);
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(KEY);
  });

  it('сеть упала — сбой, а не исключение наружу', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    expect((await makeExolveVoiceCall('79141234567', 'x')).status).toBe('failed');
  });

  it('текст длиннее предела синтеза — отказ, а не обрезка', async () => {
    const r = await makeExolveVoiceCall('79141234567', 'а'.repeat(TTS_MAX + 1));
    expect(r.status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('звонок дежурному', () => {
  const tw = read('lib/safety/trip-watch.ts');
  const wd = read('app/api/cron/checkin-watchdog/route.ts');

  it('робот читает заглушку, а не текст с данными', () => {
    expect(tw).toMatch(/const call = opts\.wake \? await callDuty\(stub\)/);
    expect(tw).toMatch(/makeExolveVoiceCall\(phone, dutyVoiceText\(stub\)\)/);
  });

  it('звонок не делает тревогу доставленной: delivered — только MAX', () => {
    expect(tw).toMatch(/return \{ delivered: r\.delivered, reason: r\.reason, call \}/);
  });

  it('будят обе тревоги сторожа, весть о закрытии — нет', () => {
    expect(wd.match(/\{ wake: true \}/g)?.length).toBe(2);
    expect(wd).toMatch(/dutyStub\(reg\.id, 'МЧС-ТРЕВОГА, решение за дежурным'\), \{ wake: true \}/);
    expect(tw).toMatch(/alertDuty\(text, dutyStub\(id, 'весть о туристе'\)\);/);
  });
});

describe('приём событий', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('без секрета в окружении не принимаем ничего', () => {
    vi.stubEnv('EXOLVE_WEBHOOK_SECRET', '');
    expect(isVerifiedExolveEvent('https://vedarai.ru/api/exolve/events?s=')).toBe(false);
  });

  it('секрет сверяется', () => {
    vi.stubEnv('EXOLVE_WEBHOOK_SECRET', 'abc123');
    expect(isVerifiedExolveEvent('https://vedarai.ru/api/exolve/events?s=abc123')).toBe(true);
    expect(isVerifiedExolveEvent('https://vedarai.ru/api/exolve/events?s=abc124')).toBe(false);
    expect(isVerifiedExolveEvent('https://vedarai.ru/api/exolve/events')).toBe(false);
  });

  it('недоставка узнаётся по обоим полям статуса', () => {
    expect(UNDELIVERED.has('DELIVERY_STATUS_FAILED')).toBe(true);
    expect(UNDELIVERED.has('STATUS_UNDERFUNDED')).toBe(true);
    expect(UNDELIVERED.has('DELIVERY_STATUS_DELIVERED')).toBe(false);
  });

  it('номер в логе — только две последние цифры', () => {
    expect(maskPhone('79141234567')).toBe('***67');
  });

  it('роут открыт Edge только на POST', () => {
    expect(isPublicApiPath('/api/exolve/events', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/exolve/events', 'GET')).toBe(false);
  });

  it('SMS-команды не исполняются: роут не трогает контроль выхода', () => {
    const route = read('app/api/exolve/events/route.ts');
    expect(route).not.toMatch(/trip-watch|watch-flow|closeTripWatch|pool\.query/);
  });
});
