// @vitest-environment node
/**
 * Описание «Камчатка Семейный Рафтинг» на проде было заглушкой «Мы есть»
 * (prod-check 117): миграция 1222 писала только в пустое поле и её не тронула.
 * Решение владельца 13.10: заменить текстом миграции («сезон закончили, теперь
 * просто для красивой картинки»). Миграция 1223 правит ТОЛЬКО заглушку.
 *
 * Что держит сторож:
 *  - текст 1223 дословно равен тексту описания из 1222 — один источник;
 *  - гейт узнаёт заглушку и пустоту, но не чужой текст: «Мы есть», «мы есть.»,
 *    '' и NULL попадают под правку, «Свой текст» — нет;
 *  - правка адресована одному slug; своих BEGIN/COMMIT нет; шапка называет
 *    решение владельца и prod-check 117.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const MIG = read('migrations/1223_rafting_description_placeholder.sql');
const PREV = read('migrations/1222_operator_landings_three.sql');

/** Литерал описания: всё между `SET description = ` и `,\n       updated_at`. */
function descriptionLiteral(sql: string): string {
  const m = sql.match(/SET description = ([\s\S]*?),\s*\n\s*updated_at = NOW\(\)/);
  if (!m) throw new Error('литерал описания не найден');
  return m[1].replace(/\s*\|\|\s*/g, '').replace(/\s+/g, ' ').trim();
}

/** Предикат гейта на JS — та же форма, что в SQL: lower(btrim(x, ' .!')) IN ('мы есть', ''). */
function gateMatches(description: string | null): boolean {
  const trimmed = (description ?? '').replace(/^[ .!]+|[ .!]+$/g, '').toLowerCase();
  return trimmed === 'мы есть' || trimmed === '';
}

describe('миграция 1223: описание рафтинга поверх заглушки', () => {
  it('текст — дословно из 1222', () => {
    expect(descriptionLiteral(MIG)).toBe(descriptionLiteral(PREV));
    expect(descriptionLiteral(MIG)).toContain('спокойные однодневные сплавы по реке Быстрой');
  });

  it('гейт: заглушка и пустота правятся, чужой текст — нет', () => {
    expect(MIG).toMatch(/lower\(btrim\(COALESCE\(description, ''\), ' \.!'\)\) IN \('мы есть', ''\)/);
    for (const v of ['Мы есть', 'мы есть.', 'МЫ ЕСТЬ!', '  Мы есть  ', '', null]) expect(gateMatches(v), String(v)).toBe(true);
    for (const v of ['Свой текст', 'Мы есть и работаем', 'Камчатка Семейный Рафтинг — спокойные однодневные сплавы']) {
      expect(gateMatches(v), v).toBe(false);
    }
  });

  it('один slug, без своих BEGIN/COMMIT, шапка называет решение и prod-check 117', () => {
    expect(MIG.match(/\bUPDATE partners\b/g)?.length).toBe(1);
    expect(MIG).toMatch(/WHERE slug = 'kamchatka-rafting'/);
    expect(MIG).not.toMatch(/^\s*(BEGIN|COMMIT|END)\s*;/m);
    const head = MIG.slice(0, MIG.indexOf('UPDATE partners'));
    // Слова владельца переносятся по строкам комментария — допускаем перенос с «-- ».
    expect(head).toMatch(/для красивой\s*(?:--\s*)?картинки/);
    expect(head).toMatch(/prod-check 117/);
    expect(head).toMatch(/Мы есть/);
  });
});
