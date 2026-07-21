/**
 * tests/unit/chat-conversation-operator.test.ts
 *
 * POST /api/chat/conversations — вход в диалог с оператором с карточки тура.
 * Кнопка знает только id партнёра; user_id оператора резолвится на сервере
 * (не светится в публичном API). Контракты: operatorPartnerId → user_id из
 * partners → getOrCreateDirect (upsert-семантика); у партнёра нет аккаунта →
 * 404 с честным советом; гость → 401; нельзя писать самому себе.
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

    const res = await POST(req({ operatorPartnerId: 'partner-5', tourId: 7, subject: 'Тур' }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.conversationId).toBe('conv-1');
    expect(getOrCreateDirectMock).toHaveBeenCalledWith(
      'tourist-1', 'tourist', 'operator-user-9', 'operator',
      { bookingId: undefined, tourId: 7, subject: 'Тур' }
    );
  });

  it('у партнёра нет user_id → 404 с честным советом, беседа не создаётся', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ user_id: null }] });

    const res = await POST(req({ operatorPartnerId: 'partner-5' }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain('нет аккаунта');
    expect(getOrCreateDirectMock).not.toHaveBeenCalled();
  });

  it('гость → 401 от requireAuth', async () => {
    requireAuthMock.mockResolvedValue(
      NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 })
    );

    const res = await POST(req({ operatorPartnerId: 'partner-5' }));
    expect(res.status).toBe(401);
  });

  it('существующий контракт participantId не сломан', async () => {
    getOrCreateDirectMock.mockResolvedValue({ conversationId: 'conv-2', created: false });

    const res = await POST(req({ participantId: 'user-2' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.conversationId).toBe('conv-2');
    // partners не запрашивался
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});
