/**
 * Метрики дашборда оператора не выдумывают (#1799).
 *
 * Было три выдумки в одном экране: «↑100%» рисовалось долей, а читалось
 * ростом; «0.0» стояло там, где отзывов нет вовсе; «выручкой» называлась
 * сумма выставленных счетов, расходившаяся с экраном «Финансы». Здесь
 * держится: стрелок роста нет, рейтинг допускает «не знаю», выручка
 * разделена на выставлено и получено, цвета — токены.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const GRID_RAW = read('components/operator/Dashboard/OperatorMetricsGrid.tsx');
/**
 * Комментарии выброшены: в шапке компонента разобрана прежняя выдумка, и
 * цитата «↑100%» с номером находки не должна ловиться сторожем как код.
 */
const GRID = GRID_RAW
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const API = read('app/api/operator/dashboard/route.ts');
const TYPES = read('types/operator.ts');

describe('дашборд оператора: цифры честные', () => {
  it('доля больше не притворяется ростом: ни стрелок, ни calculateTrend', () => {
    expect(GRID).not.toContain('↑');
    expect(GRID).not.toContain('↓');
    expect(GRID).not.toMatch(/calculateTrend/);
    expect(GRID).not.toMatch(/trend=/);
    // Доля осталась, но словами.
    expect(GRID).toMatch(/из \$\{whole\}/);
  });

  it('рейтинг без отзывов — «не знаю», а не ноль звёзд', () => {
    expect(API).toMatch(/AVG\(t\.rating\) FILTER \(WHERE t\.rating > 0\)\s+AS avg_rating/);
    expect(API).not.toMatch(/COALESCE\(AVG\(t\.rating\)[^)]*\), 0\)\s+AS avg_rating/);
    expect(API).toMatch(/row\?\.avg_rating == null \? null : parseFloat/);
    expect(TYPES).toMatch(/averageRating: number \| null/);
    expect(GRID).toMatch(/metrics\.averageRating === null \? '—'/);
    expect(GRID).toMatch(/ещё никто не оценивал/);
  });

  it('выручка разделена: выставлено по броням и реально оплачено', () => {
    expect(API).toMatch(/payment_status = 'paid'\), 0\) AS paid_revenue/);
    expect(API).toMatch(/AS paid_revenue_month/);
    expect(TYPES).toMatch(/paidRevenue: number/);
    expect(GRID).toMatch(/Выставлено по броням/);
    expect(GRID).toMatch(/включая неоплаченные/);
    expect(GRID).toMatch(/title="Получено"/);
  });

  it('цвета — токены, хардкода Tailwind-палитры нет (DS §11)', () => {
    expect(GRID).not.toMatch(/text-purple-\d|bg-purple-\d/);
    expect(GRID).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  it('на телефоне две колонки, а не десять карточек в столбец', () => {
    expect(GRID).toMatch(/grid-cols-2 lg:grid-cols-4/);
    expect(GRID).not.toMatch(/grid-cols-1 md:grid-cols-2 lg:grid-cols-4/);
  });
});
