// @vitest-environment node
/**
 * Два последних safety-крона на своих часах (14.10): KVERT и самопроверка
 * безопасности — вызовом роутов, с подменёнными зависимостями.
 *
 * До 14.10 оба шли только расписанием GitHub. Замер по Actions API: KVERT за
 * 10 суток получил 30 прогонов из ~41 при разрыве до 13,5 ч, самопроверка за
 * 4 суток — 12 из ~16. Теперь их зовёт и супервизор start.js, а замок окна в
 * 6 ч не даёт двум планировщикам сделать работу дважды.
 *
 * У самопроверки вторая нога потребовала своего голоса. Каналом тревоги был
 * красный прогон GitHub; в окне, занятом супервизором, воркфлоу получает
 * lease_held и остаётся зелёным. Поэтому о сломанном ядре сообщает сам роут.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const claimCronWindow = vi.fn<(agentId: string, windowMin: number, claimant: string) => Promise<'claimed' | 'held' | 'unknown'>>();
vi.mock('@/lib/agents/cron-lease', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/agents/cron-lease')>();
  return { ...real, claimCronWindow: (a: string, w: number, c: string) => claimCronWindow(a, w, c) };
});
vi.mock('@/lib/auth/cron', () => ({ getCronSecret: () => 's', diagnoseCronAuth: () => ({}) }));

interface Check { id: string; level: 'critical' | 'warn'; pass: boolean; detail: string }
const runSafetySelfCheck = vi.fn<() => Promise<{ ok: boolean; criticalFail: boolean; checks: Check[] }>>();
vi.mock('@/lib/safety/safety-selfcheck', () => ({ runSafetySelfCheck: () => runSafetySelfCheck() }));
const logAgentRun = vi.fn();
vi.mock('@/lib/agents/run-logger', () => ({ logAgentRun: (...a: unknown[]) => logAgentRun(...a) }));
const tgSend = vi.fn<(scope: string, text: string) => Promise<{ ok: true } | { ok: false; reason: string }>>();
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (s: string, t: string) => tgSend(s, t) }));

const syncKvertAcc = vi.fn();
vi.mock('@/lib/agents/kvert-sync', () => ({ syncKvertAcc: () => syncKvertAcc() }));
const recordCronRun = vi.fn();
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: (...a: unknown[]) => recordCronRun(...a) }));

process.env.CRON_SECRET = 's';

const safetyCheck = await import('@/app/api/cron/safety-check/route');
const kvert = await import('@/app/api/cron/kvert-acc/route');

const req = {} as NextRequest;

const OK_REPORT = { ok: true, criticalFail: false, checks: [{ id: 'sos_fires_on_emergency', level: 'critical' as const, pass: true, detail: 'ok' }] };
const BROKEN_REPORT = {
  ok: false,
  criticalFail: true,
  checks: [
    { id: 'sos_fires_on_emergency', level: 'critical' as const, pass: false, detail: 'детектор не сработал на «<помогите>» & 112' },
    { id: 'emergency_numbers', level: 'critical' as const, pass: true, detail: 'ok' },
    { id: 'mchs_phone_on_routes', level: 'warn' as const, pass: false, detail: 'у 3 маршрутов нет телефона' },
  ],
};

beforeEach(() => {
  claimCronWindow.mockReset().mockResolvedValue('claimed');
  runSafetySelfCheck.mockReset();
  logAgentRun.mockReset();
  tgSend.mockReset().mockResolvedValue({ ok: true });
  syncKvertAcc.mockReset();
  recordCronRun.mockReset();
});

describe('самопроверка безопасности: окно и голос', () => {
  it('берёт окно в 6 ч под своим именем', async () => {
    runSafetySelfCheck.mockResolvedValue(OK_REPORT);
    await safetyCheck.GET(req);
    expect(claimCronWindow).toHaveBeenCalledWith('safety-check', 360, 'external');
  });

  it('окно занято другим планировщиком — проверка не повторяется, ответ называет пропуск', async () => {
    claimCronWindow.mockResolvedValue('held');
    const res = await safetyCheck.GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'lease_held', agent_id: 'safety-check' });
    expect(runSafetySelfCheck).not.toHaveBeenCalled();
    expect(tgSend).not.toHaveBeenCalled();
  });

  it('аренда не проверилась (отказ БД) — проверка идёт: лишний прогон дешевле пропущенного', async () => {
    claimCronWindow.mockResolvedValue('unknown');
    runSafetySelfCheck.mockResolvedValue(OK_REPORT);
    await safetyCheck.GET(req);
    expect(runSafetySelfCheck).toHaveBeenCalledTimes(1);
  });

  it('ядро сломано — тревога уходит сама, с именами упавших критичных проверок', async () => {
    runSafetySelfCheck.mockResolvedValue(BROKEN_REPORT);
    const res = await safetyCheck.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { criticalFail: boolean; alert: string };
    expect(body).toMatchObject({ criticalFail: true, alert: 'sent' });

    expect(tgSend).toHaveBeenCalledTimes(1);
    const [scope, text] = tgSend.mock.calls[0];
    expect(scope).toBe('safety-check');
    expect(text).toContain('КРИТИЧНО');
    expect(text).toContain('sos_fires_on_emergency');
    // Текст детали экранирован: тревога уходит с parse_mode HTML.
    expect(text).toContain('&lt;помогите&gt;» &amp; 112');
    // Только критичные упавшие: прошедшая и предупреждение в тревогу не идут.
    expect(text).not.toContain('emergency_numbers');
    expect(text).not.toContain('mchs_phone_on_routes');
    expect(logAgentRun).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'safety-check', status: 'failed' }));
  });

  it('тревога не ушла — так и сказано в ответе, а не «отправлено»', async () => {
    runSafetySelfCheck.mockResolvedValue(BROKEN_REPORT);
    tgSend.mockResolvedValue({ ok: false, reason: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы' });
    const body = await (await safetyCheck.GET(req)).json() as { alert: string };
    expect(body.alert).toBe('not_sent: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы');
  });

  it('ядро цело — тревоги нет', async () => {
    runSafetySelfCheck.mockResolvedValue(OK_REPORT);
    const body = await (await safetyCheck.GET(req)).json() as Record<string, unknown>;
    expect(tgSend).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty('alert');
  });
});

describe('KVERT: окно в 6 ч', () => {
  it('берёт окно под своим именем и работает в своём окне', async () => {
    syncKvertAcc.mockResolvedValue({ fetched: 5, places_indexed: 12, matched: 4, vona: { error: null } });
    const res = await kvert.GET(req);
    expect(claimCronWindow).toHaveBeenCalledWith('kvert-acc', 360, 'external');
    expect(res.status).toBe(200);
    expect(syncKvertAcc).toHaveBeenCalledTimes(1);
  });

  it('окно занято — KVERT второй раз не спрашивается, прогон не пишется', async () => {
    claimCronWindow.mockResolvedValue('held');
    const res = await kvert.GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'lease_held', agent_id: 'kvert-acc' });
    expect(syncKvertAcc).not.toHaveBeenCalled();
    expect(recordCronRun).not.toHaveBeenCalled();
  });
});
