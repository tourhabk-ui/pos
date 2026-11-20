/**
 * Ошибки контента из второго пакета Сыщика (21.11): каждая сверена с
 * источником. Красная сопка — noindex и вне sitemap; Плоский Толбачик —
 * 3085 м по KVERT; /articles/zima — название тура из карточки, без летних баз.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_NOINDEX, routeInSitemap } from '@/lib/seo/h1-templates';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('контент 21.11', () => {
  it('маршрут «Красная сопка» — noindex, follow и вне sitemap', () => {
    expect(ROUTE_NOINDEX.has('visitkamchatka-krasnaya-sopka')).toBe(true);
    expect(routeInSitemap('visitkamchatka-krasnaya-sopka')).toBe(false);
    expect(routeInSitemap('visitkamchatka-tolbachik')).toBe(true);
    expect(routeInSitemap(null)).toBe(true);
    expect(read('app/routes/[id]/page.tsx')).toMatch(/ROUTE_NOINDEX\.has\(canonicalId\) \? \{ robots: \{ index: false, follow: true \} \}/);
    expect(read('lib/seo/sitemap-entries.ts')).toMatch(/routeInSitemap\(row\.slug\)/);
  });

  it('миграция 1475: Толбачик по KVERT, зима — название тура и без летних баз', () => {
    const sql = read('migrations/1475_content_fixes_syshchik_2026_11_21.sql');
    expect(sql).toContain("'Плоского (3140 м)', 'Плоского (3085 м)'");
    expect(sql).toContain('\'{"height_m":3085}\'');
    expect(sql).toContain('3085 м по каталогу KVERT ИВиС ДВО РАН; в Википедии — 3140 м');
    expect(sql).toContain('семидневный тур «Камчатка: здесь начинается Новый год»');
    expect(sql).toMatch(/можно кататься даже летом \[11\]\.',\n\s*''\)/);
  });
});
