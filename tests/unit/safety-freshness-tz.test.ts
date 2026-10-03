/**
 * Сторож: метки свежести безопасности не уходят наружу строкой без пояса.
 *
 * 03.10: плитка «Радар» на главной писала «9 ч назад» у владельца на
 * Камчатке и «Обстановка недоступна» на сервере — при сборе каждые 5 минут.
 * `MAX(updated_at)::text` у колонки `timestamp` отдаёт стенное время пояса
 * базы без смещения, а `Date.parse` читает его в поясе читателя. Форма
 * проверена на PostgreSQL: tests/integration/timestamp-iso.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoUtcSql } from '@/lib/db/timestamp-iso';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const READERS = [
  'app/_home/data.ts',
  'lib/safety/current-status.ts',
  'lib/kuzmich/guardian-context.ts',
];

describe('свежесть статусов мест — в UTC с «Z»', () => {
  for (const f of READERS) {
    it(`${f}: updated_at статусов не читается через ::text`, () => {
      const src = read(f);
      // Статусы мест: MAX(updated_at) и lrs.updated_at. volcano_status.updated_at —
      // timestamptz, у неё строка несёт смещение, и она здесь не судится.
      expect(src).not.toMatch(/MAX\(updated_at\)::text|lrs\.updated_at::text/);
      expect(src).toContain('isoUtcSql(');
    });
  }

  it('форма: стенное время → пояс сессии → UTC → ISO с Z', () => {
    expect(isoUtcSql('MAX(updated_at)')).toBe(
      `to_char((MAX(updated_at)) AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    );
  });
});
