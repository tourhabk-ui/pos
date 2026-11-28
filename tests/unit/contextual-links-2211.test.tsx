/**
 * Контекстные ссылки в теле посадочных и ключевых страниц (Сыщик, 22.11).
 * Карта фраз — lib/landings/contextual-links.ts; в тексте не меняем факты,
 * только оборачиваем уже стоящие слова и короткие связки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { parseArticleMarkdown, inlineText } from '@/lib/articles/markdown';
import {
  CONTEXTUAL_LINK_RULES,
  applyContextualLinks,
  applyExactTextLinks,
  collectLinkedHrefs,
} from '@/lib/landings/contextual-links';
import { LandingContent, LandingKuzmich } from '@/components/landings/LandingContent';
import { landingBySlug, relatedLandings, guideAnchor } from '@/lib/landings/landings';
import { KUZMICH_TEXT_LINKS } from '@/lib/seo/kuzmich-page';
import { RelatedLandings } from '@/components/landings/KamchatkaGuide';
import KuzmichAbout, { KuzmichIntro } from '@/components/kuzmich/KuzmichAbout';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('карта контекстных ссылок', () => {
  it('фразы внутри правила идут от длинных к коротким, адреса — внутренние', () => {
    expect(CONTEXTUAL_LINK_RULES.length).toBeGreaterThanOrEqual(3);
    for (const rule of CONTEXTUAL_LINK_RULES) {
      expect(rule.href.startsWith('/'), rule.href).toBe(true);
      const lengths = rule.phrases.map((p) => p.length);
      expect(lengths, rule.href).toEqual([...lengths].sort((a, b) => b - a));
      expect(new Set(rule.phrases).size, rule.href).toBe(rule.phrases.length);
    }
  });

  it('оборачивает фразу в абзаце и не трогает заголовок и источники', () => {
    const md = [
      '**Коротко.** Для рыбалки нужен гид.',
      '',
      '## Нужна ли регистрация в МЧС?',
      '',
      'Для самостоятельного маршрута — регистрация в МЧС [1].',
      '',
      '## Источники',
      '',
      '1. Ведар, регистрация в МЧС: https://vedarai.ru/prepare',
    ].join('\n');
    const blocks = parseArticleMarkdown(md);
    const { before } = applyContextualLinks(blocks, [], { currentPath: '/splav-na-kamchatke' });
    const htmlHints = JSON.stringify(before);
    expect(htmlHints).toContain('"/prepare"');
    const h2 = before.find((b) => b.t === 'h2');
    expect(h2 && h2.t === 'h2' && h2.c.every((n) => n.t !== 'link')).toBe(true);
    const sourcesH2 = before.find((b) => b.t === 'h2' && b.text === 'Источники');
    expect(sourcesH2).toBeTruthy();
    const idx = before.indexOf(sourcesH2!);
    const sourceBlocks = before.slice(idx);
    const phraseLinked = sourceBlocks.some((b) => {
      if (b.t !== 'ol' && b.t !== 'p') return false;
      const nodes = b.t === 'ol' ? b.items.flat() : b.c;
      return nodes.some((n) => n.t === 'link' && n.href === '/prepare' && inlineText(n.c) === 'регистрация в МЧС');
    });
    expect(phraseLinked).toBe(false);
    const para = before.find((b) => b.t === 'p' && inlineText(b.c).includes('регистрация в МЧС'));
    expect(para && para.t === 'p' && para.c.some((n) => n.t === 'link' && n.href === '/prepare')).toBe(true);
  });

  it('не ставит ссылку на саму страницу и не дублирует уже стоящий адрес', () => {
    const already = parseArticleMarkdown('Порядок — на странице [подготовки](/prepare). Регистрация в МЧС нужна.');
    const { before } = applyContextualLinks(already, [], { currentPath: '/tolbachik-samostoyatelno' });
    const hrefs = collectLinkedHrefs(before);
    expect(hrefs.filter((h) => h === '/prepare')).toEqual(['/prepare']);

    const self = parseArticleMarkdown('Регистрация в МЧС нужна при походе.');
    const linked = applyContextualLinks(self, [], { currentPath: '/prepare' });
    expect(collectLinkedHrefs(linked.before)).not.toContain('/prepare');
  });

  it('не повторяет якорь из «Читайте также»', () => {
    const blocks = parseArticleMarkdown('На озере собирается группировка бурых медведей.');
    const { before } = applyContextualLinks(blocks, [], {
      currentPath: '/kamchatka-v-avguste',
      reservedAnchors: ['бурых медведей', 'группировка бурых медведей'],
    });
    expect(collectLinkedHrefs(before)).not.toContain('/medvedi-kamchatki');
  });
});

describe('посадочные отдают ссылки в серверном HTML', () => {
  it('в теле /splav-na-kamchatke «регистрация в МЧС» ведёт на /prepare', () => {
    const landing = landingBySlug('splav-na-kamchatke');
    const reserved = relatedLandings(landing, 5).map(guideAnchor);
    expect(reserved).not.toContain('регистрация в МЧС');
    const html = renderToStaticMarkup(<LandingContent landing={landing} tours={[]} kuzmich />);
    expect(html).toMatch(/<a[^>]*href="\/prepare"[^>]*>регистрация в МЧС<\/a>/);
    expect(html).toContain('data-landing-kuzmich');
    expect(html).toMatch(/<a[^>]*href="\/kuzmich"[^>]*>Кузьмич<\/a>/);
    const related = renderToStaticMarkup(<RelatedLandings landing={landing} />);
    expect(related).not.toMatch(/>регистрация в МЧС</);
  });

  it('«бурых медведей» на странице августа ведёт на /medvedi-kamchatki', () => {
    const landing = landingBySlug('kamchatka-v-avguste');
    const html = renderToStaticMarkup(<LandingContent landing={landing} tours={[]} />);
    expect(html).toMatch(/<a[^>]*href="\/medvedi-kamchatki"[^>]*>[^<]*бурых медведей<\/a>/);
  });

  it('блок Кузьмича ссылается на /kuzmich, а не только в Telegram', () => {
    const html = renderToStaticMarkup(<LandingKuzmich />);
    expect(html).toContain('href="/kuzmich"');
    expect(html).toContain('Кузьмич');
  });

  it('шаблон посадочной применяет карту, а не правит каждый текст руками', () => {
    const src = read('components/landings/LandingContent.tsx');
    expect(src).toContain("from '@/lib/landings/contextual-links'");
    expect(src).toContain('applyContextualLinks');
  });
});

describe('ключевые страницы', () => {
  it('/kuzmich: в теле есть ссылки на каталог, планы, памятку и обстановку', () => {
    const hrefs = new Set(KUZMICH_TEXT_LINKS.map((l) => l.href));
    expect(hrefs.has('/catalog')).toBe(true);
    expect(hrefs.has('/plans')).toBe(true);
    expect(hrefs.has('/prepare')).toBe(true);
    expect(hrefs.has('/safety')).toBe(true);
    const html = renderToStaticMarkup(
      <>
        <KuzmichIntro />
        <KuzmichAbout />
      </>,
    );
    expect(html).toContain('href="/plans"');
    expect(html).toContain('href="/prepare"');
    expect(html).toContain('собрать поездку по дням');
    expect(html).toContain('подготовиться к поездке');
  });

  it('/prepare: в серверном тексте есть ссылки на планы, Кузьмича, рыбалку и медведей', () => {
    const src = read('app/prepare/page.tsx');
    expect(src).toContain('href="/plans"');
    expect(src).toContain('href="/kuzmich"');
    expect(src).toContain('href="/fish"');
    expect(src).toContain('href="/medvedi-kamchatki"');
  });

  it('/plans: вводный абзац и ответы FAQ получают ссылки из карты, JSON-LD остаётся текстом', () => {
    const src = read('app/plans/page.tsx');
    expect(src).toContain('linkedText');
    expect(src).toContain('href="/kuzmich"');
    expect(src).toContain("{linkedText('рыбалка, медведи')}");
    expect(src).toContain('linkedText(f.answer)');
    const faq = read('lib/plans/faq.ts');
    expect(faq).toContain('Когда ехать на Камчатку');
    expect(faq).toContain('памятке перед маршрутом');
    const parts = applyExactTextLinks('вулканы, рыбалка, медведи, океан', [
      { text: 'рыбалка', href: '/fish' },
      { text: 'медведи', href: '/medvedi-kamchatki' },
    ]);
    expect(parts.some((p) => p.href === '/fish' && p.text === 'рыбалка')).toBe(true);
    expect(parts.some((p) => p.href === '/medvedi-kamchatki' && p.text === 'медведи')).toBe(true);
  });
});
