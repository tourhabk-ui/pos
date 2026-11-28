/**
 * Подвал сайта показывает ОДИН новостной канал: в РФ — MAX, иначе Telegram
 * (слово владельца 28.11). Канал считает сервер (newsChannelForRequest) и
 * передаёт пропом: подвал живёт и в клиентском дереве карточки тура, где
 * `headers()` звать нельзя, а переменные окружения не `NEXT_PUBLIC`.
 *
 * Рендером: подвал без пропа и с пропом, низ каталога по заголовкам.
 * Текстом — только серверный каркас, который jsdom не рендерит (корневой
 * layout, главная), и запреты: подвал не читает окружение и заголовки,
 * карточка не определяет язык в браузере. Планер и карточка тура — рендером в
 * planner-login-gate и tour-card-place-offers.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { lang } = vi.hoisted(() => ({ lang: { v: null as string | null } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(lang.v ? { 'accept-language': lang.v } : {}) }));

import { Footer } from '@/components/layout/Footer';
import { CatalogFooter } from '@/components/marketplace/CatalogFooter';
import { ORGANIZATION_PROFILES } from '@/lib/seo/organization-profiles';
import { newsChannelForRequest, NEWS_CHANNEL_LABELS } from '@/lib/seo/news-channel';

const TG = ORGANIZATION_PROFILES.telegramChannel;
const MAX = ORGANIZATION_PROFILES.maxChannel;
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const hrefs = (root: HTMLElement) => [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));

afterEach(() => { cleanup(); lang.v = null; vi.unstubAllEnvs(); });

describe('подвал: одна ссылка на новостной канал', () => {
  it('без пропа — Telegram-канал из реестра, канала MAX нет, поддержка на месте', () => {
    vi.stubEnv('TELEGRAM_CHANNEL_LINK', 'https://t.me/from_env');
    const { container } = render(<Footer />);
    expect(screen.getByRole('link', { name: NEWS_CHANNEL_LABELS.telegram }).getAttribute('href')).toBe(TG);
    expect(hrefs(container)).not.toContain(MAX);
    // Подвал окружение не читает: переменная действует только на сервере.
    expect(hrefs(container)).not.toContain('https://t.me/from_env');
    expect(hrefs(container)).toContain(ORGANIZATION_PROFILES.telegramSupport);
  });

  it('посетитель из РФ — «Канал в MAX», Telegram-канала нет', () => {
    const { container } = render(<Footer newsChannel={newsChannelForRequest(new Headers({ 'accept-language': 'ru-RU' }))} />);
    expect(screen.getByRole('link', { name: 'Канал в MAX' }).getAttribute('href')).toBe(MAX);
    expect(hrefs(container)).not.toContain(TG);
    expect(screen.queryByRole('link', { name: 'Telegram-канал' })).toBeNull();
    expect(hrefs(container)).toContain(ORGANIZATION_PROFILES.telegramSupport);
  });

  it('посетитель не из РФ — «Telegram-канал», канала MAX нет', () => {
    const { container } = render(<Footer newsChannel={newsChannelForRequest(new Headers({ 'accept-language': 'en-US' }))} />);
    expect(screen.getByRole('link', { name: 'Telegram-канал' }).getAttribute('href')).toBe(TG);
    expect(hrefs(container)).not.toContain(MAX);
  });
});

describe('низ каталога считает канал по заголовкам запроса', () => {
  it('ru-RU — MAX', async () => {
    lang.v = 'ru-RU';
    const { container } = render(await CatalogFooter());
    expect(hrefs(container)).toContain(MAX);
    expect(hrefs(container)).not.toContain(TG);
  });

  it('en и пустые заголовки — Telegram', async () => {
    for (const v of ['en', null]) {
      lang.v = v;
      const { container } = render(await CatalogFooter());
      expect(hrefs(container)).toContain(TG);
      expect(hrefs(container)).not.toContain(MAX);
      cleanup();
    }
  });
});

describe('серверный каркас передаёт канал, посчитанный по заголовкам', () => {
  it('корневой layout: заголовки, уже прочитанные для языка, — в newsChannelForRequest, итог — в подвал', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain("import { newsChannelForRequest } from '@/lib/seo/news-channel'");
    expect(layout).toContain("import { ORGANIZATION_PROFILES, ORGANIZATION_SAME_AS } from '@/lib/seo/organization-profiles'");
    expect(layout).toMatch(/const newsChannel = newsChannelForRequest\(requestHeaders\)/);
    expect(layout).toMatch(/Footer newsChannel=\{newsChannel\} \/><\/SiteFooter>/);
  });

  it('главная: канал из headers() — в подвал десктоп-дерева', () => {
    const page = read('app/page.tsx');
    expect(page).toContain("import { newsChannelForRequest } from '@/lib/seo/news-channel'");
    expect(page).toMatch(/const newsChannel = newsChannelForRequest\(await headers\(\)\)/);
    expect(page).toMatch(/Footer showGuide=\{false\} newsChannel=\{newsChannel\} \/>/);
  });
});

describe('запреты: клиентское дерево заголовков и окружения не читает', () => {
  it('подвал берёт из модуля канала только тип и окружения не читает', () => {
    const footer = read('components/layout/Footer.tsx');
    expect(footer).toContain("import type { NewsChannelLink } from '@/lib/seo/news-channel'");
    expect(footer).not.toMatch(/import \{[^}]*\} from '@\/lib\/seo\/news-channel'/);
    expect(footer).not.toMatch(/process\.env|CHANNEL_LINK|next\/headers/);
    expect(footer).not.toMatch(/export (type|interface) NewsChannel/);
  });

  it('карточка тура не читает заголовки и язык браузера; тип — из модуля канала, не из подвала', () => {
    const card = read('app/catalog/tours/[id]/_TourDetailClient.tsx');
    expect(card).not.toMatch(/navigator\.language|next\/headers|CHANNEL_LINK/);
    expect(card).toContain("import type { NewsChannelLink } from '@/lib/seo/news-channel'");
    const page = read('app/catalog/tours/[id]/page.tsx');
    expect(page).not.toMatch(/from '@\/components\/layout\/Footer'/);
    expect(page).toMatch(/export const revalidate = 3600;/);
  });

  it('модуль канала не читает окружение при загрузке', async () => {
    vi.resetModules();
    vi.stubEnv('MAX_CHANNEL_LINK', 'https://max.ru/at_load');
    const mod = await import('@/lib/seo/news-channel');
    vi.stubEnv('MAX_CHANNEL_LINK', 'https://max.ru/at_call');
    expect(mod.newsChannelForRequest(new Headers({ 'accept-language': 'ru' })).href).toBe('https://max.ru/at_call');
  });
});
