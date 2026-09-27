/**
 * «Никто не оценивал» отдаётся как null, а не как ноль (§4.0).
 *
 * ── Повод ─────────────────────────────────────────────────────────────────
 *
 * Ровно тот дефект, с которого §4.0 и начиналась («`rating: 4.5` у
 * перевозчика, которого никто не оценивал»), только зеркальный: обязательное
 * `number` в контракте заставляло подставить ноль.
 *
 *   - `GET /api/tours/[id]`: `parseFloat(String(row.rating || 0))` у тура и у
 *     партнёра — при том что каноническое чтение карточки держит
 *     `rating: string | null` (`lib/tours/tour-detail-query.ts`);
 *   - `GET /api/tours`: тип объявлял `rating: number`, а в ответ уезжал null —
 *     контракт и данные расходились молча;
 *   - `GET /api/accommodations/[id]`: `rating ? parseFloat(...) : 0` у объекта
 *     и у похожих, при том что СПИСОК того же объекта
 *     (`app/api/accommodations/route.ts`) уже отдавал честный null.
 *
 * Ноль — не пустота: экран печатает «0.0», а планер отсеивает объект условием
 * «rating >= 3.5» навсегда. Разница между «плохо оценён» и «не оценён» стоит
 * партнёру показов.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Поведение трёх выдач (null на входе — null на выходе) и ПРАВИЛО поверх всех
 * роутов: поле `rating` в ответе API не подменяется нулём. Исключения — с
 * причиной и поимённо; список может только сокращаться.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
const poolQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { publicRating } from '@/lib/reviews/public-rating';
import { GET as tourDetail } from '@/app/api/tours/[id]/route';
import { GET as toursList } from '@/app/api/tours/route';

const API = join(process.cwd(), 'app/api');

/**
 * Замер 26.09: два роута админки печатают `parseFloat(row.rating) || 0`.
 * Это тот же дефект, но поверхность другая — таблица партнёров в кабинете
 * администратора, где ноль читается как «оценок нет» рядом с числом отзывов.
 * Разбирается отдельно вместе с контрактом той таблицы; вычеркнуть строку —
 * тем же коммитом, что и починку.
 */
const ZERO_RATING_FROZEN = [
  'app/api/admin/content/partners/route.ts',
  'app/api/admin/content/partners/[id]/route.ts',
] as const;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

/** Строки вида `rating: <что-то, что сводится к нулю>`. */
const ZERO_FALLBACK = /(^|[^a-zA-Z_])rating\s*:.*(\|\|\s*0|\?\?\s*0|:\s*0)\s*[,)}]?\s*$/;

const req = (url: string) => new Request(url) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  queryMock.mockReset();
  poolQueryMock.mockReset();
});

describe('правило: оценка отдаётся только при подтверждённом счёте отзывов', () => {
  it('отзывов нет — оценки нет, чем бы колонка ни была заполнена', () => {
    // Замер на настоящем PostgreSQL (baseline + миграции, 26.09):
    // operator_tours.rating DEFAULT 0, partners.rating DEFAULT 0.0 — «никто не
    // оценивал» записано нулём самой базой. Пропуска одного NULL тут не хватает.
    expect(publicRating('0.00', 0)).toBeNull();
    expect(publicRating('4.50', 0)).toBeNull();
    expect(publicRating(null, 0)).toBeNull();
    expect(publicRating(null, 3)).toBeNull();
    expect(publicRating('', 3)).toBeNull();
  });

  it('отзывы есть — приезжает сама оценка, включая низкую', () => {
    expect(publicRating('4.70', 3)).toBe(4.7);
    expect(publicRating(2, 1)).toBe(2);
    // Ноль при живых отзывах — это ОЦЕНКА, и прятать её нельзя.
    expect(publicRating('0.00', 2)).toBe(0);
  });

  it('мусор вместо числа — «не знаю», а не NaN в JSON', () => {
    expect(publicRating('нет', 5)).toBeNull();
    expect(publicRating('4.5', 'много')).toBeNull();
  });
});

describe('правило: рейтинг в ответе API не подменяется нулём', () => {
  const files = routeFiles(API);

  it('роуты найдены', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it('новых подмен нуля не появилось', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.replace(process.cwd() + '/', '');
      const lines = readFileSync(f, 'utf-8').split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        if (ZERO_FALLBACK.test(line)) { offenders.push(rel); break; }
      }
    }
    const added = offenders.filter((f) => !(ZERO_RATING_FROZEN as readonly string[]).includes(f));
    expect(
      added,
      'поле rating отдаётся нулём, когда оценки нет. Ноль читается экраном и '
      + 'планером как ОЦЕНКА — отдавайте null и объявляйте тип `number | null` (§4.0)',
    ).toEqual([]);
  });

  it('разобранные случаи вычеркнуты из списка вместе с починкой', () => {
    const offenders = new Set<string>();
    for (const f of files) {
      const rel = f.replace(process.cwd() + '/', '');
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        if (ZERO_FALLBACK.test(line)) { offenders.add(rel); break; }
      }
    }
    const stale = (ZERO_RATING_FROZEN as readonly string[]).filter((f) => !offenders.has(f));
    expect(
      stale,
      'эти роуты уже не подменяют рейтинг нулём — вычеркните их из '
      + 'ZERO_RATING_FROZEN, иначе список перестанет что-либо значить',
    ).toEqual([]);
  });
});

describe('поведение выдач: null на входе — null на выходе', () => {
  it('GET /api/tours/[id] — и тур, и оператор', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        id: 1, title: 'Тур', base_price: '1000', is_active: true,
        rating: null, review_count: 0,
        partner_id_val: 'p1', partner_name: 'Оператор', partner_rating: null, partner_review_count: 0,
      }],
      rowCount: 1,
    });
    const res = await tourDetail(req('http://localhost/api/tours/1'), params('1'));
    const body = await res.json() as { data: { rating: number | null; operator: { rating: number | null } } };
    expect(body.data.rating).toBeNull();
    expect(body.data.operator.rating).toBeNull();
  });

  it('GET /api/tours/[id] — оценка есть, она и приезжает', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        id: 1, title: 'Тур', base_price: '1000', is_active: true,
        rating: '4.7', review_count: 3,
        partner_id_val: 'p1', partner_name: 'Оператор', partner_rating: '4.2', partner_review_count: 5,
      }],
      rowCount: 1,
    });
    const res = await tourDetail(req('http://localhost/api/tours/1'), params('1'));
    const body = await res.json() as { data: { rating: number | null; operator: { rating: number | null } } };
    expect(body.data.rating).toBe(4.7);
    expect(body.data.operator.rating).toBe(4.2);
  });

  it('GET /api/tours/[id] — ноль из DEFAULT колонки наружу не уходит', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        id: 1, title: 'Тур', base_price: '1000', is_active: true,
        rating: '0.00', review_count: 0,
        partner_id_val: 'p1', partner_name: 'Оператор', partner_rating: '0.00', partner_review_count: 0,
      }],
      rowCount: 1,
    });
    const res = await tourDetail(req('http://localhost/api/tours/1'), params('1'));
    const body = await res.json() as { data: { rating: number | null; operator: { rating: number | null } } };
    expect(body.data.rating).toBeNull();
    expect(body.data.operator.rating).toBeNull();
  });

  it('GET /api/tours — список', async () => {
    queryMock.mockImplementation((sql: string) =>
      /COUNT\(\*\)/.test(sql)
        ? Promise.resolve({ rows: [{ total: '1' }], rowCount: 1 })
        : Promise.resolve({
            rows: [{
              id: '1', name: 'Тур', base_price: '1000', price: '1000',
              rating: null, reviews_count: 0, is_active: true,
              created_at: '2026-07-01', updated_at: '2026-07-01',
            }],
            rowCount: 1,
          }),
    );
    const res = await toursList(req('http://localhost/api/tours'));
    const body = await res.json() as { data: { tours: { rating: number | null }[] } };
    expect(body.data.tours).toHaveLength(1);
    expect(body.data.tours[0].rating).toBeNull();
  });
});

describe('карточка жилья и список жилья говорят одно и то же', () => {
  const detail = readFileSync(join(API, 'accommodations/[id]/route.ts'), 'utf-8');
  const list = readFileSync(join(API, 'accommodations/route.ts'), 'utf-8');
  const client = readFileSync(
    join(process.cwd(), 'app/accommodations/[id]/_AccommodationDetailClient.tsx'), 'utf-8');

  it('оба зовут одно правило, а не считают каждый по-своему', () => {
    expect(detail).toContain('publicRating(');
    expect(list).toContain('publicRating(');
  });

  it('экран карточки признаёт отсутствие оценки типом и не зовёт .toFixed у null', () => {
    expect(client).toContain('rating: number | null');
    expect(client).toMatch(/data\.rating !== null[^\n]*data\.reviewCount > 0/);
  });
});
