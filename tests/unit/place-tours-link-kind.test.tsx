/**
 * «Туры к этому месту» — только по маршрутам, размеченным через место (15.10,
 * §0 «честность»).
 *
 * Блок брал туры по любой связи маршрута с местом, кроме «рядом», и все они
 * шли под заголовком «Туры к этому месту». Но связь рода unknown («не
 * установлено», §4.1) не говорит, что маршрут через место проходит: человек
 * покупал бы поездку, которая сюда, может быть, не заезжает. Маршруты на той
 * же карточке это правило уже держат (place-card-small-truths, п. 3).
 *
 * Заодно — шлюз витрины: ручная копия флагов не смотрела deleted_at, и
 * удалённый тур оставался в списке (public-tour-gate, P1-04).
 *
 * Рендер — блок; связка — вызов загрузчика с подставной базой. Сам отбор
 * проверен на PostgreSQL: тур по размеченному пути — «waypoint», по
 * неразмеченному — «unknown», по «рядом» и удалённый — не выбраны.
 *
 * Вторая связь (аудит 15.10, TOUR-PLACE, миграция 1286): место названо
 * главным местом тура (main_place_id). Такой тур — тоже «к этому месту»: у
 * туров, заведённых миграциями, маршрута нет, и без этой связи блок на проде
 * был пуст везде. Отбор на PostgreSQL — public-tour-gate.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PlaceTours from '@/components/places/PlaceTours';
import type { PlaceTour } from '@/components/places/types';

afterEach(cleanup);

const tour = (title: string, linkKind: PlaceTour['linkKind']): PlaceTour => ({
  id: title, slug: null, title, basePrice: 10000, priceUnit: 'per_person',
  durationType: 'day', multiDayCount: null, durationHours: 8, seasonStart: null, seasonEnd: null,
  nearestFreeDate: null, keepsSchedule: false, partnerId: 'p-1', partnerVerified: null,
  operatorName: 'Оператор', operatorSlug: null, operatorPublic: true, linkKind,
});
const DAY = '2026-10-29';
const Block = ({ tours }: { tours: PlaceTour[] }) => <PlaceTours tours={tours} state="ok" day={DAY} placeName="Озеро Тестовое" />;

describe('блок туров на карточке места', () => {
  it('по пути — «к этому месту»; по неразмеченной связи — отдельно и словами', () => {
    render(<Block tours={[tour('Тур по пути', 'waypoint'), tour('Тур по связи', 'unknown')]} />);
    const through = screen.getByText('Туры к этому месту').closest('section')!;
    expect(through.textContent).toContain('Тур по пути');
    expect(through.textContent).not.toContain('Тур по связи');
    const unmarked = screen.getByText('Ещё туры по маршрутам, связанным с местом').closest('section')!;
    expect(unmarked.textContent).toContain('Тур по связи');
    expect(unmarked.textContent).toContain('Проходит ли маршрут тура через само место, у нас не размечено');
  });

  it('главное место тура — «к этому месту», рядом с туром по пути', () => {
    render(<Block tours={[tour('Тур с главным местом', 'main_place'), tour('Тур по пути', 'waypoint'), tour('Тур по связи', 'unknown')]} />);
    const through = screen.getByText('Туры к этому месту').closest('section')!;
    expect(through.textContent).toContain('Тур с главным местом');
    expect(through.textContent).toContain('Тур по пути');
    expect(through.textContent).not.toContain('Тур по связи');
    const unmarked = screen.getByText('Ещё туры по маршрутам, связанным с местом').closest('section')!;
    expect(unmarked.textContent).not.toContain('Тур с главным местом');
  });

  it('только неразмеченные — заголовка «к этому месту» нет вовсе', () => {
    render(<Block tours={[tour('Тур по связи', 'unknown')]} />);
    expect(screen.queryByText('Туры к этому месту')).toBeNull();
    expect(screen.getByText('Туры по маршрутам, связанным с местом')).toBeTruthy();
  });
});

describe('загрузчик карточки', () => {
  const main = {
    place_pk: 'test-place-0001', ark_id: '22222222-2222-2222-2222-222222222222', name: 'Озеро Тестовое',
    lat: 53, lng: 158, location_type: 'lake', photo_count: 0,
  };
  const row = (id: string, title: string, link_kind: string) => ({
    id, slug: null, title, base_price: '10000', price_unit: 'per_person', duration_type: 'day', multi_day_count: null,
    duration_hours: '8', season_start: null, season_end: null, partner_id: 'p-1', partner_name: 'О', partner_slug: null,
    partner_public: true, partner_verified: null, nearest_free_date: null, keeps_schedule: false, link_kind,
  });
  // Строки — в порядке номеров тура; на экран они идут по правилу 1в, а не так.
  const toursRows = [row('1', 'Тур по пути', 'waypoint'), row('2', 'Тур по связи', 'unknown'), row('3', 'Тур с главным местом', 'main_place')];
  const load = async (toursAnswer: () => Promise<{ rows: unknown[] }>) => {
    const sent: string[] = [];
    vi.resetModules();
    vi.doMock('@/lib/database', () => ({
      query: async (sql: string) => {
        if (/FROM places p\s+LEFT JOIN place_description_drafts/.test(sql)) return { rows: [main] };
        return { rows: [] };
      },
    }));
    vi.doMock('@/lib/db-pool', () => ({
      pool: {
        query: async (sql: string) => {
          if (/FROM route_waypoints rw[\s\S]*JOIN operator_tours ot/.test(sql)) { sent.push(sql); return toursAnswer(); }
          return { rows: [] };
        },
      },
    }));
    const { loadPlaceDetail } = await import('@/lib/places/place-detail');
    const r = await loadPlaceDetail('test-place-0001', { countView: false });
    const data = r.body.data as { tours: PlaceTour[]; toursState: string; toursDay: string };
    return { r, data, sent };
  };

  it('род связи доходит до экрана', async () => {
    const { data } = await load(async () => ({ rows: toursRows }));
    expect(data.toursState).toBe('ok');
    expect(data.tours.map((t) => [t.title, t.linkKind]).sort()).toEqual([
      ['Тур по пути', 'waypoint'], ['Тур по связи', 'unknown'], ['Тур с главным местом', 'main_place'],
    ].sort());
  });

  it('отбор туров идёт через шлюз витрины — удалённый тур не выбирается; LIMIT нет', async () => {
    const { publicTourSql } = await import('@/lib/tours/public-visibility');
    const { sent } = await load(async () => ({ rows: toursRows }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(publicTourSql('ot'));
    // LIMIT есть только внутри фрагмента ближайшей даты (одна дата на тур);
    // у самого списка туров места его нет — шестой тур не теряется.
    const { nearestFreeDateSql } = await import('@/lib/tours/nearest-free-date');
    expect(sent[0]).toContain(nearestFreeDateSql('ot'));
    expect(sent[0].replace(nearestFreeDateSql('ot'), '')).not.toMatch(/\bLIMIT\b/);
  });

  it('туры не прочитались — карточка места жива, туры «не загрузились», SQLSTATE в логе', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { r, data } = await load(async () => { throw Object.assign(new Error('relation missing'), { code: '42P01' }); });
      expect(r.status).toBe(200);
      expect(data.toursState).toBe('failed');
      expect(data.tours).toEqual([]);
      expect(data.toursDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const logged = errSpy.mock.calls.find((c) => String(c[0]).includes('[place-tours]'));
      expect(logged?.[1]).toMatchObject({ sqlstate: '42P01' });
    } finally {
      errSpy.mockRestore();
    }
  });

  it('туров нет — «пусто», а не «не загрузились»', async () => {
    const { data } = await load(async () => ({ rows: [] }));
    expect(data.toursState).toBe('empty');
    expect(data.tours).toEqual([]);
  });
});
