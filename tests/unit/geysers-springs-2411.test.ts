/**
 * Усиление существующих страниц 24.11: лид Долины гейзеров и хаб
 * горячих источников. Новых URL нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { landingBySlug } from '@/lib/landings/landings';
import { LandingBody } from '@/components/landings/LandingBody';
import { headingIds } from '@/components/landings/LandingContent';
import { parseArticleMarkdown, faqFromBlocks } from '@/lib/articles/markdown';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('Долина гейзеров: прямой ответ в SSR-лиде', () => {
  it('лид отвечает, как попасть, когда ехать и что увидеть, по уже использованным источникам', () => {
    const l = landingBySlug('dolina-gejzerov-kak-popast');
    expect(l.path).toBe('/dolina-gejzerov-ekskursiya');
    const lead = l.before.split('\n\n')[0];
    expect(lead).toMatch(/^\*\*Коротко\.\*\*/);
    expect(lead).toMatch(/только на вертолёте/);
    expect(lead).toMatch(/в начале июля/);
    expect(lead).toMatch(/гейзеры, пульсирующие источники, грязевые котлы/);
    expect(lead).toMatch(/\[2\]/);
    expect(l.before).toMatch(/## Как попасть в Долину гейзеров\?/);
    expect(l.before).toMatch(/## Когда лучше ехать в Долину гейзеров\?/);
    expect(l.before).toMatch(/## Как проходит экскурсия в Долину гейзеров\?/);
  });

  it('рамка «Коротко» несёт data-lead-answer; FAQPage только из видимых «Частых вопросов»', () => {
    const l = landingBySlug('dolina-gejzerov-kak-popast');
    const before = parseArticleMarkdown(l.before);
    const after = parseArticleMarkdown(l.after);
    const html = renderToStaticMarkup(
      LandingBody({ blocks: before, ids: headingIds(before), callouts: [], figures: [] }),
    );
    expect(html).toMatch(/data-lead-answer/);
    const faq = faqFromBlocks([...before, ...after]);
    expect(faq.length).toBeGreaterThan(0);
    const visible = `${l.before}\n${l.after}`;
    const faqSection = visible.split('## Частые вопросы')[1] ?? '';
    expect(faqSection.length).toBeGreaterThan(0);
    for (const { q } of faq) {
      expect(faqSection, q).toContain(q);
    }
  });
});

describe('хаб /articles/goryachie-istochniki: Налычево и Карымшинские', () => {
  it('миграция добавляет раздел про Карымшинские, ссылки на Налычево и Паратунку, источник ИдиЛесом; цен в новом тексте нет', () => {
    const sql = read('migrations/1511_goryachie_istochniki_karymshinskie.sql');
    expect(sql).toMatch(/WHERE slug = 'goryachie-istochniki'/);
    expect(sql).toMatch(/## Что такое Карымшинские источники\?/);
    expect(sql).toMatch(/\/places\/karymshinskie-istochniki/);
    expect(sql).toMatch(/\/places\/paratunskaya-zona-otdyha/);
    expect(sql).toMatch(/\/places\/nalychevskie-termalnye-istochniki/);
    expect(sql).toMatch(/\/park\/nalychevo/);
    expect(sql).toMatch(/https:\/\/idilesom\.com\/kam\/places\/1519/);
    expect(sql).toMatch(/NOT LIKE '%Что такое Карымшинские источники\?%'/);
    // В новом разделе и FAQ нет цен — старую фразу с 12 000 ₽ как раз убираем.
    const added = sql.split('$new_sec$')[1]?.split('$new_sec$')[0] ?? '';
    const faq = sql.split('$new_faq$')[1]?.split('$new_faq$')[0] ?? '';
    expect(added).toMatch(/43 км по прямой/);
    expect(added + faq).not.toMatch(/₽|руб|стоит от|цены туров/i);
  });

  it('сниппет без «сколько стоит», влезает в 60/160', () => {
    const sql = read('migrations/1511_goryachie_istochniki_karymshinskie.sql');
    const title = sql.match(/meta_title = \$mt\$(.*)\$mt\$/)?.[1] ?? '';
    const desc = sql.match(/meta_description = \$md\$(.*)\$md\$/)?.[1] ?? '';
    expect(title).toBe('Горячие источники Камчатки: где и как добраться');
    expect(title).not.toMatch(/стоит|цен/i);
    expect(title.length + ' | Ведар'.length).toBeLessThanOrEqual(60);
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(desc).toMatch(/Карымшинские/);
    expect(desc).not.toMatch(/цен/i);
  });
});
