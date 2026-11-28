/**
 * /kuzmich: чат первым (слово владельца 28.11: «Это кринж. Описание
 * перенести — чат теряется», «Я еле нашёл строку ввода»).
 *
 * Над чатом — заголовок, лид в одну строку со ссылкой «Подробнее» и знаки
 * Telegram и MAX; полное описание и FAQ — на странице «О Кузьмиче»
 * (/o-kuzmiche, #3899: «убрать с чата описание что умеет кузьмич» →
 * «перенести на отдельную»), под чатом страница сама ничего не ставит.
 * «Оставить заявку» — одна ссылка, под полем ввода (владелец: «единственное
 * место со ссылкой на заявку»); на телефоне видны первые четыре чипа.
 *
 * Тест исходников без рендера: раскладку и первый экран судит
 * test/e2e/kuzmich-first-screen.spec.ts (вручную), рендер Intro —
 * kuzmich-page-2211 и kuzmich-telegram-link.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('app/kuzmich/page.tsx', 'utf8');
const pageBody = page.slice(page.indexOf('export default function'));
const client = readFileSync('app/kuzmich/_KuzmichClient.tsx', 'utf8');
const about = readFileSync('components/kuzmich/KuzmichAbout.tsx', 'utf8');

describe('/kuzmich: чат первым', () => {
  it('порядок в DOM — заголовок, чат; описания на странице чата нет; order-last нет', () => {
    expect(page).not.toMatch(/order-last/);
    expect(pageBody.indexOf('KuzmichIntro')).toBeGreaterThan(0);
    expect(pageBody.indexOf('KuzmichClient')).toBeGreaterThan(pageBody.indexOf('KuzmichIntro'));
    expect(pageBody).not.toContain('KuzmichAbout');
  });

  it('знаки ботов — в заголовке страницы; «Подробнее» — на «О Кузьмиче», полное описание там первым абзацем', () => {
    expect(about).toMatch(/href=\{KUZMICH_ABOUT_PATH\}[^>]*>Подробнее/);
    expect(about).not.toMatch(/href="#o-kuzmiche"/);
    expect(about).toMatch(/KUZMICH_TELEGRAM_URL/);
    expect(about).toMatch(/KUZMICH_MAX_URL/);
    expect(about).toMatch(/id="o-kuzmiche"/);
    expect(about).toMatch(/TelegramIcon/);
    expect(about).toMatch(/MaxIcon/);
  });

  it('в чате нет ссылки на Telegram; «Оставить заявку» — одна, под полем ввода', () => {
    expect(client.indexOf('KUZMICH_TELEGRAM_URL')).toBe(-1);
    expect(client.indexOf('href="/request"')).toBe(client.lastIndexOf('href="/request"'));
    expect(client.indexOf('href="/request"')).toBeGreaterThan(client.indexOf('data-kuzmich-input'));
  });

  it('на телефоне — первые четыре чипа, с sm: — все', () => {
    expect(client).toMatch(/CHIPS\.map\(\(chip, i\)/);
    expect(client).toMatch(/i >= 4 \? 'hidden sm:flex' : 'flex'/);
  });
});
