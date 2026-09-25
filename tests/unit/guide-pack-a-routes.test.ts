/**
 * Кабинет гида, пакет A — роуты с подменённой базой.
 *
 * Проверяется поведение, которое аудит нашёл сломанным: какие id уходят в
 * SQL, что отвечает роут на пустоту (null, а не 0), на чужое/несуществующее
 * (404, а не молчаливый «успех») и на мусор во входе (400).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
const txQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  transaction: async (cb: (c: { query: typeof txQueryMock }) => Promise<unknown>) => cb({ query: txQueryMock }),
}));

const authMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireRole: (...a: unknown[]) => authMock(...a),
  requireAdmin: (...a: unknown[]) => authMock(...a),
  requireAuth: (...a: unknown[]) => authMock(...a),
}));

const getGuidePartnerIdMock = vi.fn();
const getPartnerMock = vi.fn();
const ensureGuideMock = vi.fn();
const statsMock = vi.fn();
vi.mock('@/lib/auth/guide-helpers', () => ({
  getGuidePartnerId: (...a: unknown[]) => getGuidePartnerIdMock(...a),
  getGuidePartnerByUserId: (...a: unknown[]) => getPartnerMock(...a),
  ensureGuidePartnerExists: (...a: unknown[]) => ensureGuideMock(...a),
  getGuideStats: (...a: unknown[]) => statsMock(...a),
  verifyReviewOwnership: vi.fn().mockResolvedValue(true),
}));

const ensurePartnerForRoleMock = vi.fn();
vi.mock('@/lib/auth/partner-profile', () => ({
  ensurePartnerForRole: (...a: unknown[]) => ensurePartnerForRoleMock(...a),
}));

import { GET as getReviews } from '@/app/api/guide/reviews/route';
import { GET as getEarnings } from '@/app/api/guide/earnings/route';
import { GET as getProfile, PUT as putProfile } from '@/app/api/guide/profile/route';
import { POST as postReply } from '@/app/api/guide/reviews/[id]/reply/route';
import { POST as postCert } from '@/app/api/guide/certifications/route';
import { PUT as putCert } from '@/app/api/guide/certifications/[id]/route';
import { GET as getAdminCerts, PATCH as patchAdminCert } from '@/app/api/admin/guide-certifications/route';
import { PATCH as patchPartnerProfile } from '@/app/api/partners/profile/route';

const GUIDE = { userId: 'user-guide', email: 'g@x.ru', role: 'guide' };
const ADMIN = { userId: 'user-admin', email: 'a@x.ru', role: 'admin' };
const PARTNER_ID = '0b9c6a52-8d3e-4a55-9a51-1c2b3c4d5e6f';
const CERT_ID = '5f1e2d3c-4b5a-4968-8776-655443322110';

function req(url: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const m of [queryMock, txQueryMock, authMock, getGuidePartnerIdMock, getPartnerMock, ensureGuideMock, statsMock, ensurePartnerForRoleMock]) m.mockReset();
  authMock.mockResolvedValue(GUIDE);
  getGuidePartnerIdMock.mockResolvedValue(PARTNER_ID);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/guide/reviews', () => {
  it('limit > 100 — 400, в базу не ходит', async () => {
    const res = await getReviews(req('http://x/api/guide/reviews?limit=500'));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('работает без JOIN броней; нет отзывов — средняя null', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('AVG(rating)')) {
        return Promise.resolve({ rows: [{
          total_reviews: 0, avg_rating: null, five_star: 0, four_star: 0, three_star: 0, two_star: 0,
          one_star: 0, replied_count: 0, unreplied_count: 0, avg_professionalism: null,
          avg_knowledge: null, avg_communication: null,
        }] });
      }
      if (sql.includes('COUNT(*)::int AS count')) return Promise.resolve({ rows: [{ count: 0 }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await getReviews(req('http://x/api/guide/reviews?filter=unreplied'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.stats.avgRating).toBeNull();
    expect(body.data.reviews).toEqual([]);
    for (const [sql, params] of queryMock.mock.calls) {
      expect(String(sql)).not.toMatch(/operator_bookings/);
      expect((params as unknown[])[0]).toBe(PARTNER_ID);
    }
  });
});

describe('GET /api/guide/earnings', () => {
  it('ищет по partners.id, а не по users.id; пусто — null, а не 0 ₽', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('item_count')) {
        return Promise.resolve({ rows: [{ item_count: 0, total_earned: null, total_paid: null, total_pending: null, tours_completed: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await getEarnings(req('http://x/api/guide/earnings?period=week'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summary.totalEarnings).toBeNull();
    expect(body.data.summary.pendingPayment).toBeNull();
    expect(body.data.items).toEqual([]);
    expect(getGuidePartnerIdMock).toHaveBeenCalledWith(GUIDE.userId);
    for (const [, params] of queryMock.mock.calls) {
      expect(params).toEqual([PARTNER_ID, '7 days']);
    }
  });

  it('«всё время» — интервал NULL', async () => {
    queryMock.mockResolvedValue({ rows: [{ item_count: 1, total_earned: '5000', total_paid: '5000', total_pending: null, tours_completed: 1 }] });
    const res = await getEarnings(req('http://x/api/guide/earnings?period=all'));
    const body = await res.json();
    expect(queryMock.mock.calls[0][1]).toEqual([PARTNER_ID, null]);
    expect(body.data.summary.totalEarnings).toBe(5000);
    expect(body.data.summary.pendingPayment).toBe(0);
  });

  it('неизвестный период — 400', async () => {
    const res = await getEarnings(req('http://x/api/guide/earnings?period=decade'));
    expect(res.status).toBe(400);
  });

  it('отказ базы — 500 с текстом, не пустой список', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('x'), { code: '42883' }));
    const res = await getEarnings(req('http://x/api/guide/earnings'));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('sqlstate=42883'), 'x');
  });
});

describe('/api/guide/profile', () => {
  const PARTNER = { id: PARTNER_ID, name: 'Гид', profileStatus: 'none' };

  it('администратор без записи гида: GET не создаёт запись', async () => {
    authMock.mockResolvedValue(ADMIN);
    queryMock.mockResolvedValue({ rows: [{ id: ADMIN.userId, email: ADMIN.email, name: 'Админ', created_at: 'x' }] });
    getPartnerMock.mockResolvedValue(null);
    const res = await getProfile(req('http://x/api/guide/profile'));
    expect(res.status).toBe(200);
    expect(ensureGuideMock).not.toHaveBeenCalled();
    expect((await res.json()).data.partner).toBeNull();
  });

  it('администратор без записи гида: PUT — 403 и ни одной записи', async () => {
    authMock.mockResolvedValue(ADMIN);
    getPartnerMock.mockResolvedValue(null);
    const res = await putProfile(req('http://x/api/guide/profile', 'PUT', { name: 'X' }));
    expect(res.status).toBe(403);
    expect(ensureGuideMock).not.toHaveBeenCalled();
    expect(txQueryMock).not.toHaveBeenCalled();
  });

  it('PUT пишет «О себе» в description, телефон очищается, опыт 0 принят — одной транзакцией', async () => {
    getPartnerMock.mockResolvedValue(PARTNER);
    txQueryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await putProfile(req('http://x/api/guide/profile', 'PUT', {
      name: 'Иван', description: 'Вожу на вулканы', phone: '', experienceYears: 0, location: { lat: 53, lng: 158 },
    }));
    expect(res.status).toBe(200);
    const [userSql] = txQueryMock.mock.calls[0];
    expect(String(userSql)).toMatch(/UPDATE users SET name/);
    const [partnerSql, partnerParams] = txQueryMock.mock.calls[1];
    expect(String(partnerSql)).toMatch(/description = \$1/);
    expect(String(partnerSql)).toMatch(/contact = COALESCE\(contact, '\{\}'::jsonb\) - 'phone'/);
    expect(String(partnerSql)).toMatch(/location = \$\d::jsonb/);
    expect(partnerParams).toContain(0);
    expect(partnerParams).toContain('Вожу на вулканы');
    expect((partnerParams as unknown[])[(partnerParams as unknown[]).length - 1]).toBe(PARTNER_ID);
  });

  it('отказ записи partners откатывает имя (транзакция) и отвечает 500', async () => {
    getPartnerMock.mockResolvedValue(PARTNER);
    txQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockRejectedValueOnce(Object.assign(new Error('fail'), { code: '42703' }));
    const res = await putProfile(req('http://x/api/guide/profile', 'PUT', { name: 'Иван', description: 'x' }));
    expect(res.status).toBe(500);
  });

  it('заявка на проверку: none/rejected → pending', async () => {
    getPartnerMock.mockResolvedValue(PARTNER);
    txQueryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await putProfile(req('http://x/api/guide/profile', 'PUT', { submitForReview: true }));
    expect(res.status).toBe(200);
    const [sql] = txQueryMock.mock.calls[0];
    expect(String(sql)).toMatch(/profile_status = CASE WHEN profile_status IN \('none', 'rejected'\) THEN 'pending'/);
  });
});

describe('POST /api/guide/reviews/[id]/reply', () => {
  it("уведомление туристу — priority 'normal'", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE guide_reviews')) {
        return Promise.resolve({ rows: [{ tourist_id: 'tourist-1', guide_id: PARTNER_ID }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await postReply(
      req(`http://x/api/guide/reviews/${CERT_ID}/reply`, 'POST', { reply: 'Спасибо' }),
      { params: Promise.resolve({ id: CERT_ID }) },
    );
    expect(res.status).toBe(200);
    const notif = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO notifications'));
    expect(String(notif?.[0])).toMatch(/'normal'\)/);
  });

  it('не-uuid id — 400', async () => {
    const res = await postReply(
      req('http://x/api/guide/reviews/abc/reply', 'POST', { reply: 'x' }),
      { params: Promise.resolve({ id: 'abc' }) },
    );
    expect(res.status).toBe(400);
  });
});

describe('аттестат гида', () => {
  const INPUT = { name: 'Аттестация', issuingAuthority: 'ФСТР', certificateNumber: 'N1', issueDate: '2025-01-10' };

  it('POST пишет неподтверждённым, source = guide, в запись своего гида', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: CERT_ID, name: 'Аттестация', issuing_authority: 'ФСТР', certificate_number: 'N1',
      issue_date: '2025-01-10', expiry_date: null, is_verified: false, reviewed_at: null, review_comment: null, source: 'guide' }] });
    const res = await postCert(req('http://x/api/guide/certifications', 'POST', INPUT));
    expect(res.status).toBe(201);
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(/false, 'guide'\)/);
    expect((params as unknown[])[0]).toBe(PARTNER_ID);
    expect((await res.json()).data.review).toBe('pending');
  });

  it('POST без даты выдачи — 400', async () => {
    const res = await postCert(req('http://x/api/guide/certifications', 'POST', { ...INPUT, issueDate: undefined }));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('PUT чужого аттестата — 404; правка снимает подтверждение', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const res = await putCert(req(`http://x/api/guide/certifications/${CERT_ID}`, 'PUT', INPUT), { params: Promise.resolve({ id: CERT_ID }) });
    expect(res.status).toBe(404);
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(/WHERE id = \$1 AND guide_id = \$2/);
    expect(String(sql)).toMatch(/is_verified\s+= false/);
    expect((params as unknown[]).slice(0, 2)).toEqual([CERT_ID, PARTNER_ID]);
  });
});

describe('/api/admin/guide-certifications', () => {
  beforeEach(() => authMock.mockResolvedValue(ADMIN));

  it('PATCH с не-uuid id — 400, в базу не ходит', async () => {
    const res = await patchAdminCert(req('http://x/api/admin/guide-certifications', 'PATCH', { id: 'nope', is_verified: true }));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('PATCH по несуществующему — 404, а не «подтверждён»', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await patchAdminCert(req('http://x/api/admin/guide-certifications', 'PATCH', { id: CERT_ID, is_verified: true }));
    expect(res.status).toBe(404);
  });

  it('отказ без причины — 400; с причиной — пишет reviewed_at и комментарий', async () => {
    let res = await patchAdminCert(req('http://x/api/admin/guide-certifications', 'PATCH', { id: CERT_ID, is_verified: false }));
    expect(res.status).toBe(400);
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    res = await patchAdminCert(req('http://x/api/admin/guide-certifications', 'PATCH', { id: CERT_ID, is_verified: false, comment: 'Номер не найден в реестре' }));
    expect(res.status).toBe(200);
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(/reviewed_at\s+= NOW\(\)/);
    expect(params).toEqual([false, CERT_ID, ADMIN.userId, 'Номер не найден в реестре']);
  });

  it('GET отдаёт «не знаем» по переаттестации отдельной цифрой', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('AS needed')) return Promise.resolve({ rows: [{ needed: 2, unknown: 7 }] });
      if (sql.includes('verified_unreviewed')) return Promise.resolve({ rows: [{ total: 9, verified: 9, pending: 0, rejected: 0, verified_unreviewed: 9, expired: 0 }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await getAdminCerts(req('http://x/api/admin/guide-certifications?filter=pending'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.stats.reattestation_unknown).toBe(7);
    expect(body.data.stats.reattestation_needed).toBe(2);
  });
});

describe('PATCH /api/partners/profile — завершение онбординга гидом', () => {
  it('гид подаёт заявку (none → pending), gear — нет', async () => {
    for (const [role, expectPending] of [['guide', true], ['gear', false]] as const) {
      queryMock.mockReset();
      authMock.mockResolvedValue({ userId: 'u1', email: 'x@x.ru', role });
      queryMock.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, name')) {
          return Promise.resolve({ rows: [{ id: 'p1', name: 'X', category: role, contact: {}, profile_status: 'none' }] });
        }
        return Promise.resolve({ rows: [] });
      });
      const res = await patchPartnerProfile(req('http://x/api/partners/profile', 'PATCH', { complete_onboarding: true }));
      expect(res.status).toBe(200);
      const update = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE partners'));
      expect(String(update?.[0]).includes("THEN 'pending'"), role).toBe(expectPending);
    }
  });
});
