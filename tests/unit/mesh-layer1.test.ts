/**
 * VolcanoMesh, слой 1: геокомнаты с соседями 3x3, дедуп SOS-ретрансляций.
 *
 * Жизнекритичная логика: SOS соседа должен дойти до сервера ровно один раз
 * при нескольких ретрансляторах, а граница геоячейки не должна разрезать
 * группу на маршруте.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { roomOf, neighborRooms, roomsAreNeighbors } from '@/lib/mesh/rooms';
import {
  registerDevice,
  removeDevice,
  getRoomPeers,
} from '@/lib/mesh/signaling-store';
import { POST as relayPost } from '@/app/api/mesh/sos-relay/route';

// ── Геокомнаты ─────────────────────────────────────────────────────────────

describe('mesh rooms: ячейки и соседи 3x3', () => {
  it('roomOf стабильно квантует координаты (Камчатка)', () => {
    // Авачинский вулкан
    expect(roomOf(53.255, 158.833)).toBe('vol-532-1588');
    // Отрицательные координаты не ломают floor
    expect(roomOf(-10.05, -0.01)).toBe('vol--101--1');
  });

  it('neighborRooms возвращает 9 уникальных комнат, включая свою', () => {
    const rooms = neighborRooms('vol-532-1588');
    expect(rooms).toHaveLength(9);
    expect(new Set(rooms).size).toBe(9);
    expect(rooms).toContain('vol-532-1588');
    expect(rooms).toContain('vol-531-1587');
    expect(rooms).toContain('vol-533-1589');
  });

  it('туристы в 100 м по разные стороны границы ячейки — соседи', () => {
    const a = roomOf(53.2999, 158.85); // vol-532-...
    const b = roomOf(53.3001, 158.85); // vol-533-...
    expect(a).not.toBe(b);
    expect(roomsAreNeighbors(a, b)).toBe(true);
    expect(roomsAreNeighbors(b, a)).toBe(true);
  });

  it('дальние ячейки — не соседи', () => {
    expect(roomsAreNeighbors('vol-532-1588', 'vol-535-1588')).toBe(false);
  });

  it('нераспознанное имя комнаты деградирует без падения', () => {
    expect(neighborRooms('garbage')).toEqual(['garbage']);
  });
});

// ── Signaling store: соседние ячейки видят друг друга ──────────────────────

function fakeController() {
  return { enqueue: vi.fn() } as unknown as ReadableStreamDefaultController<Uint8Array>;
}

describe('signaling-store: peers через границы ячеек', () => {
  const ids = ['t-same', 't-adjacent', 't-far', 't-me'];

  afterEach(() => {
    ids.forEach(removeDevice);
  });

  it('getRoomPeers видит свою и смежные ячейки, но не дальние', () => {
    registerDevice('t-same', 'vol-532-1588', fakeController());
    registerDevice('t-adjacent', 'vol-533-1589', fakeController());
    registerDevice('t-far', 'vol-540-1588', fakeController());

    const peers = getRoomPeers('vol-532-1588', 't-me');
    expect(peers).toContain('t-same');
    expect(peers).toContain('t-adjacent');
    expect(peers).not.toContain('t-far');
  });

  it('peer-joined уведомляет соседнюю ячейку', () => {
    const adjacentCtrl = fakeController();
    registerDevice('t-adjacent', 'vol-533-1589', adjacentCtrl);
    registerDevice('t-me', 'vol-532-1588', fakeController());

    const calls = (adjacentCtrl.enqueue as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c) => new TextDecoder().decode(c[0] as Uint8Array));
    expect(messages.some((m) => m.includes('peer-joined') && m.includes('t-me'))).toBe(true);
  });
});

// ── SOS-relay: дедуп и форвард ─────────────────────────────────────────────

function relayReq(body: unknown, ip = '10.0.0.1'): NextRequest {
  return new Request('https://vedarai.ru/api/mesh/sos-relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function validBody(sosId: string, relayedBy = 'relay-device-1') {
  return {
    sos_id: sosId,
    relayed_by: relayedBy,
    origin_device: 'victim-device',
    sos: { lat: 53.25, lng: 158.83, accuracy: 12, tourist_name: 'Иван', tourist_phone: '+79990000000' },
  };
}

describe('POST /api/mesh/sos-relay', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('валидный релей форвардится в /api/safety/sos с source=mesh_relay', async () => {
    const res = await relayPost(relayReq(validBody(crypto.randomUUID())));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, deduped: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://vedarai.ru/api/safety/sos');
    const forwarded = JSON.parse((init as RequestInit).body as string);
    expect(forwarded.source).toBe('mesh_relay');
    expect(forwarded.relayed_by).toBe('relay-device-1');
    expect(forwarded.lat).toBe(53.25);
    expect(forwarded.tourist_phone).toBe('+79990000000');
  });

  it('вторая копия того же sos_id дедуплицируется и не форвардится', async () => {
    const sosId = crypto.randomUUID();
    await relayPost(relayReq(validBody(sosId, 'relay-1'), '10.0.0.1'));
    const res2 = await relayPost(relayReq(validBody(sosId, 'relay-2'), '10.0.0.2'));

    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2).toEqual({ success: true, deduped: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('разные sos_id проходят оба (несколько пострадавших)', async () => {
    await relayPost(relayReq(validBody(crypto.randomUUID()), '10.0.1.1'));
    await relayPost(relayReq(validBody(crypto.randomUUID()), '10.0.1.1'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('битое тело → 400, форварда нет', async () => {
    const res = await relayPost(relayReq({ nonsense: true }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('упавший форвард снимает дедуп-метку — другой сосед может доставить', async () => {
    const sosId = crypto.randomUUID();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const res1 = await relayPost(relayReq(validBody(sosId, 'relay-1'), '10.0.2.1'));
    expect(res1.status).toBe(502);

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const res2 = await relayPost(relayReq(validBody(sosId, 'relay-2'), '10.0.2.2'));
    expect(res2.status).toBe(200);
    expect((await res2.json()).deduped).toBe(false);
  });

  it('429 канонического роута считается доставкой (SOS уже был принят)', async () => {
    const sosId = crypto.randomUUID();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    const res = await relayPost(relayReq(validBody(sosId), '10.0.3.1'));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});
