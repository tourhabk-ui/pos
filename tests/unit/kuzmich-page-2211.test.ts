/**
 * Страница /kuzmich: текст 400+ слов, FAQ, WebApplication JSON-LD,
 * заголовок и описание под выдачу (Сыщик, 22.11).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KUZMICH_MAX_URL, KUZMICH_TELEGRAM_URL } from '@/components/shared/KuzmichActions';
import {
  KUZMICH_FAQ,
  KUZMICH_LEAD,
  KUZMICH_PAGE_DESCRIPTION,
  KUZMICH_PAGE_H1,
  KUZMICH_PAGE_TITLE,
  KUZMICH_RELATED_LINKS,
  KUZMICH_TEXT_LINKS,
  kuzmichVisibleText,
  kuzmichWebApplicationJsonLd,
  kuzmichWordCount,
} from '@/lib/seo/kuzmich-page';

const BRAND = ' | Ведар';
const page = readFileSync('app/kuzmich/page.tsx', 'utf8');
const about = readFileSync('app/kuzmich/KuzmichAbout.tsx', 'utf8');
const client = readFileSync('app/kuzmich/_KuzmichClient.tsx', 'utf8');

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
    expect(page).toMatch(/<JsonLd /);
    expect(page).toMatch(/<KuzmichIntro /);
    expect(page).toMatch(/<KuzmichClient /);
    expect(page).toMatch(/<KuzmichAbout /);
  });
});

describe('текст /kuzmich', () => {
  it('первый абзац сразу отвечает, кто такой Кузьмич и что он умеет', () => {
    expect(KUZMICH_LEAD).toMatch(/^Кузьмич — AI-помощник туристической платформы Ведар/);
    expect(KUZMICH_LEAD).toMatch(/туры местных операторов/);
    expect(KUZMICH_LEAD).toMatch(/@kuzmichai_bot/);
    expect(KUZMICH_PAGE_H1).toBe(KUZMICH_PAGE_TITLE);
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

describe('FAQ и JSON-LD', () => {
  it('5–7 вопросов, блок рисуется из того же массива', () => {
    expect(KUZMICH_FAQ.length).toBeGreaterThanOrEqual(5);
    expect(KUZMICH_FAQ.length).toBeLessThanOrEqual(7);
    expect(about).toMatch(/FaqSection/);
    expect(about).toMatch(/items=\{KUZMICH_FAQ\}/);
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

describe('один H1 на /kuzmich', () => {
  it('заголовок страницы — один, в чате H1 нет', () => {
    expect(about.match(/<h1\b/g)?.length).toBe(1);
    expect(client).not.toMatch(/<h1\b/);
    expect(page).not.toMatch(/<h1\b/);
  });
});
