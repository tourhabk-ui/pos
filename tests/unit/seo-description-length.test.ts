// @vitest-environment node
/**
 * Описание страницы в выдаче — от 70 до 160 знаков (перепись sitemap 13.10).
 *
 * Перепись глазами Googlebot нашла 16 описаний длиннее 160 знаков: Google
 * режет сниппет примерно там, и хвост уходил многоточием посреди фразы. Одно
 * было короче 70 (карточка жилья — 57 знаков), одно — без точки на конце.
 *
 * Статичная строка-описание длиннее 160 знаков — запрет, и он проверяется по
 * тексту исходника (правило 13.10: регулярка — только для «этого быть не
 * должно»). Собираемые из данных — вызовом generateMetadata на данных.
 */
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHRONICLE_ARTICLES } from '@/lib/chronicle/articles';

const ROOT = process.cwd();
const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/app/accommodations/[id]/_AccommodationDetailClient', () => ({ default: () => null }));

/** Публичные page.tsx и layout.tsx (кабинеты и API — мимо). */
function publicMetaFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) {
        if (rel === join('app', 'hub') || rel === join('app', 'api')) continue;
        walk(rel);
      } else if (e.name === 'page.tsx' || e.name === 'layout.tsx') out.push(rel);
    }
  };
  walk('app');
  return out;
}

/** Описания-литералы: `description: '…'` и `const DESCRIPTION = '…'` (шаблоны без подстановок). */
function literalDescriptions(src: string): string[] {
  const out: string[] = [];
  const re = /(?:description:|const DESCRIPTION\s*=)\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`$]*`)\s*[,;\n]/g;
  for (const m of src.matchAll(re)) out.push(m[1].slice(1, -1));
  return out;
}

describe('статичные описания не длиннее сниппета', () => {
  const files = publicMetaFiles();
  it('перепись не пуста', () => {
    expect(files.length).toBeGreaterThan(50);
  });
  it('ни одной строки-описания длиннее 160 знаков', () => {
    const long: string[] = [];
    let seen = 0;
    for (const f of files) {
      for (const d of literalDescriptions(readFileSync(join(ROOT, f), 'utf-8'))) {
        seen += 1;
        if (d.length > 160) long.push(`${f}: ${d.length} зн. «${d.slice(0, 50)}…»`);
      }
    }
    // Ноль найденных при непустом входе — отказ сторожа, а не «нарушений нет» (§4.0).
    expect(seen).toBeGreaterThan(40);
    expect(long).toEqual([]);
  });
});

describe('описания из данных — обрезаны по предложению или слову', () => {
  it.each(CHRONICLE_ARTICLES.map((a) => [a.slug]))('Летопись: %s', async (slug) => {
    const { generateMetadata } = await import('@/app/letopis/[slug]/page');
    const m = await generateMetadata({ params: Promise.resolve({ slug }) });
    const d = String(m.description ?? '');
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/[.!?…»]$/);
  });

  it('жильё: короткое описание добирается из полного, а не уходит в 57 знаков', async () => {
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [{
      name: 'Гостевой дом у источников',
      short_description: 'Гостевой дом в Паратунке, пять номеров.',
      description: 'Свой бассейн с термальной водой, ужин по заказу. До Петропавловска сорок минут на машине, трансфер договаривается с хозяином. Рядом Зелёновские озерки.',
    }] });
    const { generateMetadata } = await import('@/app/accommodations/[id]/page');
    const m = await generateMetadata({ params: Promise.resolve({ id: '3b2551c7-ed5c-47c8-bb93-41ca6a278c1e' }) });
    const d = String(m.description ?? '');
    expect(d.length).toBeGreaterThanOrEqual(70);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d.startsWith('Гостевой дом в Паратунке, пять номеров. Свой бассейн')).toBe(true);
  });
});
