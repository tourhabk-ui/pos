/**
 * Четыре экрана оператора берут SQL из одного модуля, который прогоняется на
 * настоящем PostgreSQL (#1794). Здесь — статическая половина сторожа:
 * роуты не держат свой текст запроса (иначе pg-тест проверяет не то, что
 * работает), отказ пишется в лог с SQLSTATE, экран «Гиды» не показывает
 * ошибку и пустоту разом, невалидный id клиента — 400.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClientsSql, CLIENTS_SORT_COLUMNS, ANALYTICS_SQL, GUIDES_SQL, COMPLETENESS_TOURS_SQL } from '@/lib/operator/screen-queries';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('роуты экранов оператора зовут общий SQL (#1794)', () => {
  const routes: Array<[string, RegExp]> = [
    ['app/api/operator/completeness/route.ts', /COMPLETENESS_TOURS_SQL/],
    ['app/api/operator/clients/route.ts', /buildClientsSql\(/],
    ['app/api/operator/analytics/route.ts', /ANALYTICS_SQL\.(revenueByMonth|topTours|conversion|statusBreakdown|summary)/],
    ['app/api/operator/guides/route.ts', /GUIDES_SQL/],
  ];

  it.each(routes)('%s импортирует запрос из lib/operator/screen-queries и не держит свой', (path, marker) => {
    const src = read(path);
    expect(src).toMatch(/from '@\/lib\/operator\/screen-queries'/);
    expect(src).toMatch(marker);
    expect(src, 'в роуте не должно остаться собственного SELECT ... FROM').not.toMatch(/`\s*SELECT[\s\S]*?FROM\s+(operator_tours|users|tour_payments|partners g)/);
    expect(src).toMatch(/logScreenQueryFailure\(/);
  });

  it('колонок, которых нет в схеме, в запросах нет', () => {
    const all = [COMPLETENESS_TOURS_SQL, GUIDES_SQL, ...Object.values(ANALYTICS_SQL), buildClientsSql({ search: true, status: true, sortCol: 'name', order: 'ASC' }).dataSql].join('\n');
    expect(all).not.toMatch(/\btransportation\b/);
    expect(all).not.toMatch(/\bspecializations\b/);
    expect(all).not.toMatch(/\btp\.amount\b/);
  });

  it('статус клиента считается внутри CTE без алиаса cs (это и был отказ)', () => {
    const { countSql, dataSql } = buildClientsSql({ search: false, status: false, sortCol: 'total_spent', order: 'DESC' });
    const cteBody = countSql.slice(countSql.indexOf('cs AS ('), countSql.indexOf('FROM client_stats'));
    expect(cteBody).not.toMatch(/cs\./);
    expect(dataSql).toMatch(/LIMIT \$2 OFFSET \$3/);
    const both = buildClientsSql({ search: true, status: true, sortCol: 'name', order: 'ASC' });
    expect(both.dataSql).toMatch(/ILIKE \$2/);
    expect(both.dataSql).toMatch(/cs\.status = \$3/);
    expect(both.dataSql).toMatch(/LIMIT \$4 OFFSET \$5/);
    expect(both.dataSql).toMatch(/ORDER BY cs\.name ASC/);
    // Неизвестная сортировка не попадает в SQL как есть.
    const bad = buildClientsSql({ search: false, status: false, sortCol: 'id; DROP' as never, order: 'DESC' });
    expect(bad.dataSql).toMatch(/ORDER BY cs\.total_spent DESC/);
    expect(CLIENTS_SORT_COLUMNS).toContain('name');
  });

  it('карточка клиента: невалидный uuid — 400, не 500', () => {
    const src = read('app/api/operator/clients/[id]/route.ts');
    expect(src).toMatch(/isUuid\(id\)/);
    expect(src).toMatch(/Некорректный идентификатор клиента/);
  });

  it('«Гиды»: при ошибке — кнопка «Повторить», пустое состояние не рисуется поверх ошибки', () => {
    const src = read('app/hub/operator/guides/_GuidesClient.tsx');
    expect(src).toMatch(/\) : error \? null : filtered\.length === 0 \? \(/);
    expect(src).toMatch(/Повторить/);
    expect(src).not.toMatch(/specializations/);
    expect(src).toMatch(/verifiedCertifications/);
  });

  it('ошибки оператору — по-русски, без сырого текста PostgreSQL', () => {
    for (const p of ['app/api/operator/clients/route.ts', 'app/api/operator/analytics/route.ts', 'app/api/operator/completeness/route.ts', 'app/api/operator/guides/route.ts']) {
      const src = read(p);
      expect(src, p).not.toMatch(/error: message \}/);
      expect(src, p).not.toMatch(/Failed to fetch/);
    }
  });
});
