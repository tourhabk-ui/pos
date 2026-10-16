/**
 * Экстренные контакты карточки маршрута и тура — единый проверенный список
 * (16.10, правило «неверный номер в ЧП опаснее его отсутствия»).
 *
 * До 16.10 /api/safety/warnings читал таблицу emergency_contacts по зоне
 * маршрута. А таблица — верстак сверки (#366): в ней сид 0645/070 с
 * номерами, чьё происхождение неизвестно (722), — «МЧС западный регион
 * +7 (415) 123-45-67», код 415 вместо камчатского 4152. Карточка маршрута
 * отдавала его кнопкой «позвонить».
 *
 * Держится вызовом роута и рендером карточки:
 *  - при любой зоне и без неё — EMERGENCY_NUMBERS, таблица не читается;
 *  - Северные Курилы (Сахалинская область) — только федеральные номера;
 *  - кнопка звонка — telHref (цифры и плюс), как на остальных экранах;
 *  - для туриста таблицу сверки не читает никто, кроме админской переписи;
 *  - номер МЧС из данных места (phone_ranger_mches, писателя в коде нет) —
 *    только проверенный владельцем: карточка места рендером, PDF — вызовом.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const dbQuery = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/safety/alerts', () => ({ activeAlertsForZone: vi.fn(async () => []) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/places/p1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { GET } from '@/app/api/safety/warnings/route';
import SafetyWarnings from '@/components/safety/SafetyWarnings';
import PlaceSafety from '@/components/places/PlaceSafety';
import type { PlaceSafety as SafetyData } from '@/components/places/types';
import { EMERGENCY_NUMBERS, FEDERAL_EMERGENCY, verifiedRegionalNumber } from '@/lib/safety/emergency-numbers';
import { KURIL_NORTH_ZONE } from '@/lib/safety/kuril-north';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { dbQuery.mockReset(); });

/** Строки сида 0645/070, как они лежат в таблице сверки. */
const SEED = [
  { name: 'МЧС западный регион', phone: '+7 (415) 123-45-67', contact_type: 'mches' },
  { name: 'Кроноцкий заповедник', phone: '+7 (415) 444-20-77', contact_type: 'ranger' },
];

function answer(zone: string | null) {
  dbQuery.mockImplementation(async (sql: string) => {
    if (/FROM agent_route_knowledge/.test(sql)) {
      return {
        rows: [{
          title: 'Вулкан Ильинский', location_type: 'volcano', activity_type: 'hiking',
          hazard_types: null, profile_source: null, zone,
          is_open: true, alert_severity: 0, alert_message: null,
        }],
      };
    }
    if (/FROM emergency_contacts/.test(sql)) return { rows: SEED };
    return { rows: [] };
  });
}

async function contactsFor(zone: string | null): Promise<string[]> {
  answer(zone);
  const res = await GET(new Request('http://localhost/api/safety/warnings?route_id=r1'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { emergency_contacts: Array<{ name: string; phone: string }> };
  return body.emergency_contacts.map((c) => c.phone);
}

const phones = (list: ReadonlyArray<{ phone: string }>) => list.map((n) => n.phone);
const askedTable = () => dbQuery.mock.calls.some(([sql]) => /emergency_contacts/.test(String(sql)));

describe('GET /api/safety/warnings — экстренные контакты', () => {
  it('зона с сидом в таблице — проверенный список, номеров сида нет', async () => {
    const got = await contactsFor('western');
    expect(got).toEqual(phones(EMERGENCY_NUMBERS));
    expect(got.join(' ')).not.toMatch(/123-45-67|444-20-77/);
    expect(askedTable()).toBe(false);
  });

  it('без зоны — тот же список, а не пусто', async () => {
    expect(await contactsFor(null)).toEqual(phones(EMERGENCY_NUMBERS));
  });

  it('Северные Курилы — только федеральные: дежурная смена Камчатки их не ведёт', async () => {
    const got = await contactsFor(KURIL_NORTH_ZONE);
    expect(got).toEqual(phones(FEDERAL_EMERGENCY));
    expect(got).toContain('112');
  });
});

describe('карточка: кнопка звонка', () => {
  it('ссылка — номер цифрами, без скобок и дефисов', async () => {
    const data = {
      route_title: 'Вулкан Ильинский', is_open: true, danger_level: 'warning',
      alert_severity: 0, alert_message: null, zone_risk: null,
      zone_alerts: [], zone_alerts_checked: true,
      signals: [{ hazard: 'volcano', level: 'warning', title: 'Вулканическая активность', message: 'м', precautions: [], incident_ref: null, icon: 'mountain' }],
      emergency_contacts: EMERGENCY_NUMBERS.map((n) => ({ name: n.name, phone: n.phone, type: n.type })),
      disclaimer: '',
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    render(<SafetyWarnings routeId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Безопасность маршрута/ }));
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('tel:112');
    expect(hrefs).toContain('tel:+74152301089');
    for (const h of hrefs) expect(h).toMatch(/^tel:\+?\d+$/);
  });
});

describe('таблицу сверки туристу не читает никто', () => {
  it('FROM emergency_contacts — только в админской переписи', () => {
    const root = process.cwd();
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && /(FROM|JOIN)\s+emergency_contacts\b/.test(readFileSync(p, 'utf-8'))) {
          found.push(relative(root, p));
        }
      }
    };
    for (const d of ['app', 'lib', 'components']) walk(join(root, d));
    expect(found).toEqual(['lib/services/safety/emergency-contacts.ts']);
  });
});

describe('номер МЧС из данных места — только проверенный', () => {
  it('сверка по цифрам: формат записи не важен, чужой номер — null', () => {
    expect(verifiedRegionalNumber('+7 (4152) 30-10-89')?.phone).toBe('+7 (4152) 30-10-89');
    expect(verifiedRegionalNumber('8 4152 301089')?.phone).toBe('+7 (4152) 30-10-89');
    expect(verifiedRegionalNumber('+7 (415) 123-45-67')).toBeNull();
    expect(verifiedRegionalNumber(null)).toBeNull();
    expect(verifiedRegionalNumber('')).toBeNull();
  });

  const safety = (phoneRangerMches: string | null): SafetyData => ({
    source: 'manual', difficultyLevel: null, altitudeM: null, altitudeDiffM: null, distanceKm: null,
    terrainType: null, nearestMedicalKm: null, emergencyAccess: null,
    phoneRangerMches, satCommunicatorRequired: false, rulesRequired: null, weatherThreshold: null,
    hazardTypes: [], capacityPerDay: null, capacityPerDaySource: null, optimalGroupSize: null,
    openFromDate: null, openToDate: null, requiredGear: [], connectivity: null, registrationRequired: false,
    medicalInfo: null,
  });
  const mchsLinks = () => screen.queryAllByRole('link').filter((a) => /МЧС/.test(a.textContent ?? ''));

  it('карточка места: записанный в данных чужой номер не показывается', () => {
    render(<PlaceSafety safety={safety('+7 (415) 123-45-67')} placeId="p1" />);
    expect(mchsLinks()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('123-45-67');
  });

  it('карточка места: проверенный номер — кнопкой звонка', () => {
    render(<PlaceSafety safety={safety('8 (4152) 30-10-89')} placeId="p1" />);
    const links = mchsLinks();
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('tel:+74152301089');
  });
});
