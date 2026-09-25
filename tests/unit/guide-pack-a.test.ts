/**
 * Кабинет гида, пакет A («гид как человек», 25.09) — сторож исходников и
 * помощников.
 *
 * Каждый блок держит одну находку аудита. Все они одной формы (§4.0): место,
 * где нельзя было сказать «не знаю» или «не смог», заполнялось пустотой или
 * враньём — пятисоткой вместо отзывов, «0 ₽» вместо «начислений нет», пустым
 * реестром из-за условия, которое CHECK не допускает.
 *
 * Роуты с подменённой базой — в guide-pack-a-routes.test.ts, петля
 * онбординга — в guide-pack-a-onboarding.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  transaction: vi.fn(),
}));
const ensurePartnerMock = vi.fn();
vi.mock('@/lib/auth/partner-profile', () => ({
  ensurePartnerForRole: (...args: unknown[]) => ensurePartnerMock(...args),
}));

import { getGuidePartnerByUserId, getGuideStats, ensureGuidePartnerExists } from '@/lib/auth/guide-helpers';
import { publicGuideWhere } from '@/lib/guides/visibility';
import { CertificationInputSchema, certificationReview } from '@/lib/guides/certification-input';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Исходник без комментариев — чтобы история в шапках не засчитывалась кодом. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

beforeEach(() => {
  queryMock.mockReset();
  ensurePartnerMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ── 1. Отзывы ───────────────────────────────────────────────────────────────
describe('1. отзывы гида не соединяют uuid с bigint', () => {
  it('нет JOIN guide_reviews.booking_id → operator_bookings', () => {
    const src = code('app/api/guide/reviews/route.ts');
    expect(src).not.toMatch(/operator_bookings/);
    expect(src).not.toMatch(/operator_tours/);
  });
  it('page/limit валидируются Zod, limit ≤ 100', () => {
    const src = code('app/api/guide/reviews/route.ts');
    expect(src).toMatch(/limit: z\.coerce\.number\(\)[^\n]*\.max\(100/);
    expect(src).not.toMatch(/parseInt\(searchParams/);
  });
  it('почта туриста гиду не отдаётся', () => {
    expect(code('app/api/guide/reviews/route.ts')).not.toMatch(/tourist_email|touristEmail/);
  });
});

// ── 2. Заработок ────────────────────────────────────────────────────────────
describe('2. заработок: партнёр, а не пользователь; отменённое не в сумме', () => {
  const src = code('app/api/guide/earnings/route.ts');
  it('guide_id берётся через getGuidePartnerId, а не users.id', () => {
    expect(src).toMatch(/getGuidePartnerId\(/);
    expect(src).toMatch(/\[guideId, interval\]/);
    expect(src).not.toMatch(/\[userId\]/);
  });
  it('нет соединения с operator_tours (uuid против bigint)', () => {
    expect(src).not.toMatch(/operator_tours/);
  });
  it('суммы не включают отменённые начисления', () => {
    expect(src).toMatch(/total_earned/);
    expect(src).toMatch(/SUM\(ge\.amount\) FILTER \(WHERE ge\.payment_status IS DISTINCT FROM 'cancelled'\)\)::text\s+AS total_earned/);
  });
  it('ставка комиссии не выдумывается', () => {
    expect(src).not.toMatch(/10\.00/);
  });
  it('период читается и уходит в SQL параметром', () => {
    expect(src).toMatch(/period: z\.enum\(\['week', 'month', 'year', 'all'\]\)/);
    expect(src).toMatch(/\$2::interval/);
  });
  it('экран читает summary/items, показывает ошибку и честную пустоту, а не 0 ₽', () => {
    const ui = code('app/hub/guide/earnings/_GuideEarningsPageClient.tsx');
    expect(ui).not.toMatch(/EMPTY_SUMMARY/);
    expect(ui).toMatch(/\{ data, loading, error \} = useApiFetch/);
    expect(ui).toMatch(/Начислений пока нет/);
    // Кнопка экспорта либо работает, либо её нет.
    expect(ui).toMatch(/onClick=\{\(\) => exportCsv\(/);
  });
});

// ── 3. Профиль ──────────────────────────────────────────────────────────────
describe('3. профиль гида сохраняется', () => {
  it('помощник не читает несуществующих колонок и PostGIS', () => {
    const all = code('lib/auth/guide-helpers.ts');
    // Тело getGuidePartnerByUserId; getGuideExpertiseZones — пакет B.
    const src = all.slice(all.indexOf('export async function getGuidePartnerByUserId'),
      all.indexOf('export async function ensureGuidePartnerExists'));
    expect(src.length).toBeGreaterThan(100);
    expect(src).not.toMatch(/p\.bio\b/);
    expect(src).not.toMatch(/total_earnings/);
    expect(src).not.toMatch(/ST_X|ST_Y/);
  });
  it('отказ базы бросается, а не выдаётся за «профиля нет»', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('boom'), { code: '42703' }));
    await expect(getGuidePartnerByUserId('u1')).rejects.toThrow('boom');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('sqlstate=42703'), 'boom');
  });
  it('рейтинг без отзывов — null, а не 0.0 колонки', async () => {
    queryMock.mockResolvedValue({ rows: [{
      id: 'p1', name: 'Гид', rating: '0.00', review_count: 0, location: { lat: 53, lng: 158 },
      languages: null, specializations: null, profile_status: 'pending', onboarding_completed: true,
    }] });
    const p = await getGuidePartnerByUserId('u1');
    expect(p?.rating).toBeNull();
    expect(p?.location).toEqual({ lat: 53, lng: 158 });
    expect(p?.languages).toEqual([]);
  });
  it('создание записи гида идёт через ensurePartnerForRole, не своей копией INSERT', async () => {
    ensurePartnerMock.mockResolvedValue('p1');
    await expect(ensureGuidePartnerExists('u1')).resolves.toBe('p1');
    expect(ensurePartnerMock).toHaveBeenCalledWith('u1', 'guide');
    expect(code('lib/auth/guide-helpers.ts')).not.toMatch(/INSERT INTO partners/);
  });
  it('PUT пишет users и partners одной транзакцией, «О себе» — в description', () => {
    const src = code('app/api/guide/profile/route.ts');
    expect(src).toMatch(/await transaction\(async \(client\)/);
    expect(src).not.toMatch(/\bbio\b/);
    expect(src).toMatch(/description = \$\$\{i\}/);
    expect(src).not.toMatch(/partner!\./);
    expect(src).not.toMatch(/ST_SetSRID|ST_MakePoint/);
  });
  it('администратору запись гида не создаётся', () => {
    const src = code('app/api/guide/profile/route.ts');
    const ensures = src.match(/ensureGuidePartnerExists\(userId\)/g) ?? [];
    expect(ensures.length).toBe(2);
    expect(src.match(/!partner && role === 'guide'/g)?.length).toBe(2);
  });
  it('экран: очищенный телефон уходит пустой строкой, опыт 0 допустим, «О себе» — description', () => {
    const ui = code('app/hub/guide/profile/_GuideProfileClient.tsx');
    expect(ui).toMatch(/phone: phone\.trim\(\),/);
    expect(ui).not.toMatch(/contact: phone\.trim\(\) \?/);
    expect(ui).toMatch(/partnerName: partnerName\.trim\(\)/);
    expect(ui).toMatch(/description: bio/);
    const api = code('app/api/guide/profile/route.ts');
    expect(api).toMatch(/experienceYears: z\.number\(\)\.int\(\)\.min\(0/);
  });
});

// ── 4. Статистика ───────────────────────────────────────────────────────────
describe('4. статистика гида: подзапросы, а не размножающие JOIN', () => {
  const src = code('lib/auth/guide-helpers.ts');
  it('нет LEFT JOIN четырёх таблиц в одну строку', () => {
    expect(src).not.toMatch(/LEFT JOIN guide_earnings/);
    expect(src).not.toMatch(/LEFT JOIN guide_reviews/);
  });
  it('«будущее» — tour_date + start_time, а не time > timestamptz', () => {
    expect(src).not.toMatch(/start_time > NOW\(\)/);
    expect(src).toMatch(/\(tour_date \+ start_time\) > \(NOW\(\) AT TIME ZONE 'Asia\/Kamchatka'\)/);
  });
  it('статус заработка один — payment_status', () => {
    expect(src).not.toMatch(/ge\.status|\bstatus = 'paid'/);
    expect(src).toMatch(/payment_status = 'paid'/);
  });
  it('нет начислений и отзывов — null, а не ноль', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'g1' }] });
      if (sql.includes('earnings_count')) {
        return Promise.resolve({ rows: [{
          completed_tours: '0', scheduled_tours: '0', active_tours: '0', upcoming_tours: '0',
          total_reviews: '0', avg_rating: null, earnings_count: '0', total_paid: '0', total_pending: '0',
          verified_certs: '0',
        }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const s = await getGuideStats('u1');
    expect(s?.earnings.totalPaid).toBeNull();
    expect(s?.earnings.pending).toBeNull();
    expect(s?.reviews.avgRating).toBeNull();
  });
  it('отказ базы логируется и бросается', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'g1' }] });
      return Promise.reject(Object.assign(new Error('bad'), { code: '42883' }));
    });
    await expect(getGuideStats('u1')).rejects.toThrow('bad');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('getGuideStats'), 'bad');
  });
});

// ── 5. Видимость гидов ──────────────────────────────────────────────────────
describe('5. публичный реестр — одно условие, и оно выполнимо', () => {
  const USERS = ['app/guides/page.tsx', 'app/guides/[id]/page.tsx', 'app/api/cron/guide-readiness/route.ts'];

  it('условие — одобренные платформой, а не несуществующий статус', () => {
    const w = publicGuideWhere('p');
    expect(w).toContain("p.category = 'guide'");
    expect(w).toContain("p.profile_status = 'approved'");
    expect(w).toContain('p.is_public = TRUE');
    // Значение обязано входить в CHECK колонки.
    expect(['none', 'pending', 'approved', 'rejected']).toContain('approved');
  });

  it('псевдоним проверяется — в SQL не попадает ничего, кроме имени', () => {
    expect(() => publicGuideWhere("p; DROP TABLE partners")).toThrow();
  });

  it.each(USERS)('%s отбирает через publicGuideWhere и без своей копии', (f) => {
    const src = code(f);
    expect(src).toMatch(/publicGuideWhere\('(p|g)'\)/);
    expect(src).not.toMatch(/profile_status = 'active'/);
  });

  it('нигде в app/ и lib/ нет profile_status = \'active\'', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && /profile_status\s*=\s*'active'/.test(code(rel))) hits.push(rel);
      }
    };
    walk('app');
    walk('lib');
    expect(hits).toEqual([]);
  });

  it('гид, завершивший онбординг, подаёт заявку (none → pending)', () => {
    const src = code('app/api/partners/profile/route.ts');
    expect(src).toMatch(/partner\.category === 'guide'/);
    expect(src).toMatch(/profile_status = CASE WHEN profile_status = 'none' THEN 'pending'/);
  });

  it('миграция 1017 переводит прошедших онбординг гидов в очередь', () => {
    const sql = read('migrations/1017_guide_onboarded_to_pending.sql');
    expect(sql).toMatch(/SET profile_status = 'pending'/);
    expect(sql).toMatch(/AND user_id IS NOT NULL/);
    expect(sql).toMatch(/AND onboarding_completed = TRUE/);
    expect(sql).toMatch(/AND profile_status = 'none'/);
  });

  it('письмо об одобрении гиду не обещает «публиковать туры»', () => {
    const src = code('app/api/admin/operators/[id]/route.ts');
    expect(src).toMatch(/const isGuide = partner\.category === 'guide'/);
    expect(src).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});

// ── 6. Ответ на отзыв ───────────────────────────────────────────────────────
describe('6. ответ на отзыв и уведомление туристу', () => {
  const src = code('app/api/guide/reviews/[id]/reply/route.ts');
  it("priority — из CHECK (normal), а не 'medium'", () => {
    expect(src).not.toMatch(/'medium'/);
    expect(src).toMatch(/\$3, 'normal'\)/);
  });
  it('отказ уведомления логируется', () => {
    expect(src).toMatch(/logGuideFailure\('уведомление туристу об ответе гида', notifError\)/);
  });
  it('на экране отзывов есть форма ответа, зовущая существующие роуты', () => {
    const ui = code('app/hub/guide/reviews/_GuideReviewsClient.tsx');
    expect(ui).toMatch(/\/api\/guide\/reviews\/\$\{review\.id\}\/reply/);
    expect(ui).toMatch(/send\(review\.guideReply \? 'PUT' : 'POST'\)/);
  });
});

// ── 7. Аттестация ───────────────────────────────────────────────────────────
describe('7. аттестат: производитель у гида, решение у администратора', () => {
  it('миграция 1016 заводит источник и след проверки', () => {
    const sql = read('migrations/1016_guide_certifications_review.sql');
    for (const col of ['source', 'reviewed_at', 'reviewed_by', 'review_comment']) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`));
    }
  });
  it('у каждого значения source есть производитель (§10.09)', () => {
    expect(code('app/api/guide/certifications/route.ts')).toMatch(/false, 'guide'\)/);
    expect(code('lib/services/ingest/visitkamchatka-guides.ts')).toMatch(/true, 'import'\)/);
  });
  it('у reviewed_at есть производитель и потребители', () => {
    expect(code('app/api/admin/guide-certifications/route.ts')).toMatch(/reviewed_at\s+= NOW\(\)/);
    expect(code('app/api/guide/certifications/[id]/route.ts')).toMatch(/reviewed_at\s+= NULL/);
    expect(code('app/api/guide/reattestation/route.ts')).toMatch(/reviewed_at IS NOT NULL/);
  });
  it('дата выдачи обязательна, будущее и срок раньше выдачи — отказ', () => {
    const base = { name: 'Аттестация', issuingAuthority: 'ФСТР', certificateNumber: 'N1' };
    expect(CertificationInputSchema.safeParse({ ...base }).success).toBe(false);
    expect(CertificationInputSchema.safeParse({ ...base, issueDate: '2099-01-01' }).success).toBe(false);
    expect(CertificationInputSchema.safeParse({ ...base, issueDate: '2024-02-30' }).success).toBe(false);
    expect(CertificationInputSchema.safeParse({ ...base, issueDate: '2025-01-10', expiryDate: '2024-01-01' }).success).toBe(false);
    expect(CertificationInputSchema.safeParse({ ...base, issueDate: '2025-01-10', expiryDate: null }).success).toBe(true);
  });
  it('три состояния проверки различимы', () => {
    expect(certificationReview(true, null)).toBe('verified');
    expect(certificationReview(false, null)).toBe('pending');
    expect(certificationReview(false, '2026-09-25T00:00:00Z')).toBe('rejected');
  });
  it('админ-экран читает ответ PATCH и не стартует с нулей', () => {
    const ui = code('app/hub/admin/guide-certifications/page.tsx');
    expect(ui).not.toMatch(/total: '0'/);
    expect(ui).not.toMatch(/catch \{\s*\}/);
    expect(ui).toMatch(/Решение не сохранено/);
    expect(ui).toMatch(/reattestation_unknown/);
  });
  it('имя гида в админке — company_name либо name', () => {
    expect(code('app/api/admin/guide-certifications/route.ts')).toMatch(/COALESCE\(p\.company_name, p\.name\) AS guide_name/);
  });
  it('в кабинете гида есть форма аттестата', () => {
    const ui = code('app/hub/guide/profile/_GuideCertificationsBlock.tsx');
    expect(ui).toMatch(/'\/api\/guide\/certifications'/);
    expect(code('app/hub/guide/profile/_GuideProfileClient.tsx')).toMatch(/<GuideCertificationsBlock \/>/);
  });
});

// ── 8. Онбординг (исходник; поведение — в .tsx) ─────────────────────────────
describe('8. завершение онбординга не глушит отказ', () => {
  it('в хуке нет .catch(() => {}) у PATCH и переход только после res.ok', () => {
    const src = code('components/hub/usePartnerOnboarding.ts');
    const fn = src.slice(src.indexOf('async function completeOnboarding'));
    expect(fn).not.toMatch(/\.catch\(\(\) => \{\}\)/);
    expect(fn.indexOf('res.ok')).toBeGreaterThan(-1);
    expect(fn.indexOf('res.ok')).toBeLessThan(fn.indexOf('router.replace'));
  });
});
