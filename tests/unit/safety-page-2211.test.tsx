/**
 * Страница /safety: прямой ответ на «безопасно ли ехать», FAQ, Article JSON-LD,
 * заголовок и описание под выдачу (Сыщик, 22.11).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BRAND_SUFFIX, TITLE_LIMIT } from '@/lib/seo/title-fit';
import { formatRecordDate, recordDateIso } from '@/lib/seo/record-modified';
import {
  SAFETY_AUTHOR,
  SAFETY_FAQ,
  SAFETY_FAQ_HEADING,
  SAFETY_INCIDENTS_LEAD,
  SAFETY_INCIDENTS_PREP_HEADING,
  SAFETY_LEAD,
  SAFETY_LIVE_HEADING,
  SAFETY_PAGE_DATE,
  SAFETY_PAGE_DESCRIPTION,
  SAFETY_PAGE_H1,
  SAFETY_PAGE_TITLE,
  SAFETY_RELATED_LINKS,
  SAFETY_SECTIONS,
  SAFETY_SOURCES,
  SAFETY_TEXT_LINKS,
  safetyArticleJsonLd,
  safetyVisibleText,
  safetyWordCount,
} from '@/lib/seo/safety-page';
import SafetyAbout, { SafetyIntro, SafetyLiveIntro } from '@/app/safety/SafetyAbout';

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[A-Za-zА-Яа-я0-9]/.test(w));
}

const page = readFileSync('app/safety/page.tsx', 'utf8');
const aboutSrc = readFileSync('app/safety/SafetyAbout.tsx', 'utf8');
const client = readFileSync('app/safety/_SafetyClient.tsx', 'utf8');
const loading = readFileSync('app/safety/loading.tsx', 'utf8');
const incidents = readFileSync('app/safety/incidents/page.tsx', 'utf8');
const pageBody = page.slice(page.indexOf('export default function'));

describe('мета /safety', () => {
  it('title с брендом ≤ 60, description ≤ 160, без цен и оценочных слов', () => {
    expect((SAFETY_PAGE_TITLE + BRAND_SUFFIX).length).toBeLessThanOrEqual(60);
    expect(SAFETY_PAGE_TITLE.length + BRAND_SUFFIX.length).toBeLessThanOrEqual(TITLE_LIMIT);
    expect(SAFETY_PAGE_DESCRIPTION.length).toBeGreaterThanOrEqual(70);
    expect(SAFETY_PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    const blob = [SAFETY_PAGE_TITLE, SAFETY_PAGE_DESCRIPTION, safetyVisibleText()].join('\n');
    expect(blob).not.toMatch(/₽|руб|kamchatourhub/i);
    expect(blob).not.toMatch(/лучш|уникальн|высочайш/i);
  });

  it('страница берёт title, description и Article из модуля', () => {
    expect(page).toMatch(/title: SAFETY_PAGE_TITLE/);
    expect(page).toMatch(/description: SAFETY_PAGE_DESCRIPTION/);
    expect(page).toMatch(/safetyArticleJsonLd/);
    expect(pageBody).toMatch(/SafetyIntro/);
    expect(pageBody).toMatch(/SafetyAbout/);
    expect(pageBody).toMatch(/SafetyLiveIntro/);
    expect(pageBody).toMatch(/SafetyLive/);
    expect(pageBody).toMatch(/Suspense/);
    expect(page).toMatch(/SafetyClient/);
  });
});

describe('текст /safety', () => {
  it('первый абзац сразу отвечает, безопасно ли ехать, и называет риски', () => {
    expect(SAFETY_PAGE_H1).toBe('Безопасно ли ехать на Камчатку');
    expect(SAFETY_LEAD).toMatch(/^Ехать на Камчатку можно/);
    expect(SAFETY_LEAD).toMatch(/медвед/);
    expect(SAFETY_LEAD).toMatch(/погод/);
    expect(SAFETY_LEAD).toMatch(/вулкан/);
    expect(SAFETY_LEAD).toMatch(/воду/);
    expect(SAFETY_LEAD).toMatch(/связь/);
    expect(SAFETY_LEAD).toMatch(/МЧС/);
  });

  it('прямой ответ умещается в первые 40 слов, H2 — вопросы, текст в серверном HTML', () => {
    const first = words(`${SAFETY_PAGE_H1} ${SAFETY_LEAD}`).slice(0, 40).join(' ');
    expect(first).toMatch(/Ехать на Камчатку можно/);
    expect(first).toMatch(/медвед/);
    expect(first).toMatch(/погод/);
    expect(first).toMatch(/вулкан/);
    expect(first).toMatch(/воду/);
    expect(first).toMatch(/связь/);
    expect(words(SAFETY_LEAD).length).toBeLessThanOrEqual(40);
    for (const s of SAFETY_SECTIONS) expect(s.heading, s.id).toMatch(/\?$/);
    expect(SAFETY_LIVE_HEADING).toMatch(/\?$/);
    expect(aboutSrc).not.toMatch(/['"]use client['"]/);
    expect(page).not.toMatch(/['"]use client['"]/);
    expect(readFileSync('components/faq/FaqSection.tsx', 'utf8')).not.toMatch(/['"]use client['"]/);
    expect(pageBody.indexOf('<SafetyIntro')).toBeGreaterThan(0);
    expect(pageBody.indexOf('<SafetyLiveIntro')).toBeGreaterThan(pageBody.indexOf('<SafetyIntro'));
    expect(pageBody.indexOf('<SafetyLive ')).toBeGreaterThan(pageBody.indexOf('<SafetyLiveIntro'));
    expect(pageBody.indexOf('<SafetyAbout')).toBeGreaterThan(pageBody.indexOf('<SafetyLive '));
  });

  it('видимый текст длиннее 400 слов и опирается на официальные источники', () => {
    expect(safetyWordCount()).toBeGreaterThanOrEqual(400);
    const text = safetyVisibleText();
    expect(text).toMatch(/24-П/);
    expect(text).toMatch(/29 января 2026/);
    expect(text).toMatch(/KVERT/);
    expect(text).toMatch(/10 рабочих дней/);
    expect(text).toMatch(/\b112\b/);
    expect(text).not.toMatch(/kamchatourhub/i);
    expect(SAFETY_SOURCES.length).toBeGreaterThanOrEqual(10);
    expect(SAFETY_SOURCES.some((s) => s.href.includes('41.mchs.gov.ru'))).toBe(true);
    expect(SAFETY_SOURCES.some((s) => s.href.includes('kronoki.ru'))).toBe(true);
    expect(SAFETY_SOURCES.some((s) => s.href.includes('kvert.febras.net'))).toBe(true);
  });
});

describe('рендер без JS: H1, FAQ и ссылки в серверном HTML', () => {
  const html = renderToStaticMarkup(
    <>
      <SafetyIntro />
      <SafetyLiveIntro />
      <SafetyAbout />
    </>,
  );

  it('H1, лид и разделы видны в HTML', () => {
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(html).toContain(SAFETY_PAGE_H1);
    expect(html).toContain('Ехать на Камчатку можно');
    expect(html).toContain(SAFETY_AUTHOR);
    expect(html).toContain(formatRecordDate(SAFETY_PAGE_DATE));
    expect(html).toContain(`dateTime="${recordDateIso(SAFETY_PAGE_DATE)}"`);
    for (const s of SAFETY_SECTIONS) expect(html, s.id).toContain(s.heading);
    expect(html).toContain(SAFETY_LIVE_HEADING);
    expect(html).toContain('id="radar"');
    expect(html).toContain(SAFETY_FAQ_HEADING);
    const leadAt = html.indexOf('Ехать на Камчатку можно');
    const radarAt = html.indexOf('id="radar"');
    const firstArticleH2 = html.indexOf(SAFETY_SECTIONS[0].heading);
    expect(leadAt).toBeGreaterThan(0);
    expect(radarAt).toBeGreaterThan(leadAt);
    expect(firstArticleH2).toBeGreaterThan(radarAt);
  });

  it('FAQ и ссылки видны в том же HTML, разметка FAQPage совпадает с текстом', () => {
    for (const item of SAFETY_FAQ) {
      expect(html).toContain(item.question);
      expect(html).toContain(item.answer);
    }
    expect(html).toContain('FAQPage');
    for (const l of SAFETY_RELATED_LINKS) {
      expect(html).toContain(`href="${l.href}"`);
      expect(html).toContain(l.label);
    }
    for (const l of SAFETY_TEXT_LINKS) {
      expect(html).toContain(`href="${l.href}"`);
    }
    for (const s of SAFETY_SOURCES) {
      expect(html).toContain(s.href);
    }
  });

  it('в клиенте и на странице нет второго H1; loading отдаёт тот же лид', () => {
    expect(client).not.toMatch(/<h1\b/);
    expect(pageBody).not.toMatch(/<h1\b/);
    expect(loading).toMatch(/SafetyIntro/);
    expect(loading).toMatch(/SafetyLiveIntro/);
    expect(loading).toMatch(/Загрузка обстановки/);
  });
});

describe('FAQ и JSON-LD', () => {
  it('ссылки на живую сводку в статье и FAQ говорят «выше»', () => {
    const volcano = SAFETY_SECTIONS.find((s) => s.id === 'volcanoes' || /вулкан/i.test(s.heading));
    const weather = SAFETY_SECTIONS.find((s) => s.id === 'weather' || /погод/i.test(s.heading));
    expect(volcano?.paragraphs.join(' ')).toMatch(/живой сводкой выше на этой странице/);
    expect(weather?.paragraphs.join(' ')).toMatch(/блоке обстановки выше/);
    expect(SAFETY_FAQ.some((f) => /Живая сводка также стоит выше на этой странице/.test(f.answer))).toBe(true);
    expect(safetyVisibleText()).not.toMatch(/сводк\w* ниже на этой странице|блоке обстановки ниже/);
  });

  it('5–7 вопросов из того же массива, что рендер', () => {
    expect(SAFETY_FAQ.length).toBeGreaterThanOrEqual(5);
    expect(SAFETY_FAQ.length).toBeLessThanOrEqual(7);
    for (const item of SAFETY_FAQ) {
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.answer.length).toBeGreaterThan(0);
    }
  });

  it('Article: автор «Редакция Vedar», dateModified, без оценок и цен', () => {
    const ld = safetyArticleJsonLd('https://vedarai.ru');
    expect(ld['@type']).toBe('Article');
    expect(ld.headline).toBe(SAFETY_PAGE_H1);
    expect(ld.url).toBe('https://vedarai.ru/safety');
    const author = ld.author as { '@type': string; name: string };
    expect(author['@type']).toBe('Organization');
    expect(author.name).toBe(SAFETY_AUTHOR);
    expect(ld.dateModified).toBe(recordDateIso(SAFETY_PAGE_DATE));
    expect(ld.datePublished).toBe(recordDateIso(SAFETY_PAGE_DATE));
    expect(ld).not.toHaveProperty('aggregateRating');
    expect(ld).not.toHaveProperty('offers');
    const raw = JSON.stringify(ld);
    expect(raw).not.toMatch(/₽|price|ratingValue|kamchatourhub/i);
    expect(raw).not.toContain('FAQPage');
  });
});

describe('/safety/incidents', () => {
  it('открывается прямым ответом и ссылкой на разбор, H2 перед выходом — вопрос', () => {
    expect(incidents).toMatch(/SAFETY_INCIDENTS_LEAD/);
    expect(incidents).toMatch(/href="\/safety"/);
    expect(incidents).toMatch(/SAFETY_INCIDENTS_PREP_HEADING/);
    expect(SAFETY_INCIDENTS_PREP_HEADING).toMatch(/\?$/);
    expect(SAFETY_INCIDENTS_LEAD).toMatch(/безопасно ли ехать/);
    expect(incidents).toMatch(/SAFETY_RELATED_LINKS/);
    expect(incidents).toMatch(/SAFETY_AUTHOR/);
  });
});
