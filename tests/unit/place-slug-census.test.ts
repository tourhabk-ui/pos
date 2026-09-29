/**
 * Перепись мест без адреса только читает и судит той же транслитерацией, что
 * миграции 779 и 1111. Шапка — app/api/cron/place-slug-census/route.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/place-slug-census/route.ts'), 'utf-8');

describe('place-slug-census', () => {
  it('только чтение: ни UPDATE, ни INSERT, ни DELETE', () => {
    expect(SRC).not.toMatch(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/);
  });

  it('транслитерация — та же функция базы, что у миграций, а не своя', () => {
    expect(SRC).toContain('translit_ru_slug(p.name)');
  });

  it('закрыт секретом крона', () => {
    expect(SRC).toContain('timingSafeCompare(secret, process.env.CRON_SECRET');
  });

  it('держатель адреса называется поимённо, включая скрытый и слитый дубль', () => {
    for (const k of ["'hidden_place'", "'merged_place'", "'visible_place'", "'route'", "'namesake'", "'free'"]) {
      expect(SRC).toContain(k);
    }
  });

  it('отказ — третий исход с причиной, а не пустой список', () => {
    expect(SRC).toMatch(/ok: false, reason/);
    expect(SRC).toContain('[place-slug-census] перепись не выполнена');
  });

  it('объявлен ручным и ничего не пишущим', () => {
    expect(MANUAL_ENDPOINTS['place-slug-census']).toMatchObject({ kind: 'manual', writes: false });
  });
});
