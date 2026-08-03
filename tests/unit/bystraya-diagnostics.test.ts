/**
 * Диагностика карточки сплава (/api/admin/diagnostics/bystraya): admin-only,
 * только чтение, отвечает на вопрос «почему тур не виден» детерминированно —
 * состояние строки, фильтр каталога, применённые/падавшие миграции.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'app/api/admin/diagnostics/bystraya/route.ts'), 'utf-8');

describe('диагностика сплава', () => {
  it('admin-only', () => {
    expect(src).toContain('requireAdmin');
    expect(src).toContain('if (auth instanceof NextResponse) return auth;');
  });
  it('проверяет состояние тура и фильтр каталога', () => {
    expect(src).toContain('is_published');
    expect(src).toContain('is_active');
    expect(src).toContain('deleted_at');
    expect(src).toContain('visible_in_catalog');
  });
  it('проверяет применённость миграций 789 и падения', () => {
    expect(src).toContain('789_bystraya_tour_publish.sql');
    expect(src).toContain('FROM _migrations');
    expect(src).toContain('_migration_failures');
  });
  it('только чтение — без INSERT/UPDATE/DELETE', () => {
    expect(src).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });
});
