/**
 * Перепись «рядом, но маршрут называет место» (04.10) — только читает.
 *
 * Повод: «Гора Замок», «Вулкан Козельский», «Скалы Три Брата», «Халактырский
 * пляж» — у всех место-тёзка числилось «рядом» со своим маршрутом, и поле
 * вело на начало импортного трека, а фото места маршруту были недоступны.
 * Правка — отдельной миграцией по списку; сама перепись не пишет ничего.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/link-kind-name-census/route.ts'), 'utf8');
const code = SRC.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

describe('link-kind-name-census', () => {
  it('только GET под CRON_SECRET', () => {
    expect(code).toContain('export async function GET');
    expect(code).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(code).toContain('timingSafeCompare(secret, process.env.CRON_SECRET');
  });

  it('ничего не пишет', () => {
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });

  it('улика — имя (nameMatchScore, все значимые слова места), не расстояние', () => {
    expect(code).toContain('nameMatchScore(r.place_name, r.route_title)');
    expect(code).toContain('.filter(r => r.score >= 1)');
    expect(code).not.toMatch(/filter\([^)]*km/);
  });

  it('объявлена ручной переписью', () => {
    expect(readFileSync(join(process.cwd(), 'lib/agents/cron-schedulers.ts'), 'utf8'))
      .toMatch(/'link-kind-name-census':\s*\{ kind: 'manual', writes: false/);
  });
});
