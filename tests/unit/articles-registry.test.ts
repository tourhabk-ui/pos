/**
 * Справочник статей — единый источник, как справочник рыб.
 *
 * Сторож держит ровно то, за что платили карточкой тура: один список, один
 * матчер, детект и подсветка не расходятся. Второй список тем, второй матчер
 * упоминаний или руками заведённые связи «по теме» — это те же расходящиеся
 * копии, только на другом справочнике.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTICLES, ARTICLE_BY_ID, CATEGORY_LABEL, detectArticles, linkifyArticles,
  readingMinutes, articleFullText,
} from '@/lib/articles';
import { FISH_SPECIES } from '@/lib/fish-species';
import { linkifyText, detectLinkables } from '@/lib/text-links';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('справочник статей пригоден к употреблению', () => {
  it('id уникальны и годятся для адреса', () => {
    const ids = ARTICLES.map(a => a.id);
    expect(new Set(ids).size, 'дубли id').toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z0-9-]+$/);
  });

  it('у каждой статьи есть ответ в первом экране и хотя бы одна секция', () => {
    for (const a of ARTICLES) {
      expect(a.lead.length, a.id).toBeGreaterThan(60);
      expect(a.sections.length, a.id).toBeGreaterThan(0);
      for (const s of a.sections) {
        expect(s.heading.length, `${a.id}/${s.heading}`).toBeGreaterThan(0);
        expect(s.paragraphs.length, `${a.id}/${s.heading}`).toBeGreaterThan(0);
      }
    }
  });

  it('категория каждой статьи объявлена в словаре', () => {
    for (const a of ARTICLES) expect(CATEGORY_LABEL[a.category], a.id).toBeTruthy();
  });

  it('дата обновления — ISO и не из будущего', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const a of ARTICLES) {
      expect(a.updated, a.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.updated <= today, `${a.id}: дата из будущего`).toBe(true);
    }
  });

  it('карта по id покрывает весь массив', () => {
    expect(Object.keys(ARTICLE_BY_ID).length).toBe(ARTICLES.length);
  });

  it('время чтения считается и положительно', () => {
    for (const a of ARTICLES) expect(readingMinutes(a), a.id).toBeGreaterThan(0);
  });
});

describe('детект упоминаний', () => {
  it('находит статью по упоминанию в чужом тексте', () => {
    const ids = detectArticles('Перед выходом обязательна регистрация тургруппы').map(a => a.id);
    expect(ids).toContain('registraciya-v-mchs');
  });

  it('нет упоминаний — пустой список, блок не рендерится', () => {
    expect(detectArticles('Обед в кафе на набережной')).toEqual([]);
  });

  it('детект не статфулен: паттерны с флагом g не тащат lastIndex', () => {
    const text = 'МЧС и ещё раз МЧС';
    expect(detectArticles(text).map(a => a.id)).toEqual(detectArticles(text).map(a => a.id));
  });

  it('детект и подсветка не расходятся: что подсветилось — то и найдено', () => {
    const text = 'Нужна регистрация тургруппы, скачайте офлайн-карту заранее';
    const detected = detectArticles(text).map(a => a.id).sort();
    const linked = [...new Set(
      linkifyArticles(text).filter(c => c.entry).map(c => c.entry!.id),
    )].sort();
    expect(linked).toEqual(detected);
  });
});

describe('общий матчер, а не вторая копия', () => {
  it('excludeId убирает самоссылку, остальные статьи остаются', () => {
    const text = 'Про МЧС сказано отдельно, и про офлайн-карту тоже';
    const withSelf = linkifyArticles(text).filter(c => c.entry).map(c => c.entry!.id);
    expect(withSelf).toContain('registraciya-v-mchs');
    const without = linkifyArticles(text, 'registraciya-v-mchs')
      .filter(c => c.entry).map(c => c.entry!.id);
    expect(without).not.toContain('registraciya-v-mchs');
    expect(without).toContain('karta-do-vyhoda');
  });

  it('склейка кусков возвращает исходный текст без потерь', () => {
    const text = 'До выхода: регистрация тургруппы, офлайн-карта, заряженный телефон.';
    expect(linkifyArticles(text).map(c => c.text).join('')).toBe(text);
  });

  it('совпадения не пересекаются', () => {
    const text = 'МЧС, регистрация тургруппы и снова МЧС';
    const chunks = linkifyArticles(text);
    expect(chunks.map(c => c.text).join('')).toBe(text);
  });

  it('матчер работает и на справочнике рыб — он не про статьи', () => {
    const ids = detectLinkables('Ловим чавычу', FISH_SPECIES).map(s => s.id);
    expect(ids).toContain('chavycha');
    const chunks = linkifyText('Ловим чавычу', FISH_SPECIES);
    expect(chunks.map(c => c.text).join('')).toBe('Ловим чавычу');
  });

  it('подсветка рыб переведена на общий матчер — своей нарезки в компоненте нет', () => {
    const src = read('components/shared/DescriptionWithFishLinks.tsx');
    expect(src).toContain('linkifyText');
    expect(src, 'вернулась своя копия нарезки').not.toContain('matches.sort');
  });
});

describe('связи «по теме» выводятся из текста, а не заводятся руками', () => {
  it('в справочнике нет поля со списком связей', () => {
    const src = read('lib/articles.ts');
    expect(src).not.toMatch(/\brelated\s*:/);
  });

  /**
   * Детект намеренно находит и саму статью: её текст содержит собственные
   * ключевые слова. Отсев самоссылки — дело страницы, и она обязана его
   * делать: блок «по теме» со ссылкой на текущую статью это тупик.
   */
  it('детект находит статью в её же тексте — значит странице нужен отсев', () => {
    const mchs = ARTICLE_BY_ID['registraciya-v-mchs'];
    expect(detectArticles(articleFullText(mchs)).map(x => x.id)).toContain(mchs.id);
  });

  it('страница статьи отсеивает самоссылку', () => {
    const src = read('app/articles/[id]/page.tsx');
    expect(src).toContain('detectArticles');
    expect(src, 'отсев самоссылки пропал').toMatch(/filter\(\s*a\s*=>\s*a\.id\s*!==\s*article\.id\s*\)/);
  });

  it('после отсева «по теме» непусто хотя бы у одной статьи — связи реально находятся', () => {
    const anyRelated = ARTICLES.some(
      a => detectArticles(articleFullText(a)).some(x => x.id !== a.id),
    );
    expect(anyRelated).toBe(true);
  });
});
