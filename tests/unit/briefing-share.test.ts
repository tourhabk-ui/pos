/**
 * Брифинг похода (план FCN, этап 5): ссылка отдаёт ПЛАН и ВРЕМЯ, не положение.
 *
 * Инварианты, ради которых написан этот сторож:
 *  - в снимке нет и не может быть координат: схема API их не принимает,
 *    сборщик их не кладёт. Телефонная PWA не спутниковый маяк, и обещание
 *    слежения — самое опасное, что можно дать контакту вне маршрута;
 *  - контактных данных получателя мы не собираем (ни телефона, ни почты,
 *    ни имени): человек отправляет ссылку сам. Нет ПД — нет трансграничной
 *    передачи и нечему утекать;
 *  - срок жизни ссылки обязателен: ссылка без срока — публикация;
 *  - просроченная и отозванная ссылки различаются словами, а не сваливаются
 *    в общий 404;
 *  - страница брифинга не обещает слежения и объясняет, что делать, когда
 *    время возврата прошло.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildBriefingSnapshot, briefingExpiry, overdueGuidance,
  BRIEFING_MAX_DAYS,
} from '@/lib/preparation/briefing';
import type { PackAssetState } from '@/lib/offline/field-pack';
import type { PrepDomainSummary } from '@/lib/preparation/types';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const NOW = 1_700_000_000_000;

const PACK: PackAssetState[] = [
  { kind: 'waypoints', status: 'ready', note: '7 точек' },
  { kind: 'route', status: 'ready', note: 'Линия сохранена' },
  { kind: 'tiles', status: 'ready', note: 'Карта сохранена' },
  { kind: 'safety_snapshot', status: 'ready', note: 'Условия: 10 мин назад' },
];

const DOMAINS: PrepDomainSummary[] = [
  { domain: 'route', label: 'Маршрут и доступ', prepared: true, items: [] },
  { domain: 'conditions', label: 'Условия и время', prepared: false, items: [] },
];

function snap(over: Partial<Parameters<typeof buildBriefingSnapshot>[0]> = {}) {
  return buildBriefingSnapshot({
    routeTitle: 'Авачинский перевал',
    routeVersion: 3,
    routeGrade: 'Трек',
    waypointsCount: 7,
    departureAt: '2026-09-14',
    returnBy: '2026-09-14T18:00:00.000Z',
    answers: { duration: 'day', party: 'group' },
    packStates: PACK,
    domains: DOMAINS,
    openActionTitles: ['Подтвердить трансфер обратно'],
    now: NOW,
    ...over,
  });
}

describe('снимок брифинга не содержит положения', () => {
  it('в собранном снимке нет ни координат, ни полей о позиции', () => {
    const s = snap();
    const keys = Object.keys(s).join(' ').toLowerCase();
    for (const forbidden of ['lat', 'lng', 'coord', 'position', 'location', 'track', 'crumb']) {
      expect(keys).not.toContain(forbidden);
    }
    // И в значениях тоже: сериализованный снимок не должен нести чисел-координат.
    expect(JSON.stringify(s)).not.toMatch(/"(lat|lng|latitude|longitude)"/);
  });

  it('схема API не принимает координаты даже намеренно (strict)', () => {
    const src = read('app/api/preparation/share/route.ts');
    expect(src).toMatch(/\}\)\.strict\(\)/);
    expect(src).not.toMatch(/\blat\b|\blng\b|coords/);
  });

  it('готовность пакета переносится, но без данных о самом устройстве', () => {
    expect(snap().packReadiness).toBe('ready');
    expect(snap({ packStates: null }).packReadiness).toBe('unknown');
  });
});

describe('контактных данных получателя не собираем', () => {
  it('ни в схеме API, ни в таблице нет телефона/почты/имени', () => {
    const api = read('app/api/preparation/share/route.ts');
    const mig = read('migrations/870_trip_preparation_shares.sql');
    for (const src of [api, mig]) {
      expect(src).not.toMatch(/recipient_(phone|email|name)|contact_phone|contact_email/);
    }
    // Схема принимает routeId/answers/snapshot — и ничего про людей.
    expect(api).not.toMatch(/z\.string\(\)\.email\(\)/);
  });

  it('ссылка отдаётся пользователю, а не отправляется за него', () => {
    const api = read('app/api/preparation/share/route.ts');
    expect(api).toMatch(/path: `\/briefing\//);
    expect(api).not.toMatch(/sendTelegram|sendEmail|sendSms/i);
  });
});

describe('срок жизни ссылки обязателен', () => {
  it('колонка NOT NULL и область видимости заперта на briefing', () => {
    const mig = read('migrations/870_trip_preparation_shares.sql');
    expect(mig).toMatch(/expires_at\s+TIMESTAMPTZ NOT NULL/);
    expect(mig).toMatch(/CHECK \(scope IN \('briefing'\)\)/);
  });

  it('без времени возврата — срок по умолчанию, всегда в будущем', () => {
    const e = briefingExpiry(null, NOW);
    expect(e.getTime()).toBeGreaterThan(NOW);
    expect(e.getTime()).toBeLessThanOrEqual(NOW + BRIEFING_MAX_DAYS * 86_400_000);
  });

  it('со временем возврата ссылка живёт дольше него, но не бесконечно', () => {
    const returnBy = new Date(NOW + 3 * 86_400_000).toISOString();
    const e = briefingExpiry(returnBy, NOW);
    expect(e.getTime()).toBeGreaterThan(Date.parse(returnBy));
    expect(e.getTime()).toBeLessThanOrEqual(NOW + BRIEFING_MAX_DAYS * 86_400_000);
  });

  it('прошедшее время возврата не даёт срок в прошлом', () => {
    const e = briefingExpiry(new Date(NOW - 10 * 86_400_000).toISOString(), NOW);
    expect(e.getTime()).toBeGreaterThan(NOW);
  });
});

describe('просрочка и отзыв различимы', () => {
  it('чтение отвечает 410 с разными причинами', () => {
    const src = read('app/api/preparation/share/[token]/route.ts');
    expect(src).toMatch(/reason: 'revoked'/);
    expect(src).toMatch(/reason: 'expired'/);
    expect(src).toMatch(/status: 410/);
  });
});

describe('страница брифинга не обещает слежения', () => {
  const page = read('app/briefing/[token]/_BriefingClient.tsx');

  it('прямо говорит, что это снимок плана, а не слежение', () => {
    expect(page).toMatch(/снимок плана/);
    expect(page).toMatch(/положение участника здесь не/);
  });

  it('нет карты и нет обещания «группа наблюдает»', () => {
    expect(page).not.toMatch(/LeafletMap|showUserLocation/);
    expect(page).not.toMatch(/наблюда|отслежива|в реальном времени/i);
  });

  it('время возврата прошло — инструкция человеку, а не тревога платформы', () => {
    expect(overdueGuidance(new Date(NOW - 1000).toISOString(), NOW)).toMatch(/112/);
    expect(overdueGuidance(new Date(NOW + 86_400_000).toISOString(), NOW)).toBeNull();
    expect(overdueGuidance(null, NOW)).toBeNull();
  });

  it('возраст снимка и срок ссылки видны', () => {
    expect(page).toMatch(/takenAt/);
    expect(page).toMatch(/Ссылка действует до/);
  });
});

describe('контур подключён', () => {
  it('эндпоинты публичны по реестру', () => {
    expect(read('lib/auth/public-api-routes.ts')).toMatch(/'\/api\/preparation\/share': \['GET', 'POST'\]/);
  });

  it('экран подготовки создаёт ссылку и спрашивает время возврата', () => {
    const screen = read('app/routes/[id]/prepare/_PrepareClient.tsx');
    expect(screen).toMatch(/shareBriefing/);
    expect(screen).toMatch(/Когда ждать обратно/);
    expect(screen).toMatch(/buildBriefingSnapshot/);
  });

  it('в кокпите «Группа» вместо AI-чата', () => {
    const client = read('app/planning/_PlanningClient.tsx');
    expect(client).toContain('ГРУППА');
    const code = client.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toContain('КУЗЬМИЧ');
  });

  it('лист группы не обещает слежения', () => {
    const client = read('app/planning/_PlanningClient.tsx');
    expect(client).toMatch(/слежения не обещает/);
  });
});
