/**
 * Имя бота в ссылках — у самого бота, не из переменной (15.10).
 *
 * Оператор «Местечко Камчатка» по ссылке подключения получил от Telegram
 * «Похоже, такого пользователя не существует»: ссылка была собрана из
 * NEXT_PUBLIC_TELEGRAM_BOT_USERNAME, а переменная на проде стояла с опечаткой
 * (kuzmihai_bot). Бот жил, вебхук стоял верно, обработчик ссылку понимал.
 *
 * Сторож — поведение: резолвер с подменённым getMe и настоящий админ-роут
 * выдачи ссылки при переменной с опечаткой.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
  resolveTelegramBotUsername, resetBotUsernameCache, botUsernameIssue, envBotUsername,
} from '@/lib/telegram/bot-username';
import { telegramBot, buildPartnerChannelLinks } from '@/lib/partners/channel-link';

const m = vi.hoisted(() => ({ query: vi.fn(), admin: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));

import { POST as issueLink } from '@/app/api/admin/operators/[id]/channel-link/route';

const PARTNER_ID = '0f2a7f0e-3f5d-4c1a-9b0e-7d4b2a1c5e6f';

function getMeOk(username: string) {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username } }), { status: 200 }));
}
function getMeDown() {
  return vi.fn(async () => { throw new Error('сеть не ответила'); });
}

beforeEach(() => {
  resetBotUsernameCache();
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:test-token');
  vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', 'kuzmihai_bot'); // опечатка, как на проде 15.10
  vi.stubEnv('CONNECT_TOKEN_SECRET', 'test-secret-for-partner-links-16');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  m.query.mockReset();
  m.admin.mockReset();
});

describe('резолвер имени бота', () => {
  it('getMe отвечает — имя бота его, переменная с опечаткой названа расхождением', async () => {
    const r = await resolveTelegramBotUsername({ fetchImpl: getMeOk('kuzmichai_bot') as unknown as typeof fetch });
    expect(r).toEqual({ name: 'kuzmichai_bot', source: 'getMe', env_mismatch: 'kuzmihai_bot', reason: null });
    // После ответа getMe синхронный telegramBot() тоже отдаёт настоящее имя.
    expect(telegramBot()).toBe('kuzmichai_bot');
    expect(buildPartnerChannelLinks(PARTNER_ID)).toMatchObject({ ok: true, telegram: expect.stringMatching(/^https:\/\/t\.me\/kuzmichai_bot\?start=op_/) });
  });

  it('getMe недоступен — запас по переменной, причина названа, не «совпало»', async () => {
    const r = await resolveTelegramBotUsername({ fetchImpl: getMeDown() as unknown as typeof fetch });
    expect(r.name).toBe('kuzmihai_bot');
    expect(r.source).toBe('env');
    expect(r.reason).toMatch(/getMe/);
    expect(botUsernameIssue(r)?.text).toMatch(/сверить её с ботом нечем/);
  });

  it('переменная не похожа на username — kuzmichai_bot по умолчанию', async () => {
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', 'evil.example/x');
    expect(envBotUsername()).toBeNull();
    const r = await resolveTelegramBotUsername({ fetchImpl: getMeDown() as unknown as typeof fetch });
    expect(r).toMatchObject({ name: 'kuzmichai_bot', source: 'default' });
    expect(botUsernameIssue(r)).toBeNull();
  });

  it('ответ getMe кэшируется: второй вызов не ходит в сеть', async () => {
    const f = getMeOk('kuzmichai_bot');
    await resolveTelegramBotUsername({ fetchImpl: f as unknown as typeof fetch });
    await resolveTelegramBotUsername({ fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('расхождение переменной с ботом — предупреждение для health с обоими именами', async () => {
    const r = await resolveTelegramBotUsername({ fetchImpl: getMeOk('kuzmichai_bot') as unknown as typeof fetch });
    const issue = botUsernameIssue(r);
    expect(issue?.level).toBe('warn');
    expect(issue?.text).toContain('kuzmihai_bot');
    expect(issue?.text).toContain('kuzmichai_bot');
  });
});

describe('выдача ссылки администратором при переменной с опечаткой', () => {
  it('ссылка ведёт на настоящего бота по getMe, а не на несуществующего из переменной', async () => {
    vi.stubGlobal('fetch', getMeOk('kuzmichai_bot'));
    m.admin.mockResolvedValue({ userId: 'admin', role: 'admin' });
    m.query.mockResolvedValue({ rows: [{ name: 'Местечко Камчатка', has_telegram: false, has_max: true }] });
    try {
      const req = new NextRequest(`http://localhost/api/admin/operators/${PARTNER_ID}/channel-link`, { method: 'POST' });
      const res = await issueLink(req, { params: Promise.resolve({ id: PARTNER_ID }) });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { links: { telegram: string; max: string }; message: string } };
      expect(body.data.links.telegram).toMatch(/^https:\/\/t\.me\/kuzmichai_bot\?start=op_[A-Za-z0-9_-]{43}$/);
      expect(body.data.message).toContain('https://t.me/kuzmichai_bot?start=op_');
      expect(body.data.message).not.toContain('kuzmihai_bot');
      const code = new URL(body.data.links.max).searchParams.get('start');
      expect(code).toMatch(/^op_[A-Za-z0-9_-]{43}$/);
      expect(body.data.message).toContain(`Если ссылка не открылась — отправьте боту код: ${code}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('getMe недоступен — ссылка всё же выдаётся, по переменной, и это видно в ответе резолвера', async () => {
    vi.stubGlobal('fetch', getMeDown());
    m.admin.mockResolvedValue({ userId: 'admin', role: 'admin' });
    m.query.mockResolvedValue({ rows: [{ name: 'Местечко Камчатка', has_telegram: false, has_max: true }] });
    try {
      const req = new NextRequest(`http://localhost/api/admin/operators/${PARTNER_ID}/channel-link`, { method: 'POST' });
      const res = await issueLink(req, { params: Promise.resolve({ id: PARTNER_ID }) });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { links: { telegram: string } } };
      expect(body.data.links.telegram).toMatch(/^https:\/\/t\.me\/kuzmihai_bot\?start=op_/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('без прав администратора ссылка не выдаётся', async () => {
    m.admin.mockResolvedValue(NextResponse.json({ error: 'нет' }, { status: 403 }));
    const req = new NextRequest(`http://localhost/api/admin/operators/${PARTNER_ID}/channel-link`, { method: 'POST' });
    const res = await issueLink(req, { params: Promise.resolve({ id: PARTNER_ID }) });
    expect(res.status).toBe(403);
    expect(m.query).not.toHaveBeenCalled();
  });
});
