/**
 * Диагностика источников, не починка. Отвечает на вопрос «есть ли хоть
 * какой-то адрес, откуда можно попытаться забрать линию», прежде чем
 * называть дыру «нужны полевые GPS-треки».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/route-core-sources/route.ts'), 'utf-8');

describe('только читает и ничего не решает', () => {
  it('ни одного изменяющего запроса', () => {
    expect(SRC).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });

  it('id передаются явно, роут не гадает состав ядра сам', () => {
    expect(SRC).toContain("searchParams.get('ids')");
    expect(SRC).toMatch(/ids\.length === 0/);
  });
});

describe('различает «источника нет» от «источник есть, не импортирован»', () => {
  it('has_any_lead складывается из source_url, pdf_url, park_approval_url', () => {
    expect(SRC).toMatch(/has_any_lead: Boolean\(r\.source_url \|\| r\.pdf_url \|\| r\.park_approval_url\)/);
  });

  it('запрошенные, но не найденные id называются явно', () => {
    expect(SRC).toContain('not_found');
  });
});
