/**
 * Проверка безопасности SOS, позиции туриста и меша (issue #2073, 29.09).
 *
 * Две находки, починенные в этом PR, и сторожа к ним:
 *
 * 1. GET /api/safety/register/[id] отдавал ФИО и телефоны группы, годы
 *    рождения и экстренный контакт любому залогиненному с чужим UUID.
 *    Теперь — владелец или администратор, остальным 404 (как «нет такой»).
 *
 * 2. Меш-сигналинг (/api/mesh/signal) позволял перехватить чужой deviceId
 *    новой регистрацией и слать сообщения на любой deviceId края. Теперь
 *    живой чужой поток не перезаписывается, закрытие старого потока не
 *    выбрасывает новый, а сообщение идёт только между соседними комнатами.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { canReadRegistration } from '@/lib/safety/registration-read';
import {
  registerDevice,
  removeDevice,
  roomOfDevice,
} from '@/lib/mesh/signaling-store';
import { POST as signalPost } from '@/app/api/mesh/signal/route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('чтение регистрации маршрута', () => {
  it('владелец и администратор читают, остальные — нет', () => {
    expect(canReadRegistration({ userId: 'u1', role: 'tourist' }, 'u1')).toBe(true);
    expect(canReadRegistration({ userId: 'admin-1', role: 'admin' }, 'u1')).toBe(true);
    expect(canReadRegistration({ userId: 'u2', role: 'tourist' }, 'u1')).toBe(false);
    expect(canReadRegistration({ userId: 'u2', role: 'operator' }, 'u1')).toBe(false);
  });
  it('регистрацию без аккаунта по UUID читает только администратор', () => {
    expect(canReadRegistration({ userId: 'u2', role: 'tourist' }, null)).toBe(false);
    expect(canReadRegistration({ userId: 'a', role: 'admin' }, null)).toBe(true);
  });
  it('роут требует вход, сверяет владельца и чужому отвечает 404, а не 403', () => {
    const src = read('app/api/safety/register/[id]/route.ts');
    expect(src).toMatch(/await requireAuth\(request\)/);
    expect(src).toMatch(/canReadRegistration\(\{ userId: auth\.userId, role: auth\.role \}, row\.user_id \?\? null\)/);
    const deny = src.slice(src.indexOf('canReadRegistration({'), src.indexOf('canReadRegistration({') + 200);
    expect(deny).toMatch(/status: 404/);
    // user_id в ответ не уходит
    expect(src).toMatch(/const \{ user_id: _owner, \.\.\.reg \} = row;/);
  });
});

function ctrl(alive = true) {
  return {
    enqueue: vi.fn(() => { if (!alive) throw new Error('closed'); }),
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
}

describe('меш: чужой deviceId не перехватывается', () => {
  const ids = ['victim', 'thief', 'near', 'far', 'x'];
  afterEach(() => ids.forEach((id) => removeDevice(id)));

  it('живой поток с другого адреса не перезаписывается', () => {
    const victimCtrl = ctrl();
    expect(registerDevice('victim', 'vol-532-1588', victimCtrl, '10.0.0.1')).toBe(true);
    expect(registerDevice('victim', 'vol-600-1600', ctrl(), '10.9.9.9')).toBe(false);
    expect(roomOfDevice('victim')).toBe('vol-532-1588');
  });

  it('переподключение с того же адреса и замена мёртвого потока разрешены', () => {
    registerDevice('victim', 'vol-532-1588', ctrl(), '10.0.0.1');
    expect(registerDevice('victim', 'vol-533-1588', ctrl(), '10.0.0.1')).toBe(true);
    const dead = ctrl(false);
    registerDevice('x', 'vol-532-1588', dead, '10.0.0.2');
    expect(registerDevice('x', 'vol-532-1588', ctrl(), '10.0.0.3')).toBe(true);
  });

  it('закрытие старого потока не выбрасывает новый', () => {
    const oldCtrl = ctrl();
    const newCtrl = ctrl();
    registerDevice('victim', 'vol-532-1588', oldCtrl, '10.0.0.1');
    registerDevice('victim', 'vol-532-1588', newCtrl, '10.0.0.1');
    removeDevice('victim', oldCtrl);
    expect(roomOfDevice('victim')).toBe('vol-532-1588');
    removeDevice('victim', newCtrl);
    expect(roomOfDevice('victim')).toBeNull();
  });
});

function signalReq(body: unknown, ip = '10.1.1.1'): NextRequest {
  return new Request('https://vedarai.ru/api/mesh/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('меш: сообщение только между соседями', () => {
  const ids = ['near', 'far', 'victim'];
  afterEach(() => ids.forEach((id) => removeDevice(id)));

  it('сосед доставляет, дальний и незарегистрированный — нет', async () => {
    const victimCtrl = ctrl();
    registerDevice('victim', 'vol-532-1588', victimCtrl, '10.0.0.1');
    registerDevice('near', 'vol-533-1589', ctrl(), '10.0.0.2');
    registerDevice('far', 'vol-600-1600', ctrl(), '10.0.0.3');

    const ok = await (await signalPost(signalReq({ to: 'victim', message: { type: 'offer', from: 'near' } }))).json();
    expect(ok.delivered).toBe(true);

    const farRes = await (await signalPost(signalReq({ to: 'victim', message: { type: 'offer', from: 'far' } }))).json();
    expect(farRes.delivered).toBe(false);

    const ghost = await (await signalPost(signalReq({ to: 'victim', message: { type: 'offer', from: 'nobody' } }))).json();
    expect(ghost.delivered).toBe(false);
  });

  it('слишком большое сообщение — 413', async () => {
    const res = await signalPost(signalReq({ to: 'victim', message: { from: 'near', blob: 'x'.repeat(70 * 1024) } }));
    expect(res.status).toBe(413);
  });
});
