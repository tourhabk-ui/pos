// @vitest-environment node
/**
 * Цифры каталога в README — из переписи, не из головы (04.09).
 *
 * С июля README держал «~415 мест, ~421 маршрут», пока переписи 23.08 и
 * 01.09 давали 379 и 288; внешний обзор репозитория унаследовал завышение
 * как факт. Сторож держит: числа каталога живут ТОЛЬКО в блоке
 * CATALOG:START/END, который переписывает post-merge.yml из ответа
 * GET /api/cron/catalog-census; рукой писать их нельзя; перепись считает
 * живых (видимых и не слитых) и умеет сказать «не посчитано».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const README = readFileSync(join(process.cwd(), 'README.md'), 'utf-8');
const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/catalog-census/route.ts'), 'utf-8');
const SCRIPT = readFileSync(join(process.cwd(), 'scripts/update-readme-stats.mjs'), 'utf-8');
const WF = readFileSync(join(process.cwd(), '.github/workflows/post-merge.yml'), 'utf-8');

const CAT = /<!-- CATALOG:START -->[\s\S]*?<!-- CATALOG:END -->/;

describe('README: каталог только из переписи', () => {
  it('блок CATALOG есть и назван переписью с датой', () => {
    const block = README.match(CAT)?.[0] ?? '';
    expect(block).toMatch(/catalog-census/);
    expect(block).toMatch(/замер|не снималась/);
  });

  it('вне блока нет счёта мест, маршрутов и гидов', () => {
    const outside = README.replace(CAT, '');
    // «~NNN» — прежняя манера писать оценку рукой; и таблица «Живых/Видимых».
    expect(outside).not.toMatch(/~\d{3}/);
    expect(outside).not.toMatch(/\|\s*(Живых|Видимых)\s*\|/);
    expect(outside).not.toMatch(/Аттестованных гидов\s*\|\s*\d+/);
  });
});

describe('перепись каталога', () => {
  it('считает живых: видимые и не слитые', () => {
    expect(ROUTE).toMatch(/FROM places WHERE is_visible = true AND merged_into_id IS NULL/);
    expect(ROUTE).toMatch(/FROM kamchatka_routes WHERE is_visible = true AND merged_into_id IS NULL/);
    expect(ROUTE).toMatch(/is_verified = true/);
    expect(ROUTE).toMatch(/expiry_date IS NULL OR expiry_date >= CURRENT_DATE/);
  });

  it('у каждого числа есть исход «не посчитано», и отказ пишется в лог', () => {
    expect(ROUTE).toMatch(/number \| null/);
    expect(ROUTE).toMatch(/console\.error\(`\[catalog-census\]/);
    expect(ROUTE).not.toMatch(/catch\s*\{\s*\}/);
  });

  it('только чтение', () => {
    expect(ROUTE).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

describe('скрипт и воркфлоу', () => {
  it('скрипт переписывает блок только из ответа переписи и печатает null словами', () => {
    expect(SCRIPT).toMatch(/--catalog/);
    expect(SCRIPT).toMatch(/probe !== 'catalog_census_v1'/);
    expect(SCRIPT).toMatch(/'не посчитано'/);
  });

  it('post-merge снимает перепись секретом в заголовке и не подменяет числа при отказе', () => {
    expect(WF).toMatch(/\/api\/cron\/catalog-census/);
    expect(WF).toMatch(/-H "Authorization: Bearer \$CRON_SECRET"/);
    expect(WF).not.toMatch(/catalog-census\?secret=/);
    expect(WF).toMatch(/перепись не снята/);
  });
});
