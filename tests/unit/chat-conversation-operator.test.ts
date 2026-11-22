/**
 * tests/unit/chat-conversation-operator.test.ts
 *
 * POST /api/chat/conversations — вход в диалог с оператором с карточки тура.
 * Кнопка знает только id партнёра; user_id оператора резолвится на сервере
 * (не светится в публичном API). Контракты: operatorPartnerId → user_id из
 * partners → getOrCreateDirect (upsert-семантика); у партнёра нет аккаунта →
 * 404 с честным советом; гость → 401; нельзя писать самому себе; аккаунт и
 * роль собеседника из тела запроса не принимаются (ревью #3701, 22.11).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

const getOrCreateDirectMock = vi.fn();
const sendMessageMock = vi.fn();
const listConversationsMock = vi.fn();
vi.mock('@/lib/services/operators/chat.service', () => ({
  chatService: {
    getOrCreateDirect: (...args: unknown[]) => getOrCreateDirectMock(...args),
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
    listConversations: (...args: unknown[]) => listConversationsMock(...args),
  },
}));

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { POST } from '@/app/api/chat/conversations/route';
import { CHAT_NO_PARTNER_TEXT } from '@/lib/crm/inbox-kinds';

function req(body: unknown): NextRequest {
  return new Request('http://localhost/api/chat/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue({ userId: 'tourist-1', role: 'tourist' });
  getOrCreateDirectMock.mockResolvedValue({ conversationId: 'conv-1', created: true });
});

describe('POST /api/chat/conversations — operatorPartnerId', () => {
  it('партнёр с аккаунтом → user_id резолвится на сервере, беседа создаётся', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ user_id: 'operator-user-9' }] });

    const res = await POST(req({ operatorPartnerId: 'c3300000-0000-4000-8000-000000000005', tourId: 7, subject: 'Тур' }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.conversationId).toBe('conv-1');
    expect(getOrCreateDirectMock).toHaveBeenCalledWith(
      'tourist-1', 'tourist', 'operator-user-9', 'operator',
      // id тура в беседу не идёт (аудит 15.10, P2-02): колонка tour_id на
      // проде ссылается на запрещённую `tours`; тур остаётся темой.
      { subject: 'Тур' }
    );
  });

  // 29.10: тур продаёт и гид (1338). Роль собеседника — категория его
  // карточки: по ней уведомление о сообщении и лента CRM ищут карточку.
  it('тур гида → собеседник записан гидом; категория без чата — прежняя роль оператора', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ user_id: 'guide-user-3', category: 'guide' }] });
    await POST(req({ operatorPartnerId: 'c3300000-0000-4000-8000-000000000006', subject: 'Авторский тур' }));
    expect(getOrCreateDirectMock).toHaveBeenLastCalledWith('tourist-1', 'tourist', 'guide-user-3', 'guide', { subject: 'Авторский тур' });

    poolQueryMock.mockResolvedValue({ rows: [{ user_id: 'stay-user-4', category: 'stay' }] });
    await POST(req({ operatorPartnerId: 'c3300000-0000-4000-8000-000000000007' }));
    expect(getOrCreateDirectMock).toHaveBeenLastCalledWith('tourist-1', 'tourist', 'stay-user-4', 'operator', { subject: undefined });
  });

  it('у партнёра нет user_id → 404 с честным советом, беседа не создаётся', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ user_id: null }] });

    const res = await POST(req({ operatorPartnerId: 'c3300000-0000-4000-8000-000000000005' }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain('нет аккаунта');
    expect(getOrCreateDirectMock).not.toHaveBeenCalled();
  });

  it('гость → 401 от requireAuth', async () => {
    requireAuthMock.mockResolvedValue(
      NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 })
    );

    const res = await POST(req({ operatorPartnerId: 'c3300000-0000-4000-8000-000000000005' }));
    expect(res.status).toBe(401);
  });

  // Ревью безопасности #3701 (22.11): собеседника называет только карточка
  // партнёра. Аккаунт и роль из тела запроса — не вход: так любой вошедший
  // открывал беседу с любым аккаунтом и сам называл его роль.
  it('participantId и participantRole из тела не принимаются: без карточки — 400, базы и беседы нет', async () => {
    const res = await POST(req({ participantId: 'user-2', participantRole: 'admin', message: 'Привет' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe(CHAT_NO_PARTNER_TEXT);
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(getOrCreateDirectMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('с карточкой подложенные participantId и participantRole ничего не меняют: собеседник и роль — из карточки', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ user_id: 'operator-user-9', category: 'operator' }] });
    const res = await POST(req({
      operatorPartnerId: 'c3300000-0000-4000-8000-000000000005',
      participantId: 'victim-user', participantRole: 'admin', subject: 'Тур',
    }));
    expect(res.status).toBe(201);
    expect(getOrCreateDirectMock).toHaveBeenCalledWith('tourist-1', 'tourist', 'operator-user-9', 'operator', { subject: 'Тур' });
  });

  it('номер карточки не по форме — 400 словами, база не спрашивается', async () => {
    const res = await POST(req({ operatorPartnerId: 'partner-5' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Некорректные данные беседы');
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('отказ базы — 500 без текста ошибки в ответе, причина в логе', async () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint, Key (email)=(a@b.ru)'), { code: '23505' });
    poolQueryMock.mockRejectedValue(err);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await POST(req({ operatorPartnerId: 'c3300000-0000-4000-8000-000000000005' }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ success: false, error: 'Ошибка создания беседы' });
    expect(JSON.stringify(logged.mock.calls)).toContain('23505');
    logged.mockRestore();
  });
});

// Запрет (регулярка по исходнику — только для «этого быть не должно»): дверь
// чата не отдаёт наружу текст ошибки базы — в нём бывают значения строк.
// Причина отказа идёт в лог через logSwallowedFailure (ПД маскируются).
describe('двери чата не отдают текст ошибки наружу', () => {
  const CHAT_ROUTES = [
    'app/api/chat/conversations/route.ts',
    'app/api/chat/conversations/[id]/messages/route.ts',
    'app/api/chat/conversations/[id]/read/route.ts',
    'app/api/chat/unread/route.ts',
  ];
  it.each(CHAT_ROUTES)('%s', async (file) => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/details:\s*error/);
    expect(src).toMatch(/logSwallowedFailure\(/);
  });
});
