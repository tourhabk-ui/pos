/**
 * Вопросы и ответы на карточке места (слово владельца 17.11 «2 да но аккуратно»).
 *
 * «Аккуратно» у места держится правилами `lib/places/place-faq`:
 *  - ответ — словами раздела карточки (`composeAccessText`, `hazardPhrase`,
 *    номера из `lib/safety/emergency-numbers`);
 *  - без ответа нет и вопроса; «не записано» вопросом не становится;
 *  - «где находится» не говорится по угаданной координате и по заглушке;
 *  - туров и обстановки дня в ответах нет (§9);
 *  - региональный номер — только проверенный владельцем.
 * Разметка FAQPage — из того же массива, что видимый блок.
 *
 * Здесь — вызовом правила и рендером самой карточки.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PlaceData } from '@/components/places/types';
import { placeFaq, type PlaceFaqInput } from '@/lib/places/place-faq';
import { composeAccessText } from '@/lib/places/access-text';
import { hazardPhrase } from '@/lib/safety/hazard-labels';
import { MCHS_REQUIRED_PHRASE } from '@/lib/safety/mchs-registration';
import { VERIFIED_REGIONAL } from '@/lib/safety/emergency-numbers';

vi.mock('next/dynamic', () => ({
  default: (loader: () => unknown) => {
    const name = /components\/(?:[\w-]+\/)*(\w+)\.tsx?/.exec(String(loader))?.[1] ?? 'Dynamic';
    const Stub = () => <div data-dyn={name} />;
    Stub.displayName = `Dyn(${name})`;
    return Stub;
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/hooks/use-catalog-return', () => ({ useCatalogReturnHref: () => '/places' }));

beforeAll(() => {
  globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});
afterEach(cleanup);

const SAFETY = {
  difficultyLevel: 3, altitudeM: 1829, nearestMedicalKm: 42, satCommunicatorRequired: true,
  registrationRequired: true, hazardTypes: ['thermal', 'bears'], phoneRangerMches: null,
};
const FULL: PlaceFaqInput = {
  name: 'Вулкан Горелый', lat: 52.558, lng: 158.03, coordSource: 'surveyed',
  district: null, zone: 'south', accessInfo: 'Подъезд по грунтовой дороге от Паратунки',
  bestSeason: 'Июль — сентябрь, когда сходит снег',
  routes: [{ title: 'Вулкан Горелый', distanceKm: 12, durationHours: 8, difficulty: 'medium', linkKind: 'waypoint' }],
  eco: { zone: 'natural_park', permitRequired: true },
  safety: SAFETY,
};
const BARE: PlaceFaqInput = {
  name: 'Паланские источники', lat: 58.8451, lng: 161.325, coordSource: 'unknown',
  district: null, zone: null, accessInfo: null, bestSeason: null, routes: [], eco: null,
  safety: { difficultyLevel: null, altitudeM: null, nearestMedicalKm: null, satCommunicatorRequired: false,
    registrationRequired: false, hazardTypes: [], phoneRangerMches: null },
};

const byQ = (items: ReturnType<typeof placeFaq>) => Object.fromEntries(items.map((i) => [i.question, i.answer]));
const accessOf = (p: PlaceFaqInput) => composeAccessText({ ...p, registrationRequired: p.safety.registrationRequired, toursCount: 0 });

describe('правило: ответ — словами разделов карточки', () => {
  it('«как добраться» — те же предложения, что раздел карточки, без туров', () => {
    const qa = byQ(placeFaq(FULL));
    expect(qa['Как добраться до места «Вулкан Горелый»?']).toBe(accessOf(FULL).join(' '));
    expect(qa['Как добраться до места «Вулкан Горелый»?']).not.toMatch(/тур/i);
  });

  it('сезон, сложность, высота, опасности, МЧС, связь, медпомощь', () => {
    const qa = byQ(placeFaq(FULL));
    expect(qa['Когда лучше посещать место «Вулкан Горелый»?']).toBe('Июль — сентябрь, когда сходит снег.');
    expect(qa['Насколько сложно посещение места «Вулкан Горелый»?']).toBe('Сложность: «Средний» (3 из 5).');
    expect(qa['Какая высота у места «Вулкан Горелый»?']).toBe(`Высота — ${(1829).toLocaleString('ru-RU')} м.`);
    const hazards = qa['Какие опасности у места «Вулкан Горелый»?'];
    for (const h of ['thermal', 'bears']) expect(hazards).toContain(hazardPhrase(h)!.replace(/[.]$/, ''));
    expect(qa['Нужна ли регистрация в МЧС для посещения места «Вулкан Горелый»?']).toMatch(new RegExp(`^Да\\. ${MCHS_REQUIRED_PHRASE.replace('.', '\\.')}`));
    expect(qa['Нужен ли спутниковый мессенджер у места «Вулкан Горелый»?']).toBe('Да, нужен спутниковый мессенджер.');
    expect(qa['Далеко ли от места «Вулкан Горелый» до медицинской помощи?']).toBe('До медпомощи — 42 км.');
  });

  it('экстренный номер — всегда 112; региональный — только проверенный', () => {
    const plain = byQ(placeFaq(BARE))['Куда звонить в экстренной ситуации у места «Паланские источники»?'];
    expect(plain).toMatch(/^112 — спасение, полиция, скорая\. /);
    const unverified = byQ(placeFaq({ ...BARE, safety: { ...BARE.safety, phoneRangerMches: '+7 999 000-00-00' } }));
    expect(Object.values(unverified).join(' ')).not.toContain('999');
    const v = VERIFIED_REGIONAL[0];
    const verified = byQ(placeFaq({ ...BARE, safety: { ...BARE.safety, phoneRangerMches: v.phone } }));
    expect(verified['Куда звонить в экстренной ситуации у места «Паланские источники»?']).toContain(v.phone);
  });
});

describe('правило: без ответа нет и вопроса', () => {
  it('ничего не записано — только «как добраться» и номер', () => {
    expect(placeFaq(BARE).map((i) => i.question)).toEqual([
      'Как добраться до места «Паланские источники»?',
      'Куда звонить в экстренной ситуации у места «Паланские источники»?',
    ]);
  });

  it('«не нужна» не выводится из «не записано»: МЧС и связь только при «да»', () => {
    const qs = placeFaq({ ...FULL, safety: { ...SAFETY, registrationRequired: false, satCommunicatorRequired: null } })
      .map((i) => i.question).join('\n');
    expect(qs).not.toMatch(/МЧС|спутников/);
  });

  it('опасность без фразы словаря — вопроса нет: неполный список не выдаётся за полный', () => {
    const qs = placeFaq({ ...FULL, safety: { ...SAFETY, hazardTypes: ['thermal', 'lava_tube'] } }).map((i) => i.question);
    expect(qs.some((q) => q.startsWith('Какие опасности'))).toBe(false);
  });

  it('угаданная координата и заглушка — без «где находится»; больше сказать нечего — вопроса нет', () => {
    for (const coordSource of ['geocoded', 'placeholder'] as const) {
      const qa = byQ(placeFaq({ ...FULL, coordSource }));
      const a = qa['Как добраться до места «Вулкан Горелый»?'];
      expect(a).toBe(accessOf(FULL).slice(1).join(' '));
      expect(a).not.toMatch(/км по прямой|Петропавловск/);
      expect(Object.keys(byQ(placeFaq({ ...BARE, coordSource }))).some((q) => q.startsWith('Как добраться'))).toBe(false);
    }
  });
});

const PLACE = {
  id: '4a474632-d8d6-4147-9fa1-ed149edb1a62',
  name: 'Вулкан Горелый',
  description: null, descriptionSource: null, descriptionByModel: false, descriptionWithdrawn: false, descriptionImpression: false,
  essence: null, category: 'volcano', locationType: 'volcano',
  lat: 52.558, lng: 158.03, zone: 'south', district: null,
  photoUrl: null, images: [], photoCount: 0, photoAttribution: null, photoCredits: {}, photoRights: {},
  bestSeason: 'Июль — сентябрь', seasonalNotes: null, accessInfo: null, sourceUrl: null, sourceName: null,
  updatedAt: '2026-10-14T11:17:47.862Z', kuzmichReview: null, chronicle: [], coordSource: 'surveyed',
  eco: null, indigenous: null,
  safety: {
    source: 'manual', difficultyLevel: 3, altitudeM: 1829, altitudeDiffM: null, distanceKm: null,
    terrainType: null, nearestMedicalKm: null, emergencyAccess: null,
    phoneRangerMches: null, satCommunicatorRequired: false, rulesRequired: null, weatherThreshold: null,
    hazardTypes: ['thermal'], capacityPerDay: null, capacityPerDaySource: null, optimalGroupSize: null,
    openFromDate: null, openToDate: null, requiredGear: [], connectivity: null, registrationRequired: true,
    medicalInfo: null,
  },
  volcanoStatus: null, realtime: null,
  routes: [],
  tours: [{ id: 62, title: 'Вулкан Горелый за день', basePrice: 15000, priceUnit: 'per_person', operatorName: 'Край Вулканов' }],
  toursState: 'ok',
  reviewsSummary: { total: 0, avg: null }, reviews: [], nearby: [],
} as unknown as PlaceData;

describe('карточка места: блок и разметка из одного массива', () => {
  it('видимые вопросы и FAQPage совпадают; туров и цен в блоке нет', async () => {
    const { default: PlaceDetailClient } = await import('@/app/places/[id]/_PlaceDetailClient');
    const { container } = render(<PlaceDetailClient id={PLACE.id} initialPlace={PLACE} />);
    const section = screen.getByTestId('faq-section');
    const heading = screen.getByRole('heading', { name: 'Вопросы и ответы' });
    expect(heading.closest('section')!.contains(section), 'блок под своим заголовком').toBe(true);
    const visible = [...section.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    const expected = placeFaq(PLACE).map((i) => [i.question, i.answer]);
    expect(visible).toEqual(expected);
    expect(visible.map(([q]) => q)).toContain('Нужна ли регистрация в МЧС для посещения места «Вулкан Горелый»?');
    expect(section.textContent).not.toMatch(/₽|(^|[^а-яё])тур/i);

    const ld = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => JSON.parse(s.textContent ?? '{}') as { '@type'?: string; mainEntity?: Array<{ name: string; acceptedAnswer: { text: string } }> })
      .find((j) => j['@type'] === 'FAQPage');
    expect(ld, 'разметки FAQPage нет').toBeDefined();
    expect(ld!.mainEntity!.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(visible);
  });
});
