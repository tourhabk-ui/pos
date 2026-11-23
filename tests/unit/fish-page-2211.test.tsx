/**
 * Страница /fish: прямой ответ на «рыбалка на Камчатке», FAQ, Article JSON-LD,
 * заголовок и описание под выдачу (Сыщик, 22.11).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/lib/fish/fishing-tours', () => ({ getFishingTours: async () => [] }));
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BRAND_SUFFIX, TITLE_LIMIT } from '@/lib/seo/title-fit';
import { formatRecordDate, recordDateIso } from '@/lib/seo/record-modified';
import { FISH_TEXT_REVISION } from '@/lib/fish/fish-sources';
import {
  FISH_AUTHOR,
  FISH_FAQ,
  FISH_FAQ_HEADING,
  FISH_LEAD,
  FISH_PAGE_DATE,
  FISH_PAGE_DESCRIPTION,
  FISH_PAGE_H1,
  FISH_PAGE_TITLE,
  FISH_RELATED_LINKS,
  FISH_SECTIONS,
  FISH_SOURCES,
  FISH_TEXT_LINKS,
  fishArticleJsonLd,
  fishVisibleText,
  fishWordCount,
} from '@/lib/seo/fish-page';
import FishIndexAbout, { FishIndexFirstSection, FishIndexIntro, FishIndexSources } from '@/components/fish/FishIndexAbout';

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[A-Za-zА-Яа-я0-9]/.test(w));
}

const page = readFileSync('app/fish/page.tsx', 'utf8');
const aboutSrc = readFileSync('components/fish/FishIndexAbout.tsx', 'utf8');
const pageBody = page.slice(page.indexOf('export default async function'));

describe('мета /fish', () => {
  it('title с брендом ≤ 60, description ≤ 160, без цен', () => {
    expect((FISH_PAGE_TITLE + BRAND_SUFFIX).length).toBeLessThanOrEqual(60);
    expect(FISH_PAGE_TITLE.length + BRAND_SUFFIX.length).toBeLessThanOrEqual(TITLE_LIMIT);
    expect(FISH_PAGE_DESCRIPTION.length).toBeGreaterThanOrEqual(70);
    expect(FISH_PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    const blob = [FISH_PAGE_TITLE, FISH_PAGE_DESCRIPTION, fishVisibleText()].join('\n');
    expect(blob).not.toMatch(/₽|руб/);
    expect(blob).toMatch(/Рыбалка на Камчатке/);
  });

  it('страница берёт title, description и Article из модуля', () => {
    expect(page).toMatch(/title: FISH_PAGE_TITLE/);
    expect(page).toMatch(/description: FISH_PAGE_DESCRIPTION/);
    expect(page).toMatch(/fishArticleJsonLd/);
    expect(pageBody).toMatch(/FishIndexIntro/);
    expect(pageBody).toMatch(/FishIndexFirstSection/);
    expect(pageBody).toMatch(/FishIndexAbout/);
    expect(pageBody).toMatch(/OfficialSeasonNote/);
    expect(pageBody).toMatch(/FishIndexSources/);
  });
});

describe('текст /fish', () => {
  it('первый абзац сразу отвечает, что рыбалка возможна, и называет виды', () => {
    expect(FISH_PAGE_H1).toBe('Рыбалка на Камчатке');
    expect(FISH_LEAD).toMatch(/^Рыбалка на Камчатке возможна/);
    expect(FISH_LEAD).toMatch(/лосос/);
    expect(FISH_LEAD).toMatch(/путёвк/);
    expect(FISH_LEAD).toMatch(/палтус/);
    expect(FISH_LEAD).toMatch(/навагу/);
    expect(FISH_LEAD).toMatch(/Быстрой/);
    expect(FISH_LEAD).toMatch(/Жупановой/);
    expect(FISH_LEAD).toMatch(/Опале/);
    expect(FISH_LEAD).toMatch(/Авачинском заливе/);
  });

  it('прямой ответ умещается в первые 40 слов, H2 разделов — вопросы, текст в серверном HTML', () => {
    const first = words(`${FISH_PAGE_H1} ${FISH_LEAD}`).slice(0, 40).join(' ');
    expect(first).toMatch(/Рыбалка на Камчатке возможна/);
    expect(first).toMatch(/лосос/);
    expect(first).toMatch(/путёвк/);
    expect(first).toMatch(/Быстрой/);
    expect(first).toMatch(/Авачинском/);
    expect(words(FISH_LEAD).length).toBeLessThanOrEqual(40);
    for (const s of FISH_SECTIONS) expect(s.heading, s.id).toMatch(/\?$/);
    expect(aboutSrc).not.toMatch(/['"]use client['"]/);
    expect(page).not.toMatch(/['"]use client['"]/);
    expect(pageBody.indexOf('<FishIndexIntro')).toBeGreaterThan(0);
    expect(pageBody.indexOf('<FishIndexFirstSection')).toBeGreaterThan(pageBody.indexOf('<FishIndexIntro'));
    expect(pageBody.indexOf('OfficialSeasonNote')).toBeGreaterThan(pageBody.indexOf('<FishIndexFirstSection'));
    expect(pageBody.indexOf('<FishIndexAbout')).toBeGreaterThan(pageBody.indexOf('OfficialSeasonNote'));
  });

  it('видимый текст опирается на источники и называет правила', () => {
    expect(fishWordCount()).toBeGreaterThanOrEqual(400);
    const text = fishVisibleText();
    expect(text).toMatch(/путёвк/);
    expect(text).toMatch(/Госуслуги41/);
    expect(text).toMatch(/поймал — отпустил/);
    expect(text).toMatch(/озеро Курильское/);
    expect(text).toMatch(/реки Быстрой/);
    expect(text).not.toMatch(/kamchatourhub/i);
    expect(FISH_SOURCES.length).toBeGreaterThanOrEqual(6);
    expect(FISH_SOURCES.some((s) => s.href.includes('visitkamchatka.ru'))).toBe(true);
    expect(FISH_SOURCES.some((s) => s.href.includes('kamchatka.fish.gov.ru'))).toBe(true);
    expect(FISH_SOURCES.some((s) => s.href.includes('kam24.ru'))).toBe(true);
  });
});

describe('рендер без JS: H1, FAQ и ссылки в серверном HTML', () => {
  const html = renderToStaticMarkup(
    <>
      <FishIndexIntro />
      <FishIndexFirstSection />
      <FishIndexAbout />
      <FishIndexSources />
    </>,
  );

  it('H1, лид и разделы видны в HTML', () => {
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(html).toContain(FISH_PAGE_H1);
    expect(html).toContain('Рыбалка на Камчатке возможна');
    expect(html).toContain(FISH_AUTHOR);
    expect(html).toContain(formatRecordDate(FISH_PAGE_DATE));
    expect(html).toContain(`dateTime="${recordDateIso(FISH_PAGE_DATE)}"`);
    for (const s of FISH_SECTIONS) expect(html, s.id).toContain(s.heading);
    expect(html).toContain(FISH_FAQ_HEADING);
  });

  it('FAQ и ссылки видны в том же HTML, разметка FAQPage совпадает с текстом', () => {
    for (const item of FISH_FAQ) {
      expect(html).toContain(item.question);
      expect(html).toContain(item.answer);
    }
    expect(html).toContain('FAQPage');
    for (const l of FISH_RELATED_LINKS) {
      expect(html).toContain(`href="${l.href}"`);
      expect(html).toContain(l.label);
    }
    for (const l of FISH_TEXT_LINKS) {
      expect(html).toContain(`href="${l.href}"`);
    }
    for (const s of FISH_SOURCES) {
      expect(html).toContain(s.href);
    }
  });

  it('на странице один H1, виды — это H3, не H2', async () => {
    expect(pageBody).not.toMatch(/<h1\b/);
    expect(pageBody).toMatch(/<h3 className="font-bold/);
    const { default: FishIndexPage } = await import('@/app/fish/page');
    const { unmount } = render(await FishIndexPage());
    const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');
    expect(h2).toContain('Какую рыбу можно поймать на Камчатке и когда?');
    expect(h2).not.toContain('Чавыча');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toContain('Чавыча');
    unmount();
  });
});

describe('FAQ и JSON-LD', () => {
  it('5–7 вопросов из того же массива, что рендер', () => {
    expect(FISH_FAQ.length).toBeGreaterThanOrEqual(5);
    expect(FISH_FAQ.length).toBeLessThanOrEqual(7);
    for (const item of FISH_FAQ) {
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.answer.length).toBeGreaterThan(0);
    }
  });

  it('Article: автор «Редакция Vedar», dateModified, без оценок и цен', () => {
    const ld = fishArticleJsonLd('https://vedarai.ru');
    expect(ld['@type']).toBe('Article');
    expect(ld.headline).toBe(FISH_PAGE_H1);
    expect(ld.url).toBe('https://vedarai.ru/fish');
    const author = ld.author as { '@type': string; name: string };
    expect(author['@type']).toBe('Organization');
    expect(author.name).toBe(FISH_AUTHOR);
    expect(ld.datePublished).toBe(recordDateIso(FISH_TEXT_REVISION));
    expect(ld.dateModified).toBe(recordDateIso(FISH_PAGE_DATE));
    expect(ld).not.toHaveProperty('aggregateRating');
    expect(ld).not.toHaveProperty('offers');
    const raw = JSON.stringify(ld);
    expect(raw).not.toMatch(/₽|price|ratingValue|kamchatourhub/i);
    expect(raw).not.toContain('FAQPage');
  });
});
