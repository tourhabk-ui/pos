/**
 * Страница /kuzmich: текст 400+ слов, FAQ, WebApplication JSON-LD,
 * заголовок и описание под выдачу (Сыщик, 22.11).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KUZMICH_MAX_URL, KUZMICH_TELEGRAM_URL } from '@/components/shared/KuzmichActions';
import {
  KUZMICH_FAQ,
  KUZMICH_FAQ_HEADING,
  KUZMICH_LEAD,
  KUZMICH_PAGE_DESCRIPTION,
  KUZMICH_PAGE_H1,
  KUZMICH_PAGE_TITLE,
  KUZMICH_RELATED_HEADING,
  KUZMICH_RELATED_LINKS,
  KUZMICH_SECTIONS,
  KUZMICH_TEXT_LINKS,
  kuzmichVisibleText,
  kuzmichWebApplicationJsonLd,
  kuzmichWordCount,
} from '@/lib/seo/kuzmich-page';
import KuzmichAbout, { KuzmichIntro } from '@/app/kuzmich/KuzmichAbout';

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[A-Za-zА-Яа-я0-9]/.test(w));
}

const BRAND = ' | Ведар';
const page = readFileSync('app/kuzmich/page.tsx', 'utf8');
const aboutSrc = readFileSync('app/kuzmich/KuzmichAbout.tsx', 'utf8');
const client = readFileSync('app/kuzmich/_KuzmichClient.tsx', 'utf8');
const pageBody = page.slice(page.indexOf('export default function'));

describe('мета /kuzmich', () => {
  it('title с брендом ≤ 60, description ≤ 160, без цен и оценочных слов', () => {
    expect((KUZMICH_PAGE_TITLE + BRAND).length).toBeLessThanOrEqual(60);
    expect(KUZMICH_PAGE_DESCRIPTION.length).toBeGreaterThanOrEqual(70);
    expect(KUZMICH_PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    const blob = [KUZMICH_PAGE_TITLE, KUZMICH_PAGE_DESCRIPTION, kuzmichVisibleText()].join('\n');
    expect(blob).not.toMatch(/₽|руб|kamchatourhub/i);
    expect(blob).not.toMatch(/лучш|уникальн|высочайш/i);
  });

  it('страница берёт title, description и WebApplication из модуля', () => {
    expect(page).toMatch(/title: KUZMICH_PAGE_TITLE/);
    expect(page).toMatch(/description: KUZMICH_PAGE_DESCRIPTION/);
    expect(page).toMatch(/kuzmichWebApplicationJsonLd/);
    expect(pageBody).toMatch(/KuzmichIntro/);
    expect(pageBody).toMatch(/KuzmichClient/);
    expect(pageBody).toMatch(/KuzmichAbout/);
  });
});

describe('текст /kuzmich', () => {
  it('первый абзац сразу отвечает, кто такой Кузьмич и что он умеет', () => {
    expect(KUZMICH_LEAD).toMatch(/^Кузьмич — AI-помощник платформы Ведар/);
    expect(KUZMICH_LEAD).toMatch(/туры с витрины/);
    expect(KUZMICH_LEAD).toMatch(/@kuzmichai_bot/);
    expect(KUZMICH_PAGE_H1).toBe(KUZMICH_PAGE_TITLE);
  });

  it('прямой ответ умещается в первые 40 слов, H2 — вопросы, текст в серверном HTML', () => {
    const first = words(`${KUZMICH_PAGE_H1} ${KUZMICH_LEAD}`).slice(0, 40).join(' ');
    expect(first).toMatch(/Кузьмич/);
    expect(first).toMatch(/AI-помощник/);
    expect(first).toMatch(/Ведар/);
    expect(first).toMatch(/туры/);
    expect(first).toMatch(/места/);
    expect(first).toMatch(/погоду|обстановку/);
    expect(words(KUZMICH_LEAD).length).toBeLessThanOrEqual(40);
    for (const s of KUZMICH_SECTIONS) expect(s.heading, s.id).toMatch(/\?$/);
    expect(aboutSrc).not.toMatch(/['"]use client['"]/);
    expect(page).not.toMatch(/['"]use client['"]/);
    expect(readFileSync('components/faq/FaqSection.tsx', 'utf8')).not.toMatch(/['"]use client['"]/);
    expect(pageBody.indexOf('KuzmichIntro')).toBeGreaterThan(0);
    expect(pageBody.indexOf('KuzmichAbout')).toBeGreaterThan(pageBody.indexOf('KuzmichIntro'));
    expect(pageBody.indexOf('KuzmichClient')).toBeGreaterThan(pageBody.indexOf('KuzmichAbout'));
    expect(pageBody).toMatch(/order-last/);
  });

  it('видимый текст длиннее 400 слов', () => {
    expect(kuzmichWordCount()).toBeGreaterThanOrEqual(400);
  });

  it('называет каналы, MCP, A2A, WebMCP и что не заменяет оператора и гида', () => {
    const text = kuzmichVisibleText();
    expect(text).toMatch(/@kuzmichai_bot/);
    expect(text).toMatch(/max\.ru\/id4101147649_bot/);
    expect(text).toMatch(/t\.me\/kamchatka_real/);
    expect(text).toMatch(/max\.ru\/id4101147649_biz/);
    expect(text).toMatch(/MCP/);
    expect(text).toMatch(/A2A/);
    expect(text).toMatch(/WebMCP/);
    expect(text).toMatch(/не заменяет туроператора и не заменяет гида/);
    expect(text).not.toMatch(/kamchatourhub/i);
  });

  it('ссылки на каталог и тематические страницы, адреса ботов — те же, что в действиях Кузьмича', () => {
    expect(KUZMICH_RELATED_LINKS.map((l) => l.href)).toEqual([
      '/catalog',
      '/kogda-ehat-na-kamchatku',
      '/kamchatka-samostoyatelno',
      '/medvedi-kamchatki',
      '/safety',
    ]);
    expect(KUZMICH_TEXT_LINKS.find((l) => l.text === '@kuzmichai_bot')?.href).toBe(KUZMICH_TELEGRAM_URL);
    expect(KUZMICH_TEXT_LINKS.find((l) => l.text === 'max.ru/id4101147649_bot')?.href).toBe(KUZMICH_MAX_URL);
  });
});

describe('рендер без JS: H1, FAQ и ссылки в серверном HTML', () => {
  const html = renderToStaticMarkup(
    <>
      <KuzmichIntro />
      <KuzmichAbout />
    </>,
  );

  it('H1 называет Кузьмича, лид и разделы видны в HTML', () => {
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(html).toContain(KUZMICH_PAGE_H1);
    expect(html).toContain('AI-помощник платформы Ведар');
    expect(html).toContain('@kuzmichai_bot');
    for (const s of KUZMICH_SECTIONS) expect(html, s.id).toContain(s.heading);
    expect(html).toContain(KUZMICH_FAQ_HEADING);
    expect(html).toContain(KUZMICH_RELATED_HEADING);
  });

  it('FAQ и ссылки видны в том же HTML, разметка FAQPage совпадает с текстом', () => {
    for (const item of KUZMICH_FAQ) {
      expect(html).toContain(item.question);
      expect(html).toContain(item.answer);
    }
    expect(html).toContain('FAQPage');
    for (const l of KUZMICH_RELATED_LINKS) {
      expect(html).toContain(`href="${l.href}"`);
      expect(html).toContain(l.label);
    }
    expect(html).toContain(KUZMICH_TELEGRAM_URL);
    expect(html).toContain(KUZMICH_MAX_URL);
  });

  it('в чате нет второго H1; на странице ровно один', () => {
    expect(client).not.toMatch(/<h1\b/);
    expect(pageBody).not.toMatch(/<h1\b/);
  });
});

describe('FAQ и JSON-LD', () => {
  it('5–7 вопросов из того же массива, что рендер', () => {
    expect(KUZMICH_FAQ.length).toBeGreaterThanOrEqual(5);
    expect(KUZMICH_FAQ.length).toBeLessThanOrEqual(7);
    for (const item of KUZMICH_FAQ) {
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.answer.length).toBeGreaterThan(0);
    }
  });

  it('WebApplication: имя, категория, система, url, издатель — организация; без оценок и цен', () => {
    const ld = kuzmichWebApplicationJsonLd('https://vedarai.ru');
    expect(ld['@type']).toBe('WebApplication');
    expect(ld.name).toBe('Кузьмич');
    expect(ld.applicationCategory).toBe('TravelApplication');
    expect(ld.operatingSystem).toBe('Web, Telegram, MAX');
    expect(ld.url).toBe('https://vedarai.ru/kuzmich');
    expect(ld.publisher).toEqual({ '@id': 'https://vedarai.ru/#organization' });
    expect(ld).not.toHaveProperty('aggregateRating');
    expect(ld).not.toHaveProperty('offers');
    const raw = JSON.stringify(ld);
    expect(raw).not.toMatch(/₽|price|ratingValue|kamchatourhub/i);
  });
});
