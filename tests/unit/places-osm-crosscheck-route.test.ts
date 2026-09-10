/**
 * /api/cron/places-osm-crosscheck — обещание «только читает».
 *
 * Инструмент сверки координат ничего не правит и не прячет сам: любая
 * находка идёт через POST /api/cron/place-coords (с независимым источником)
 * или отдельную миграцию-скрытие (без источника, как 947/948, 10.09). Этот
 * тест ловит попытку однажды добавить сюда write-путь.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/places-osm-crosscheck/route.ts'), 'utf-8');

describe('places-osm-crosscheck — только чтение', () => {
  it('экспортирует только GET', () => {
    expect(SRC).toMatch(/export async function GET/);
    expect(SRC).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it('нет ни одного write-запроса', () => {
    expect(SRC).not.toMatch(/UPDATE|INSERT INTO|DELETE FROM/);
  });

  it('авторизация — Bearer CRON_SECRET, постоянным временем', () => {
    expect(SRC).toContain('getCronSecret');
    expect(SRC).toContain('timingSafeCompare');
  });

  it('маркер версии для workflow есть', () => {
    expect(SRC).toContain('places_osm_crosscheck_v1');
  });
});
