/**
 * tests/unit/road-closure-alerts.test.ts
 *
 * Дорожные ограничения (пропущенный кейс: пропуска к Вилючинскому перевалу,
 * закрытие проезда к Вачкажцу):
 * - классификатор МЧС/новостей ловит закрытия проезда и пропускной режим
 *   (road_closure), не ловит нейтральные новости;
 * - зоны: Вачкажец/Сокоч -> western+avachinsky;
 * - POST /api/admin/external-alerts — ручной алерт с manual-external_id,
 *   дубль -> 409, не-админ не проходит;
 * - DELETE — гашение (expires_at=NOW()), не физическое удаление;
 * - PATCH /api/admin/places/[id]/status — первый писатель
 *   is_open/alert_message (UPSERT в location_real_time_status).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

import { classifyMchsItem, detectRoadRestriction } from '@/lib/services/safety/seismic-parser';
import { GET as getAlerts, POST as postAlert } from '@/app/api/admin/external-alerts/route';
import { DELETE as deleteAlert } from '@/app/api/admin/external-alerts/[id]/route';
import { PATCH as patchPlaceStatus } from '@/app/api/admin/places/[id]/status/route';

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  queryMock.mockReset();
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({ userId: 'admin-1', email: 'a@x.ru', role: 'admin' });
});

describe('классификатор road_closure', () => {
  it('«закрыт проезд к горному массиву» -> road_closure severity 2', () => {
    const event = classifyMchsItem(
      'news-1',
      'Доступ к Вачкажцу временно ограничен',
      'С 8:00 20 июля до 18:00 27 июля будет закрыт проезд к горному массиву Вачкажец по привычному турмаршруту. Объезд через поля со стороны посёлка Сокоч.',
      new Date().toISOString(),
      'https://kamgov.ru/news/1',
    );

    expect(event).not.toBeNull();
    expect(event!.alert_type).toBe('road_closure');
    expect(event!.severity).toBe(2);
    // Вачкажец/Сокоч — западное направление, зона western в списке
    expect(event!.affected_zones).toContain('western');
  });

  it('«проезд по пропускам» -> road_closure severity 1 (ограничение, не закрытие)', () => {
    const road = detectRoadRestriction(
      'с 15 июля проезд от термального к вилючинскому перевалу будет осуществляться строго по пропускам'.toLowerCase()
    );
    expect(road).not.toBeNull();
    expect(road!.severity).toBe(1);
  });

  it('нейтральная новость не классифицируется как road_closure', () => {
    const event = classifyMchsItem(
      'news-2',
      'На Камчатке открыли новую экотропу',
      'Туристы смогут пройти по маршруту вдоль реки. Дорога к тропе благоустроена.',
      new Date().toISOString(),
      'https://kamgov.ru/news/2',
    );
    expect(event).toBeNull();
  });
});

describe('POST /api/admin/external-alerts', () => {
  const VALID_BODY = {
    title: 'Вилючинский перевал: проезд по пропускам',
    description: 'Окна проезда 07-08, 13-14, 19-20',
    alertType: 'road_closure',
    severity: 1,
    affectedZones: ['avachinsky'],
    expiresAt: '2027-01-01T00:00:00+00:00',
    sourceUrl: 'https://www.ustoym.ru',
  };

  it('создаёт ручной алерт с manual-external_id', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 42 }] });

    const res = await postAlert(jsonReq('http://localhost/api/admin/external-alerts', 'POST', VALID_BODY));
    expect(res.status).toBe(201);

    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO external_alerts');
    expect(String(sql)).toContain('ON CONFLICT (external_id) DO NOTHING');
    expect(String((params as unknown[])[7])).toMatch(/^manual-/);
  });

  it('дубль external_id -> 409', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    const res = await postAlert(jsonReq('http://localhost/api/admin/external-alerts', 'POST', VALID_BODY));
    expect(res.status).toBe(409);
  });

  it('expiresAt в прошлом -> 400', async () => {
    const res = await postAlert(jsonReq('http://localhost/api/admin/external-alerts', 'POST', {
      ...VALID_BODY, expiresAt: '2020-01-01T00:00:00+00:00',
    }));
    expect(res.status).toBe(400);
  });

  it('не-админ не проходит', async () => {
    requireAdminMock.mockResolvedValue(NextResponse.json({ success: false }, { status: 403 }));

    const res = await postAlert(jsonReq('http://localhost/api/admin/external-alerts', 'POST', VALID_BODY));
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/external-alerts/[id]', () => {
  it('гасит алерт (expires_at=NOW()), не удаляет строку', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 42 }] });

    const res = await deleteAlert(
      jsonReq('http://localhost/api/admin/external-alerts/42', 'DELETE'),
      { params: Promise.resolve({ id: '42' }) }
    );
    expect(res.status).toBe(200);

    const [sql] = queryMock.mock.calls[0];
    expect(String(sql)).toContain('SET expires_at = NOW()');
    expect(String(sql)).not.toContain('DELETE FROM');
  });

  it('уже погашенный/несуществующий -> 404', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    const res = await deleteAlert(
      jsonReq('http://localhost/api/admin/external-alerts/999', 'DELETE'),
      { params: Promise.resolve({ id: '999' }) }
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/admin/places/[id]/status', () => {
  it('пишет alert_message через UPSERT в location_real_time_status', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.resolve({ rows: [{ ark_id: 'ark-1', name: 'Вачкажец' }] });
      if (sql.includes('INSERT INTO location_real_time_status')) {
        return Promise.resolve({ rows: [{ agent_route_id: 'ark-1', is_open: true, alert_message: 'Проезд закрыт' }] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await patchPlaceStatus(
      jsonReq('http://localhost/api/admin/places/p-1/status', 'PATCH', {
        alertMessage: 'Проезд закрыт 20-27 июля, объезд через Сокоч',
        alertExpiresAt: '2026-07-27T18:00:00+12:00',
      }),
      { params: Promise.resolve({ id: 'p-1' }) }
    );
    expect(res.status).toBe(200);

    const [upsertSql] = queryMock.mock.calls.find(([sql]) => String(sql).includes('location_real_time_status'))!;
    expect(upsertSql).toContain('ON CONFLICT (agent_route_id) DO UPDATE');
    expect(upsertSql).toContain('alert_message');
  });

  it('место не найдено -> 404', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await patchPlaceStatus(
      jsonReq('http://localhost/api/admin/places/nope/status', 'PATCH', { isOpen: false }),
      { params: Promise.resolve({ id: 'nope' }) }
    );
    expect(res.status).toBe(404);
  });

  it('пустое тело -> 400', async () => {
    const res = await patchPlaceStatus(
      jsonReq('http://localhost/api/admin/places/p-1/status', 'PATCH', {}),
      { params: Promise.resolve({ id: 'p-1' }) }
    );
    expect(res.status).toBe(400);
  });
});
