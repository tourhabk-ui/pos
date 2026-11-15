// @vitest-environment node
/**
 * Адреса API планера — только после входа (слово владельца 14.11 «6-3»: без
 * входа планер не работает).
 *
 * Вызовом обработчиков: без входа — 401 со ссылкой на вход в планер, вход не
 * проверился — 503 «не смогли проверить», а не «вы не вошли» (§4.0); ни
 * модель, ни база при этом не зовутся. Edge — реестром публичных адресов.
 * Спутник планера — исключение: человек в ЧП получает телефоны и без входа.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const { verifyMock, aiMock, queryMock } = vi.hoisted(() => ({ verifyMock: vi.fn(), aiMock: vi.fn(), queryMock: vi.fn() }));
vi.mock('@/lib/auth/jwt', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/jwt')>()), verifySessionToken: verifyMock }));
vi.mock('@/lib/ai/providers', async (orig) => ({ ...(await orig<typeof import('@/lib/ai/providers')>()), callAIWithModelDirect: aiMock }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: queryMock, connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })) } }));

import { POST as recommend } from '@/app/api/planner/recommend/route';
import { GET as partners } from '@/app/api/planner/partners/route';
import { POST as chat } from '@/app/api/planner/chat/route';
import { GET as toursForDay } from '@/app/api/planner/tours-for-day/route';
import { POST as validate } from '@/app/api/planner/validate/route';
import { POST as tripExtras } from '@/app/api/planner/trip-extras/route';
import { POST as companion } from '@/app/api/planner/companion/route';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';
import { PLANNER_LOGIN_REQUIRED, PLANNER_SESSION_UNCHECKED } from '@/lib/planner/require-session';

type Handler = (req: NextRequest) => Promise<Response>;
const DOORS: Array<{ path: string; method: 'GET' | 'POST'; handler: Handler; body?: unknown; query?: string }> = [
  { path: '/api/planner/recommend', method: 'POST', handler: recommend, body: { interests: ['volcano'] } },
  { path: '/api/planner/partners', method: 'GET', handler: partners, query: '?activity_type=volcano' },
  { path: '/api/planner/chat', method: 'POST', handler: chat, body: { message: 'вулканы в июле' } },
  { path: '/api/planner/tours-for-day', method: 'GET', handler: toursForDay, query: '?activity_type=volcano' },
  { path: '/api/planner/validate', method: 'POST', handler: validate, body: { days: [] } },
  { path: '/api/planner/trip-extras', method: 'POST', handler: tripExtras, body: { needs: { lodging: true }, days: [] } },
];

let ip = 0;
function req(path: string, method: 'GET' | 'POST', opts: { body?: unknown; query?: string; token?: string } = {}): NextRequest {
  // Свой адрес на каждый вызов: лимитеры роутов не должны мешать проверке.
  ip += 1;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-real-ip': `10.0.0.${ip}`, 'x-forwarded-for': `10.0.0.${ip}` };
  if (opts.token) headers.cookie = `auth_token=${opts.token}`;
  return new NextRequest(`https://vedarai.ru${path}${opts.query ?? ''}`, {
    method, headers, ...(method === 'POST' ? { body: JSON.stringify(opts.body ?? {}) } : {}),
  });
}

beforeEach(() => { verifyMock.mockReset(); aiMock.mockReset(); queryMock.mockReset(); });

describe('шесть адресов планера — только после входа', () => {
  it.each(DOORS)('$method $path: без входа — 401 со ссылкой на вход в планер', async ({ path, method, handler, body, query }) => {
    const res = await handler(req(path, method, { body, query }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: PLANNER_LOGIN_REQUIRED, login: '/auth/login?next=%2Fplanner' });
    expect(aiMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it.each(DOORS)('$method $path: вышел — 401; вход не проверился — 503, а не «вы не вошли»', async ({ path, method, handler, body, query }) => {
    verifyMock.mockResolvedValueOnce({ status: 'invalid' });
    expect((await handler(req(path, method, { body, query, token: 't' }))).status).toBe(401);
    verifyMock.mockResolvedValueOnce({ status: 'unchecked' });
    const res = await handler(req(path, method, { body, query, token: 't' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(PLANNER_SESSION_UNCHECKED);
    expect(aiMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it.each(DOORS)('$method $path: Edge не пускает анонима', ({ path, method }) => {
    expect(isPublicApiPath(path, method)).toBe(false);
  });

  it('каждый адрес каталога планера — в этом списке или исключение с причиной', () => {
    // Новый адрес планера без решения о входе — красный: иначе он остался бы
    // открытым молча, хотя «без входа планер не работает».
    const EXCEPTIONS: Record<string, string> = {
      companion: 'признак беды проверяется раньше входа: 112 — без входа, ответ модели — только вошедшему',
      preferences: 'вход проверяет своим путём (requireAuth): это настройки аккаунта',
    };
    const dirs = readdirSync(join(process.cwd(), 'app/api/planner'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const covered = [...DOORS.map((d) => d.path.replace('/api/planner/', '')), ...Object.keys(EXCEPTIONS)].sort();
    expect(dirs).toEqual(covered);
  });
});

describe('спутник планера: телефоны в беде — и без входа', () => {
  it('без входа и с признаком ЧП — блок SOS с 112, модель не зовётся', async () => {
    const res = await companion(req('/api/planner/companion', 'POST', { body: { message: 'Помогите, мы заблудились, у друга кровь' } }));
    expect(res.status).toBe(200);
    const data = await res.json() as { success: boolean; reply: string; emergency?: boolean };
    expect(data.emergency).toBe(true);
    expect(data.reply).toContain('112');
    expect(aiMock).not.toHaveBeenCalled();
  });

  it('без входа и без признака ЧП — 401, модель не зовётся', async () => {
    const res = await companion(req('/api/planner/companion', 'POST', { body: { message: 'Что взять на Авачинский?' } }));
    expect(res.status).toBe(401);
    expect(aiMock).not.toHaveBeenCalled();
  });

  it('вошёл — ответ модели', async () => {
    verifyMock.mockResolvedValue({ status: 'valid', payload: { userId: 'u-1', email: 'x', role: 'tourist' } });
    aiMock.mockResolvedValue('Возьмите ветровку.');
    const res = await companion(req('/api/planner/companion', 'POST', { body: { message: 'Что взять на Авачинский?' }, token: 't' }));
    expect(res.status).toBe(200);
    expect((await res.json() as { reply: string }).reply).toContain('Возьмите ветровку.');
  });

  it('адрес спутника остаётся публичным на Edge: иначе SOS без входа не дошёл бы до обработчика', () => {
    expect(isPublicApiPath('/api/planner/companion', 'POST')).toBe(true);
  });
});
