/**
 * Сборка списка ядра (Ф5) не заводит второе правило и не выдумывает срок годности.
 *
 * План владельца прямо запрещает угадывать интервал пересмотра: «универсальный
 * срок годности не выдумывается, интервалы назначаются после того, как перепись
 * их измерит». Первый прогон этого списка — по определению первый разбор, и
 * дата следующего пересмотра честно неизвестна.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/route-core/route.ts'), 'utf-8');
const ERROR_COST = readFileSync(join(process.cwd(), 'lib/routes/error-cost.ts'), 'utf-8');
const POPULARITY = readFileSync(join(process.cwd(), 'lib/routes/popularity.ts'), 'utf-8');

describe('порядок задаёт цена ошибки, не спрос', () => {
  it('вызывает buildCore из error-cost.ts, а не сортирует сам', () => {
    expect(SRC).toMatch(/import \{ buildCore, type ErrorCostInput \} from '@\/lib\/routes\/error-cost'/);
    expect(SRC).toContain('buildCore(inputs, size)');
    // Своего компаратора цены ошибки здесь быть не должно — иначе это второе
    // правило, которое рано или поздно разойдётся с error-cost.ts.
    expect(SRC).not.toMatch(/\.sort\(\s*\(a,\s*b\)/);
  });

  it('«чего не хватает» — тем же whatIsMissing, что у списка по спросу', () => {
    expect(SRC).toMatch(/import \{ whatIsMissing \} from '@\/lib\/routes\/popularity'/);
    expect(SRC).toContain('whatIsMissing({');
  });

  it('error-cost.ts подтверждает: признаки сравниваются по очереди, не суммой', () => {
    expect(ERROR_COST).toMatch(/Признаки сравниваются ПО ОЧЕРЕДИ/);
  });

  it('popularity.ts подтверждает: whatIsMissing действительно существует и это не выдумка', () => {
    expect(POPULARITY).toContain('export function whatIsMissing');
  });
});

describe('срок годности не выдумывается', () => {
  it('next_review_due и verified_by — null, а не сочинённая дата', () => {
    expect(SRC).toMatch(/next_review_due: null/);
    expect(SRC).toMatch(/verified_by: null/);
  });

  it('причина null объяснена словами в самом ответе', () => {
    expect(SRC).toContain('review_note');
    expect(SRC).toMatch(/запрещает выдумывать/);
  });
});

describe('маршрут только читает', () => {
  it('ни одного изменяющего запроса', () => {
    expect(SRC).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });

  it('слитые и скрытые записи исключены из рассмотрения', () => {
    expect(SRC).toMatch(/merged_into_id IS NULL/);
    expect(SRC).toMatch(/is_visible = TRUE OR r\.is_visible IS NULL/);
  });

  it('размер списка ограничен сверху', () => {
    expect(SRC).toContain('MAX_SIZE = 50');
  });

  it('версия формы ответа объявлена и отдаётся в 401 (соглашение route-popularity)', () => {
    expect(SRC).toMatch(/ROUTE_CORE_VERSION = 1/);
    expect(SRC).toMatch(/error: 'Unauthorized', v: ROUTE_CORE_VERSION/);
  });
});
