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
  id: title, slug: null, title, basePrice: 10000, durationDays: 1,
  operatorName: 'Оператор', operatorSlug: null, operatorPublic: true, linkKind,
});

describe('блок туров на карточке места', () => {
  it('по пути — «к этому месту»; по неразмеченной связи — отдельно и словами', () => {
    render(<PlaceTours tours={[tour('Тур по пути', 'waypoint'), tour('Тур по связи', 'unknown')]} />);
    const through = screen.getByText('Туры к этому месту').closest('section')!;
    expect(through.textContent).toContain('Тур по пути');
    expect(through.textContent).not.toContain('Тур по связи');
    const unmarked = screen.getByText('Ещё туры по маршрутам, связанным с местом').closest('section')!;
    expect(unmarked.textContent).toContain('Тур по связи');
    expect(unmarked.textContent).toContain('Проходит ли маршрут тура через само место, у нас не размечено');
  });

  it('главное место тура — «к этому месту», рядом с туром по пути', () => {
    render(<PlaceTours tours={[tour('Тур с главным местом', 'main_place'), tour('Тур по пути', 'waypoint'), tour('Тур по связи', 'unknown')]} />);
    const through = screen.getByText('Туры к этому месту').closest('section')!;
    expect(through.textContent).toContain('Тур с главным местом');
    expect(through.textContent).toContain('Тур по пути');
    expect(through.textContent).not.toContain('Тур по связи');
    const unmarked = screen.getByText('Ещё туры по маршрутам, связанным с местом').closest('section')!;
    expect(unmarked.textContent).not.toContain('Тур с главным местом');
  });

  it('только неразмеченные — заголовка «к этому месту» нет вовсе', () => {
    render(<PlaceTours tours={[tour('Тур по связи', 'unknown')]} />);
    expect(screen.queryByText('Туры к этому месту')).toBeNull();
    expect(screen.getByText('Туры по маршрутам, связанным с местом')).toBeTruthy();
  });
});

describe('загрузчик карточки', () => {
  const main = {
    place_pk: 'test-place-0001', ark_id: '22222222-2222-2222-2222-222222222222', name: 'Озеро Тестовое',
    lat: 53, lng: 158, location_type: 'lake', photo_count: 0,
  };
  const toursRows = [
    { id: 't1', slug: null, title: 'Тур по пути', base_price: '10000', duration_days: 1, operator_name: 'О', operator_slug: null, operator_public: true, link_kind: 'waypoint' },
    { id: 't2', slug: null, title: 'Тур по связи', base_price: '12000', duration_days: null, operator_name: 'О', operator_slug: null, operator_public: true, link_kind: 'unknown' },
    { id: 't3', slug: null, title: 'Тур с главным местом', base_price: '9000', duration_days: 1, operator_name: 'О', operator_slug: null, operator_public: true, link_kind: 'main_place' },
  ];
  const load = async () => {
    const sent: string[] = [];
    vi.resetModules();
    vi.doMock('@/lib/database', () => ({
      query: async (sql: string) => {
        if (/FROM places p\s+LEFT JOIN place_description_drafts/.test(sql)) return { rows: [main] };
        if (/FROM route_waypoints rw[\s\S]*JOIN operator_tours ot/.test(sql)) { sent.push(sql); return { rows: toursRows }; }
        return { rows: [] };
      },
    }));
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: async () => ({ rows: [] }) } }));
    const { loadPlaceDetail } = await import('@/lib/places/place-detail');
    const r = await loadPlaceDetail('test-place-0001', { countView: false });
    return { tours: (r.body.data as { tours: PlaceTour[] }).tours, sent };
  };

  it('род связи доходит до экрана', async () => {
    const { tours } = await load();
    expect(tours.map((t) => [t.title, t.linkKind])).toEqual([
      ['Тур по пути', 'waypoint'], ['Тур по связи', 'unknown'], ['Тур с главным местом', 'main_place'],
    ]);
  });

  it('отбор туров идёт через шлюз витрины — удалённый тур не выбирается', async () => {
    const { publicTourSql } = await import('@/lib/tours/public-visibility');
    const { sent } = await load();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(publicTourSql('ot'));
  });
});
