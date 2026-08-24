/**
 * Сторож разводки routes-audit.yml: судья (census-verdict.ts) написан под
 * форму ответа route-data-audit (routes_counted, navigability, link_kinds,
 * track_evidence, cleanup_queues из lib/routes/geometry-audit.ts). Эндпоинт
 * routes-audit — ДРУГОЙ, старый (lib/routes/audit.ts, категории
 * no_geometry/no_distance/...), и у его ответа этих полей нет вовсе.
 *
 * До 24.08 workflow был подключён к routes-audit: судья видел
 * routes_counted: undefined и КАЖДЫЙ прогон объявлял «перепись посчитала
 * ноль маршрутов» (issue #1378) — не потому, что маршруты пропали, а
 * потому, что вопрос задавался не тому эндпоинту. Полтора месяца недели
 * молчания под видом «отказа» — тот же класс дефекта, что героиня §4.0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW = readFileSync(join(process.cwd(), '.github/workflows/routes-audit.yml'), 'utf-8');
const CENSUS_VERDICT = readFileSync(join(process.cwd(), 'lib/routes/census-verdict.ts'), 'utf-8');
const GEOMETRY_ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/route-data-audit/route.ts'), 'utf-8');
const CATEGORIES_ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/routes-audit/route.ts'), 'utf-8');

describe('routes-audit.yml дёргает эндпоинт, чью форму судит census-verdict', () => {
  it('workflow ходит на /api/cron/route-data-audit', () => {
    expect(WORKFLOW).toContain('$BASE/api/cron/route-data-audit');
  });

  it('workflow НЕ ходит на /api/cron/routes-audit — у него другая форма ответа', () => {
    // routes-audit — категории no_geometry/no_distance/..., без routes_counted.
    expect(WORKFLOW).not.toMatch(/\$BASE\/api\/cron\/routes-audit(?!$|[a-z-])/);
    // routes-audit.json остаётся именем МАРКЕР-ФАЙЛА (путь триггера), а не
    // адресом запроса — проверяем, что маркер отличим от вызова curl.
    expect(WORKFLOW).not.toMatch(/curl[^\n]*\$BASE\/api\/cron\/routes-audit\b/);
  });

  it('таймаут запроса переписи не короче 300с: полный census без limit проходит все маршруты', () => {
    expect(WORKFLOW).toMatch(/--max-time 300 -H "Authorization: Bearer \$CRON_SECRET" \\\s*\n\s*"\$BASE\/api\/cron\/route-data-audit"/);
  });
});

describe('поля, которые судит census-verdict, реально существуют у route-data-audit', () => {
  const judgedFields = ['routes_counted', 'navigability', 'link_kinds', 'track_evidence', 'cleanup_queues', 'link_kind_available'];

  it('census-verdict.ts судит именно эти поля', () => {
    for (const f of judgedFields) expect(CENSUS_VERDICT).toContain(f);
  });

  it('route-data-audit (runGeometryAudit) их действительно поставляет', () => {
    expect(GEOMETRY_ROUTE).toContain('runGeometryAudit');
    // Ответ — spread ...audit поверх runGeometryAudit(): поля видны по имени
    // в самом geometry-audit.ts, которое census-verdict.ts и типизирует.
    const geometryAudit = readFileSync(join(process.cwd(), 'lib/routes/geometry-audit.ts'), 'utf-8');
    for (const f of judgedFields) expect(geometryAudit).toContain(`${f}:`);
  });

  it('routes-audit (computeRoutesAudit) этих полей НЕ поставляет — почему их и нельзя было судить', () => {
    for (const f of judgedFields) expect(CATEGORIES_ROUTE).not.toContain(f);
  });
});
