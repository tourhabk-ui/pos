/**
 * EVO-4: aiCodeReview получил скользящее окно вместо 2 зашитых файлов.
 * Тестируем чистые части (фильтр пути + сборка списка) без сети.
 */
import { describe, it, expect } from 'vitest';
import { isReviewableSourcePath, pickReviewFiles } from '@/lib/agents/evo/growth-agent';

describe('isReviewableSourcePath', () => {
  it('исходники app/api и lib с .ts — да', () => {
    expect(isReviewableSourcePath('lib/agents/foo.ts')).toBe(true);
    expect(isReviewableSourcePath('app/api/x/route.ts')).toBe(true);
  });
  it('тесты, декларации, не-ts — нет', () => {
    expect(isReviewableSourcePath('lib/foo.test.ts')).toBe(false);
    expect(isReviewableSourcePath('lib/foo.d.ts')).toBe(false);
    expect(isReviewableSourcePath('tests/unit/foo.test.ts')).toBe(false);
    expect(isReviewableSourcePath('components/X.tsx')).toBe(false);
    expect(isReviewableSourcePath('migrations/764_x.sql')).toBe(false);
    expect(isReviewableSourcePath('README.md')).toBe(false);
  });
  it('вне app/api и lib — нет', () => {
    expect(isReviewableSourcePath('scripts/foo.ts')).toBe(false);
    expect(isReviewableSourcePath('app/routes/[id]/page.tsx')).toBe(false);
  });
  it('исключённые файлы и принятые риски — нет', () => {
    expect(isReviewableSourcePath('lib/payments/tochka.ts')).toBe(false);
    expect(isReviewableSourcePath('lib/bookings/booking.service.ts')).toBe(false);
    expect(isReviewableSourcePath('app/api/webhook/route.ts')).toBe(false);
  });
});

describe('pickReviewFiles', () => {
  const core = ['app/api/hub/bookings/create/route.ts', 'lib/kuzmich/core.ts'];

  it('ядро идёт первым, затем недавние; дедуп; обрезка до max', () => {
    const recent = ['lib/a.ts', 'lib/b.ts', 'lib/kuzmich/core.ts', 'lib/c.ts'];
    const out = pickReviewFiles(core, recent, 4);
    expect(out).toEqual([
      'app/api/hub/bookings/create/route.ts',
      'lib/kuzmich/core.ts',
      'lib/a.ts',
      'lib/b.ts',
    ]);
    expect(new Set(out).size).toBe(out.length); // без дублей
  });

  it('пустое окно → только ядро (прежнее поведение, fallback)', () => {
    expect(pickReviewFiles(core, [], 4)).toEqual(core);
  });

  it('окно шире max — ядро не вытесняется', () => {
    const recent = Array.from({ length: 10 }, (_, i) => `lib/x${i}.ts`);
    const out = pickReviewFiles(core, recent, 4);
    expect(out.slice(0, 2)).toEqual(core);
    expect(out).toHaveLength(4);
  });
});
