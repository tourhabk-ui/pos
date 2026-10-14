/**
 * Тимоновские источники — точка статьи вместо точки без источника (14.10,
 * миграция 1258).
 *
 * Точка карточки стояла в 770 м ниже по долине от точки статьи Википедии; по
 * рельефу (SRTM 661 м против 588 м, ASTER 652 против 585, проба 925) к «700 м»
 * статьи ближе её точка, и в ней же лежал скрытый дубль. Сторож держит правило
 * координатной правки: только с прежнего точного значения, только на точку
 * источника — и ничего больше эта миграция не трогает.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { distanceKm } from '@/lib/geo/kamchatka';
import { migrationBody, migrationStatements } from '../helpers/migration-sql';

const BODY = migrationBody(readFileSync(join(process.cwd(), 'migrations/1258_timonov_springs_point.sql'), 'utf-8'));
const STATEMENTS = migrationStatements(BODY);
const ARTICLE = { lat: 53.8089, lng: 158.1644 }; // Википедия — «Тимоновские источники», проба 921

describe('точка Тимоновских источников', () => {
  const s = STATEMENTS.find((x) => /UPDATE places\s+SET lat = /.test(x))!;
  const to = (() => { const m = /SET lat = ([\d.]+), lng = ([\d.]+)/.exec(s)!; return { lat: +m[1], lng: +m[2] }; })();
  const from = (() => {
    const m = /abs\(lat - ([\d.]+)\) < 0\.000001 AND abs\(lng - ([\d.]+)\) < 0\.000001/.exec(s)!;
    return { lat: +m[1], lng: +m[2] };
  })();

  it('переезжает на точку статьи — и только с прежнего точного значения', () => {
    expect(s).toContain("id::text = '15bf29b0-9b1b-49c5-be1f-4c8d5d185f4e'");
    expect(distanceKm(to, ARTICLE)).toBeLessThan(0.001);
    expect(distanceKm(from, ARTICLE)).toBeGreaterThan(0.7);
    expect(distanceKm(from, ARTICLE)).toBeLessThan(0.85);
    expect(s).toMatch(/coord_source = 'external'/);
  });

  it('больше ничего не трогается: один UPDATE, без текстов, режима и удалений', () => {
    expect(STATEMENTS.filter((x) => /UPDATE places\b/.test(x))).toHaveLength(1);
    expect(BODY).not.toMatch(/description|eco_zone|kuzmich_review|is_visible|merged_into_id|\bDELETE\b/);
  });
});
