import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { stripSourceAttribution, hasSourceAttribution, publicSourceUrl, EXTERNAL_SOURCE_NAME } from '@/lib/text/source-attribution';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Обработчики ниже читают базу двумя путями — подменяем оба (ревью #3652:
// судить вызовом обработчика, а не строкой в исходнике).
const db = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: db.rows })) } }));
vi.mock('@/lib/database', () => ({ query: vi.fn(async (sql: string) => ({ rows: /FROM operator_tours t/.test(sql) ? db.rows : [] })) }));

import { GET as nearbyGET } from '@/app/api/routes/nearby/route';
import { GET as tourGET } from '@/app/api/tours/[id]/route';

describe('source-attribution: hasSourceAttribution', () => {
  it('ловит все формы имени источника', () => {
    expect(hasSourceAttribution('подробности на ИдиЛесом')).toBe(true);
    expect(hasSourceAttribution('Иди Лесом')).toBe(true);
    expect(hasSourceAttribution('см. идилесом')).toBe(true);
    expect(hasSourceAttribution('ИДИЛЕСОМ')).toBe(true);
  });

  it('не ложно-срабатывает на чистый текст', () => {
    expect(hasSourceAttribution('Вулкан Авачинский, высота 2741 м')).toBe(false);
    expect(hasSourceAttribution('')).toBe(false);
    expect(hasSourceAttribution(null)).toBe(false);
    expect(hasSourceAttribution(undefined)).toBe(false);
  });
});

describe('source-attribution: stripSourceAttribution', () => {
  it('кейс владельца — Бухта Асача: убирает рекламный хвост, сохраняет факт', () => {
    const raw = 'Это Бухта Асача в Камчатском крае. Место, которое стоит посмотреть. Маршрут и все подробности на ИдиЛесом';
    const out = stripSourceAttribution(raw);
    expect(out).not.toMatch(/иди\s*лесом/i);
    expect(out).toContain('Бухта Асача');
    expect(out).toContain('стоит посмотреть');
    // Нет висящих пробелов/двойных точек
    expect(out).not.toMatch(/\s{2,}/);
    expect(out).not.toMatch(/\.\s*\./);
    expect(out.endsWith('.')).toBe(true);
  });

  it('вариант с точкой в конце', () => {
    const out = stripSourceAttribution('Красивое озеро. Маршрут и все подробности на ИдиЛесом.');
    expect(out).toBe('Красивое озеро.');
  });

  it('суффикс заголовка « — ИдиЛесом» снимается, имя сохраняется', () => {
    expect(stripSourceAttribution('Бухта Асача — ИдиЛесом')).toBe('Бухта Асача');
    expect(stripSourceAttribution('Гора Замок | ИдиЛесом')).toBe('Гора Замок');
    expect(stripSourceAttribution('Долина гейзеров · Иди Лесом')).toBe('Долина гейзеров');
  });

  it('голый хвост «на ИдиЛесом» убирается', () => {
    expect(stripSourceAttribution('Смотрите фото на ИдиЛесом')).toBe('Смотрите фото');
  });

  it('чистый текст не меняется (идемпотентность на «хорошем»)', () => {
    const clean = 'Авачинский вулкан — действующий вулкан высотой 2741 м рядом с Петропавловском.';
    expect(stripSourceAttribution(clean)).toBe(clean);
  });

  it('идемпотентна — повторный прогон ничего не меняет', () => {
    const raw = 'Это Бухта Асача. Маршрут и все подробности на ИдиЛесом';
    const once = stripSourceAttribution(raw);
    const twice = stripSourceAttribution(once);
    expect(twice).toBe(once);
    expect(hasSourceAttribution(once)).toBe(false);
  });

  it('пустые/nullable входы → пустая строка', () => {
    expect(stripSourceAttribution('')).toBe('');
    expect(stripSourceAttribution(null)).toBe('');
    expect(stripSourceAttribution(undefined)).toBe('');
  });
});

describe('publicSourceUrl — адрес конкурента не уходит в ответ страницы', () => {
  it('прячет idilesom.com и подпись «сторонний источник»', () => {
    expect(publicSourceUrl('https://idilesom.com/kam/places/2772', EXTERNAL_SOURCE_NAME)).toBeNull();
    expect(publicSourceUrl('https://www.idilesom.com/kam/places/1460', null)).toBeNull();
    expect(publicSourceUrl('https://idilesom.com/kam/places/2748', null)).toBeNull();
    expect(publicSourceUrl('https://example.com/page', EXTERNAL_SOURCE_NAME)).toBeNull();
  });

  it('оставляет прочие адреса и пустые значения', () => {
    expect(publicSourceUrl('https://vulcanikamchatki.ru/page', 'Вулканы Камчатки')).toBe(
      'https://vulcanikamchatki.ru/page',
    );
    expect(publicSourceUrl(null, null)).toBeNull();
    expect(publicSourceUrl('', null)).toBeNull();
  });

  it('код, читающий маршруты и места, не кладёт в sourceUrl сырой source_url (запрет)', () => {
    const roots = ['app', 'lib', 'components'];
    const skip = /(^|\/)(api\/admin|api\/cron|api\/hub|hub)(\/|$)/;
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (!skip.test(p)) walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const src = readFileSync(p, 'utf-8');
        // Только файлы, читающие маршруты и места: у проката, статей, сейсмики
        // и паспортов парка свой источник, к сайту конкурента не относящийся.
        if (!/(FROM|JOIN)\s+(agent_route_knowledge|kamchatka_routes|places)\b/.test(src)) continue;
        // sourceUrl: <что-то>.source_url / route_source_url — без фильтра.
        if (/sourceUrl:\s*\(?\s*\w+\.(route_)?source_url\b/.test(src)) bad.push(p);
      }
    };
    roots.forEach((r) => walk(join(process.cwd(), r)));
    expect(bad).toEqual([]);
  });
});

describe('публичные API — вызовом обработчика (ревью безопасности #3652)', () => {
  const ROW = { id: 'r1', title: 'Лежбище сивучей', lat: '53.1', lng: '158.6', description: '', category: 'route',
    activity_type: null, location_type: null, kind: 'route' };
  beforeEach(() => { db.rows = []; });

  it('/api/routes/nearby: подпись «сторонний источник» прячет и адрес не с хоста idilesom; прочий источник виден', async () => {
    db.rows = [
      { ...ROW, id: 'a', source_url: 'https://mirror.example/page', source_name: EXTERNAL_SOURCE_NAME },
      { ...ROW, id: 'b', source_url: 'https://idilesom.com/kam/places/2772', source_name: null },
      { ...ROW, id: 'c', source_url: 'https://vulcanikamchatki.ru/page', source_name: 'Вулканы Камчатки' },
    ];
    const res = await nearbyGET(new NextRequest('http://localhost/api/routes/nearby?lat=53&lng=158.6'));
    const body = await res.json() as { routes: Array<{ id: string; sourceUrl: string }> };
    const by = Object.fromEntries(body.routes.map((r) => [r.id, r.sourceUrl]));
    expect(by).toEqual({ a: '', b: '', c: 'https://vulcanikamchatki.ru/page' });
    expect(JSON.stringify(body)).not.toMatch(/idilesom|mirror\.example/);
  });

  it('/api/tours/[id]: адрес источника маршрута тура идёт через фильтр', async () => {
    const tourRow = (url: string, name: string | null) => ({
      id: 7, title: 'Тур', description: '', base_price: 1000, price_unit: 'per_person', photos: [],
      route_id: 'r1', route_kr_id: 'r1', route_title: 'Маршрут', route_category: 'route', route_lat: '53', route_lng: '158',
      route_source_url: url, route_source_name: name,
    });
    const call = async () => {
      const res = await tourGET(new NextRequest('http://localhost/api/tours/7'), { params: Promise.resolve({ id: '7' }) });
      return (await res.json()) as { data?: { route?: { sourceUrl: string | null } } };
    };
    db.rows = [tourRow('https://idilesom.com/kam/places/2748', null)];
    expect((await call()).data?.route?.sourceUrl).toBeNull();
    db.rows = [tourRow('https://mirror.example/page', EXTERNAL_SOURCE_NAME)];
    expect((await call()).data?.route?.sourceUrl).toBeNull();
    db.rows = [tourRow('https://vulcanikamchatki.ru/page', 'Вулканы Камчатки')];
    expect((await call()).data?.route?.sourceUrl).toBe('https://vulcanikamchatki.ru/page');
  });
});
