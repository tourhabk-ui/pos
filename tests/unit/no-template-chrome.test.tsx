/**
 * Шаблонная обвязка сгенерированной страницы — на главной и в карточке тура
 * её нет (карт-бланш владельца 31.10; приметы — по скиллу frontend-design
 * anthropics/skills, обновление 03.09: «tracked-out ALL-CAPS eyebrow label
 * above every heading», «a monospace face for small data labels», «'→'
 * appended to link and button text», «unnecessary typographic labels above
 * content», «all caps for labels»).
 *
 * Держит:
 *  - карточка тура рендером: секции называют настоящие заголовки h2 («О туре»,
 *    «Кто проводит», «Программа»), надписи-дубля над заголовком нет, ни один
 *    элемент не задан капсом с разрядкой и моноширинным шрифтом;
 *  - запреты по исходнику (регулярка — только «этого быть не должно», CLAUDE.md
 *    §4): на главной (десктоп и телефон) и в карточке тура нет `uppercase` /
 *    `text-transform:uppercase`, JetBrains Mono и «→» в конце подписи; стрелка
 *    lucide `ArrowRight` осталась только у строк-карточек во всю ширину — их
 *    число заморожено; `ds-label` — без капса.
 */
import React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/70',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('notFound'); },
  permanentRedirect: () => { throw new Error('redirect'); },
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/BookingFormClient', () => ({ default: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

const TOUR = {
  id: 70, slug: null, title: 'Восхождение на вулкан Горелый', description: 'Подъём к кратерам и лавовые пещеры.',
  short_description: null, base_price: '15000', price_old: null, price_unit: 'person', activity_type: 'trekking',
  location_type: 'volcano', location_name: 'Вулкан Горелый', latitude: null, longitude: null, meeting_point: null,
  pickup_type: 'hotel_pickup', pickup_details: null, cancellation_policy: null, tour_image: null, photos: [],
  max_participants: 4, min_participants: null, duration_hours: '10', duration_type: 'day', multi_day_count: null,
  difficulty: 'medium', included: ['Трансфер с адреса'], not_included: null, what_to_bring: ['Ботинки'],
  season_start: null, season_end: null, seasonal_only: null, weather_dependent: null, rating: null, review_count: 0,
  operator_name: 'Андрей Запорожец', operator_id: 'p-1', operator_contacts: null, main_place_id: null,
  program: [{ title: 'Дорога к вулкану', text: 'Ранний выезд.' }], safety_notes: ['Держаться группы'],
};

afterEach(() => { cleanup(); });

describe('карточка тура без шаблонной обвязки', () => {
  it('секции называют заголовки h2; надписи-дубля над заголовком нет', () => {
    render(<TourDetailClient tour={TOUR as never} reviews={[]} />);
    for (const name of ['О туре', 'Программа', 'Что включено', 'Кто проводит']) {
      expect(screen.getByRole('heading', { level: 2, name }), name).toBeTruthy();
    }
    // Прежние надписи над заголовками («Как проходит день» над «Программа»,
    // «Снаряжение и сборы» над «Что включено») сняты целиком.
    for (const gone of ['Как проходит день', 'Снаряжение и сборы']) {
      expect(screen.queryByText(gone), gone).toBeNull();
    }
  });

  it('ни один элемент не задан капсом и моноширинным шрифтом', () => {
    const { container } = render(<TourDetailClient tour={TOUR as never} reviews={[]} />);
    const caps = [...container.querySelectorAll('[class]')].filter((el) => /(?:^|\s)uppercase(?:\s|$)/.test(el.getAttribute('class') ?? ''));
    expect(caps.map((el) => el.textContent?.trim())).toEqual([]);
    const mono = [...container.querySelectorAll<HTMLElement>('[style]')].filter((el) => /jetbrains|monospace/i.test(el.style.fontFamily));
    expect(mono.map((el) => el.textContent?.trim())).toEqual([]);
  });
});

const DESK = 'components/homepage/desk';
const FILES = [
  ...readdirSync(join(ROOT, DESK)).filter((f) => f.endsWith('.tsx')).map((f) => `${DESK}/${f}`),
  'app/_home/_HomeV8Client.tsx',
  'app/catalog/tours/[id]/_TourDetailClient.tsx',
];

/** Код без комментариев: в них приметы называются словами. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Стрелка у строки-карточки во всю ширину (иконка слева, текст, стрелка
 * справа) — указатель строки, а не хвост подписи. Их ровно столько.
 */
const ROW_ARROWS: Readonly<Record<string, number>> = {
  'components/homepage/desk/DeskPlanChanges.tsx': 1,
  'components/homepage/desk/DeskTours.tsx': 1,
};

describe('главная и карточка тура: запреты по исходнику', () => {
  it('нет капса с разрядкой, JetBrains Mono и «→» в конце подписи', () => {
    const found: string[] = [];
    for (const f of FILES) {
      const src = code(read(f));
      if (/(?:^|[\s"'`])uppercase(?=[\s"'`])/.test(src)) found.push(`${f}: класс uppercase`);
      if (/text-transform:\s*uppercase/.test(src)) found.push(`${f}: text-transform:uppercase`);
      if (/font-jetbrains|JetBrains/.test(src)) found.push(`${f}: JetBrains Mono`);
      if (/\s→\s*(?:<\/|`|'|")/.test(src)) found.push(`${f}: «→» в конце подписи`);
      if (/<Eyebrow\b/.test(src)) found.push(`${f}: надпись над заголовком`);
    }
    expect(found).toEqual([]);
  });

  it('стрелка ArrowRight — только у строк-карточек, их число заморожено', () => {
    const counts: Record<string, number> = {};
    for (const f of FILES) {
      const n = (code(read(f)).match(/<ArrowRight\b/g) ?? []).length;
      if (n > 0) counts[f] = n;
    }
    expect(counts).toEqual(ROW_ARROWS);
  });

  it('ds-label — подпись поля обычным регистром', () => {
    const css = read('app/globals.css');
    const block = /\.ds-label\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).not.toBe('');
    expect(block).not.toMatch(/text-transform:\s*uppercase/);
  });
});
