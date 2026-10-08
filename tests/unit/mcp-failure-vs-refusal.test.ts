/**
 * Сбой и отказ MCP — разные колонки панели (владелец 08.10).
 *
 * Панель показывала у get_place_info красные «16 ошибок», у get_tour_details
 * «8». Перепись того же дня (prod-check run 98): из 36 внешних ошибок месяца
 * сбоем после 04.10 не было ни одной — остальное отказы по входу (агент
 * прислал пустые аргументы), три отказа пароля базы в одну ночь и строки до
 * 02.10, когда отказ ещё писался сбоем. Красная колонка звала чинить то, что
 * работало.
 *
 * Счёт на настоящей базе держит tests/integration/mcp-failure-refusal.pg.test.ts;
 * здесь — связка правила рода, среза и страницы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REFUSAL_KINDS } from '@/lib/mcp/call-log';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SLICE = read('app/api/admin/analytics/mcp/route.ts');
const PAGE = read('app/hub/admin/mcp/page.tsx');
const CENSUS = read('app/api/cron/mcp-census/route.ts');

describe('правило рода одно', () => {
  it('отказ — refused, unknown_tool, rate_limited; execution — сбой', () => {
    expect([...REFUSAL_KINDS].sort()).toEqual(['rate_limited', 'refused', 'unknown_tool']);
    expect(REFUSAL_KINDS).not.toContain('execution');
  });

  it('срез берёт род из call-log, а строку без рода считает сбоем', () => {
    expect(SLICE).toContain("import { REFUSAL_KINDS } from '@/lib/mcp/call-log'");
    expect(SLICE).toMatch(/COALESCE\(\$\{t\}\.error_kind, ''\) <> ALL\(\$4::text\[\]\)/);
    expect(SLICE).toMatch(/AS failures_30d/);
    expect(SLICE).toMatch(/AS refusals_30d/);
    expect(SLICE).toMatch(/AS failures_unsplit_30d/);
  });

  it('граница смеси — первая строка refused в журнале, а не дата в коде', () => {
    expect(SLICE).toMatch(/MIN\(created_at\) FROM mcp_tool_calls WHERE error_kind = 'refused'/);
    expect(CENSUS).toMatch(/refused_since/);
  });
});

describe('страница: сбой красный, отказ — нет', () => {
  it('колонки «Сбоев» и «Отказов» вместо одной «Ошибок»', () => {
    expect(PAGE).toMatch(/>Сбоев</);
    expect(PAGE).toMatch(/>Отказов</);
    expect(PAGE).not.toMatch(/Из них с ошибкой/);
    expect(PAGE).not.toMatch(/>Ошибок</);
  });

  it('красным — только сбой; отказ — цветом предупреждения', () => {
    expect(PAGE).toMatch(/r\.failures_30d > r\.failures_unsplit_30d \? 'var\(--danger\)'/);
    expect(PAGE).toMatch(/r\.refusals_30d > 0 \? 'var\(--warning\)'/);
    expect(PAGE).not.toMatch(/r\.errors_30d > 0 \? 'var\(--danger\)'/);
  });

  it('смесь до разделения названа словами, а не спрятана', () => {
    expect(PAGE).toMatch(/отказ\s+по входу писался в журнал сбоем/);
    expect(PAGE).toMatch(/журнал не знает/);
  });
});

describe('перепись: ошибки по клиенту', () => {
  it('замер есть, только чтение, проверки исключены тем же реестром', () => {
    expect(CENSUS).toContain("measure('errors_by_client_external'");
    expect(CENSUS).toMatch(/errors_by_client_external: num\(errorsByClient\.value\)/);
    expect(CENSUS).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/);
  });
});
