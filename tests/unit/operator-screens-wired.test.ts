/**
 * Экраны оператора берут SQL из общего модуля, который прогоняется на
 * настоящем PostgreSQL (#1794). Здесь — статическая половина сторожа:
 * роуты не держат свой текст запроса (иначе pg-тест проверяет не то, что
 * работает), отказ пишется в лог с SQLSTATE, экран «Гиды» не показывает
 * ошибку и пустоту разом.
 *
 * «Клиенты» с 10.10 — экран CRM (шаг 1а-2b): их SQL живёт в
 * lib/crm/operator-clients, а сторож — operator-clients-crm.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANALYTICS_SQL, GUIDES_SQL, COMPLETENESS_TOURS_SQL } from '@/lib/operator/screen-queries';
import { OPERATOR_CLIENTS_LIST_SQL } from '@/lib/crm/operator-clients';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('роуты экранов оператора зовут общий SQL (#1794)', () => {
  const routes: Array<[string, RegExp]> = [
    ['app/api/operator/completeness/route.ts', /COMPLETENESS_TOURS_SQL/],
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
    const all = [COMPLETENESS_TOURS_SQL, GUIDES_SQL, ...Object.values(ANALYTICS_SQL), OPERATOR_CLIENTS_LIST_SQL].join('\n');
    expect(all).not.toMatch(/\btransportation\b/);
    expect(all).not.toMatch(/\bspecializations\b/);
    expect(all).not.toMatch(/\btp\.amount\b/);
  });

  it('«Гиды»: при ошибке — кнопка «Повторить», пустое состояние не рисуется поверх ошибки', () => {
    const src = read('app/hub/operator/guides/_GuidesClient.tsx');
    expect(src).toMatch(/\) : error \? null : filtered\.length === 0 \? \(/);
    expect(src).toMatch(/Повторить/);
    expect(src).not.toMatch(/specializations/);
    expect(src).toMatch(/verifiedCertifications/);
  });

  it('ошибки оператору — по-русски, без сырого текста PostgreSQL', () => {
    for (const p of ['app/api/operator/analytics/route.ts', 'app/api/operator/completeness/route.ts', 'app/api/operator/guides/route.ts']) {
      const src = read(p);
      expect(src, p).not.toMatch(/error: message \}/);
      expect(src, p).not.toMatch(/Failed to fetch/);
    }
  });
});
