/**
 * tests/unit/trail-reports-api.test.ts
 *
 * POST/GET /api/safety/reports — наблюдения туристов с маршрутов.
 * Контракты: rate-limit → 429, мат → 422 без INSERT, валидный → 201 pending,
 * координаты вне Камчатки → 422 OUT_OF_BOUNDS (issue #305), GET отдаёт только
 * approved с русской меткой типа.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ── Моки ─────────────────────────────────────────────────────────────────────
const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const rateCheckMock = vi.fn(() => true);
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: (ip: string) => rateCheckMock(ip) }),
  getClientIp: () => '10.0.0.1',
}));

const profanityMock = vi.fn<() => Promise<boolean | null>>(() => Promise.resolve(false));
vi.mock('@/lib/services/profanity-filter', () => ({
  containsProfanity: () => profanityMock(),
}));

import { GET, POST } from '@/app/api/safety/reports/route';

function postReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/safety/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  rateCheckMock.mockReturnValue(true);
  profanityMock.mockResolvedValue(false);
  delete process.env.TELEGRAM_BOT_TOKEN; // нотификация — no-op в тестах
  delete process.env.TELEGRAM_CHAT_ID;
});

describe('POST /api/safety/reports', () => {
  it('валидный репорт → 201, INSERT с pending по умолчанию', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'abc-123' }] });

    const res = await POST(postReq({
      report_type: 'bear',
      text: 'Медведица с медвежатами у тропы к перевалу',
      lat: 53.25,
      lng: 158.6,
    }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('pending');
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO trail_reports');
    expect(params).toEqual(['bear', 'Медведица с медвежатами у тропы к перевалу', 53.25, 158.6]);
  });

  it('мат → 422, INSERT не вызывается', async () => {
    profanityMock.mockResolvedValue(true);

    const res = await POST(postReq({ report_type: 'other', text: 'непечатный текст' }));

    expect(res.status).toBe(422);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('PurgoMalum недоступен (null) → fail-open, репорт сохраняется', async () => {
    profanityMock.mockResolvedValue(null);
    queryMock.mockResolvedValue({ rows: [{ id: 'abc-456' }] });

    const res = await POST(postReq({ report_type: 'weather', text: 'Резко упал туман на перевале' }));

    expect(res.status).toBe(201);
    expect(queryMock).toHaveBeenCalled();
  });

  it('rate-limit → 429 до любых проверок', async () => {
    rateCheckMock.mockReturnValue(false);

    const res = await POST(postReq({ report_type: 'bear', text: 'Медведь у тропы' }));

    expect(res.status).toBe(429);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('координаты вне Камчатки → 422 OUT_OF_BOUNDS, INSERT не вызывается (issue #305)', async () => {
    const res = await POST(postReq({ report_type: 'bear', text: 'Медведь у тропы', lat: 55.75, lng: 37.61 })); // Москва
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.code).toBe('OUT_OF_BOUNDS');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('null-island (0,0) → 422 OUT_OF_BOUNDS, INSERT не вызывается (issue #305)', async () => {
    const res = await POST(postReq({ report_type: 'bear', text: 'Медведь у тропы', lat: 0, lng: 0 }));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.code).toBe('OUT_OF_BOUNDS');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('битый тип координаты (строка вместо числа) → 400 до проверки bbox', async () => {
    // JSON не переносит NaN/Infinity (JSON.stringify превращает их в null) —
    // реалистичный «мусор» от клиента это неверный тип, не NaN-литерал.
    const res = await POST(postReq({ report_type: 'bear', text: 'Медведь у тропы', lat: 'not-a-number', lng: 158.6 }));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('валидные координаты внутри Камчатки → 201 (issue #305, критерий приёмки)', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'abc-789' }] });
    const res = await POST(postReq({ report_type: 'bear', text: 'Медведь у тропы к перевалу', lat: 53.0, lng: 158.5 }));
    expect(res.status).toBe(201);
    expect(queryMock).toHaveBeenCalled();
  });

  it('неизвестный тип → 400', async () => {
    const res = await POST(postReq({ report_type: 'ufo', text: 'Что-то странное' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/safety/reports', () => {
  it('отдаёт approved с русской меткой типа', async () => {
    queryMock.mockResolvedValue({
      rows: [{ id: 'r1', report_type: 'rockfall', text: 'Свежий камнепад на кулуаре', lat: null, lng: null, created_at: '2026-07-04' }],
    });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data[0].type_label).toBe('Камнепад');
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toContain(`status = 'approved'`);
  });
});
