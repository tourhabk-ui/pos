/**
 * Один H1 на странице и описание, которое выдача показывает целиком
 * (аудит vedarai.ru 01.10).
 *
 * Обход 897 адресов нашёл: нет H1 на /planning и /for-operators; по два H1
 * на пяти правовых документах (шапка PageShell + заголовок документа);
 * описания длиннее 200 знаков у пятнадцати видов рыб и /mcp, короче 70 — у
 * документов, /help, /trending, /planning; у 21 маршрута описанием в выдаче
 * стояла заглушка «Это X в Камчатском крае. Место, которое стоит
 * посмотреть.»; три пары «статья — подборка» с одним заголовком.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FISH_SPECIES } from '@/lib/fish-species';
import { fishMetaDescription } from '@/lib/seo/fish-description';
import { stripFillerLead } from '@/lib/text/filler-lead';

const ROOT = process.cwd();
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LEGAL = ['privacy', 'terms', 'offer', 'commission', 'agent-agreement'];

describe('один H1', () => {
  it('шапка правовых документов — подпись, а не H1', () => {
    expect(code('components/shared/PageShell.tsx')).not.toMatch(/<h1\b/);
  });

  for (const doc of LEGAL) {
    it(`/legal/${doc}: ровно один H1 — у самого документа`, () => {
      const src = code(`app/legal/${doc}/page.tsx`);
      expect(src).toMatch(/<PageShell\b/);
      expect(src.match(/<h1\b/g)?.length).toBe(1);
    });
  }

  it('/for-operators: заголовок промо-блока — H1 страницы, в чужой странице — H2', () => {
    expect(code('app/for-operators/page.tsx')).toMatch(/<OperatorPromo headingLevel="h1" \/>/);
    expect(code('components/homepage/OperatorPromo.tsx')).toMatch(/headingLevel = 'h2'/);
  });

  it('/planning: H1 есть', () => {
    expect(code('app/planning/page.tsx')).toMatch(/<h1 className="sr-only">Планирование похода по Камчатке<\/h1>/);
  });
});

/** Статическое описание из metadata страницы. */
function staticDescription(path: string): string {
  const m = code(path).match(/\bdescription:\s*'([^']+)'/);
  if (!m) throw new Error(`${path}: статическое описание не найдено`);
  return m[1];
}

describe('описание укладывается в выдачу', () => {
  const PAGES = [
    'app/planning/page.tsx',
    'app/help/page.tsx',
    'app/trending/page.tsx',
    'app/legal/privacy/page.tsx',
    'app/legal/terms/page.tsx',
    'app/legal/commission/page.tsx',
    'app/mcp/page.tsx',
  ];
  for (const p of PAGES) {
    it(`${p}: от 70 до 160 знаков`, () => {
      const d = staticDescription(p);
      expect(d.length).toBeGreaterThanOrEqual(70);
      expect(d.length).toBeLessThanOrEqual(160);
    });
  }

  it('/trending не обещает «прямо сейчас»: список — по просмотрам за всё время', () => {
    expect(staticDescription('app/trending/page.tsx')).not.toMatch(/прямо сейчас/);
  });

  it('рыба: у каждого вида до 160 знаков и сезон первым', () => {
    for (const s of FISH_SPECIES) {
      const d = fishMetaDescription(s);
      expect(d.length, s.id).toBeLessThanOrEqual(160);
      expect(d.startsWith(`Сезон: ${s.season}.`), s.id).toBe(true);
    }
    expect(code('app/fish/[id]/page.tsx')).toMatch(/const desc = fishMetaDescription\(species\)/);
  });

  it('статья режется по предложению, а не посреди слова', () => {
    const src = code('app/articles/[slug]/page.tsx');
    expect(src).toMatch(/const description = metaDescription\(article\.body\)/);
    expect(src).not.toMatch(/\.slice\(0, 160\)/);
  });
});

describe('подборка не делит заголовок со статьёй', () => {
  it('у подборки хвост «— подборка», превью есть и без обложки', () => {
    const src = code('app/collections/[slug]/page.tsx');
    expect(src).toMatch(/fitTitle\(col\.title, \[' — подборка'\]\)/);
    expect(src).toMatch(/images: col\.cover_image \? \[col\.cover_image\] : defaultOgImages\(\)/);
  });
});

describe('заглушка в начале описания маршрута', () => {
  it('снимается шаблон целиком, настоящий текст остаётся', () => {
    expect(stripFillerLead(
      'Это Бухта Русская в Камчатском крае. Место, которое стоит посмотреть. Она расположена в Авачинском заливе.',
    )).toBe('Она расположена в Авачинском заливе.');
    expect(stripFillerLead(
      'Это Белые скалы в Камчатском крае — место, которое стоит посмотреть. Они находятся в центральной части.',
    )).toBe('Они находятся в центральной части.');
    expect(stripFillerLead(
      'Это Озеро Ажабачье (Азабачье) в Камчатском крае. Место, которое стоит посмотреть.\nВодоем обладает статусом памятника природы.',
    )).toBe('Водоем обладает статусом памятника природы.');
  });

  it('настоящий текст с тем же началом не трогается', () => {
    const real = [
      'Это Зеленовские озерки в Камчатском крае — природный комплекс термальных источников.',
      'Это зимнее сап-путешествие по реке Паратунка в Камчатском крае позволяет увидеть ландшафты.',
      'Водопад, место, которое стоит посмотреть весной.',
    ];
    for (const t of real) expect(stripFillerLead(t)).toBe(t);
  });

  it('одна заглушка — пустая строка, а не шаблон (§4.0)', () => {
    expect(stripFillerLead('Это Сопка Петровская в Камчатском крае. Место, которое стоит посмотреть.')).toBe('');
    expect(stripFillerLead(null)).toBe('');
    expect(stripFillerLead(undefined)).toBe('');
  });

  it('снимается везде, где маршрут показывается: страница, API, каталог, категории', () => {
    expect(code('app/routes/[id]/page.tsx')).toMatch(/description: stripFillerLead\(stripSourceAttribution\(/);
    expect(code('app/api/routes/[id]/route.ts')).toMatch(/description: stripFillerLead\(r\.description as string \| null\)/);
    expect(code('lib/routes/catalog-query.ts')).toMatch(/description: {2}stripFillerLead\(r\.description as string \| null\)/);
    expect(code('components/routes/CategoryPage.tsx')).toMatch(/description: stripFillerLead\(r\.description\)/);
  });
});
