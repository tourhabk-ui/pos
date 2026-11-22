/**
 * Карта — главный экран плана (22.11): дни по своим точкам, линия по дням,
 * переезды между зонами с временем и транспортом из zone-graph, полоса дней
 * поверх карты. Судится вызовом и кликом.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { placeForLocation, placeDaysOnMap, toursToPlace, PKC_DEFAULT, type CatalogPlace } from '@/lib/planner/map-tour-points';
import {
  buildPlannerMarkers, dayPath, zoneLegNote, zoneLegs, planFocusPoints, ROUTE_LINE_ID, APPROX_NOTE,
  type PlannerMapDay,
} from '@/lib/planner/map-markers';
import { PlannerDayStrip } from '@/components/planner/PlannerDayStrip';

const PLACES: CatalogPlace[] = [
  { title: 'Верхне-Паратунские термальные источники', lat: 52.82, lng: 158.16 },
  { title: 'Вилючинский перевал', lat: 52.74, lng: 158.2 },
  { title: 'Вулкан Вилючинский', lat: 52.705, lng: 158.282 },
  { title: 'Лавовые пещеры вулкана Горелый', lat: 52.596, lng: 158.124 },
  { title: 'Вулкан Горелый', lat: 52.559, lng: 158.037 },
  { title: 'Мыс Маячный', lat: 52.888, lng: 158.709 },
  { title: 'Паратунская зона отдыха', lat: 52.962, lng: 158.254 },
];

const PKC: [number, number] = [PKC_DEFAULT[0], PKC_DEFAULT[1]];

describe('место тура по описанию', () => {
  it('сверяет по значимым словам, вид места словом не считается', () => {
    expect(placeForLocation('Паратунка, спа-отель «Лагуна»', PLACES)?.title).toBe('Паратунская зона отдыха');
    expect(placeForLocation('Мыс Маячный', PLACES)?.title).toBe('Мыс Маячный');
    expect(placeForLocation('Вулканы Вилючинский, Мутновский и Горелый, Ходуткинские источники', PLACES)?.title)
      .toBe('Вулкан Вилючинский');
  });
  it('не подошло ничего — null, а не ближайшее похожее', () => {
    expect(placeForLocation('Рыболовная база «Камчатская Рыбалка»', PLACES)).toBeNull();
    expect(placeForLocation('', PLACES)).toBeNull();
  });
  it('переносит только день с туром в точке по умолчанию и помечает его', () => {
    const days = [
      { day: 1, title: 'Прилёт', zone: 'avachinsky', coords: PKC },
      { day: 2, title: 'Рыбалка', zone: 'avachinsky', coords: [55.43, 159.42] as [number, number], realTour: { tourId: '36' } },
      { day: 3, title: 'Паратунка', zone: 'avachinsky', coords: PKC, realTour: { tourId: '112' } },
      { day: 4, title: 'Неизвестно где', zone: 'avachinsky', coords: PKC, realTour: { tourId: '7' } },
    ];
    expect(toursToPlace(days)).toEqual(['112', '7']);
    const out = placeDaysOnMap(days, { '112': 'Паратунка, спа-отель «Лагуна»', '7': 'Рыболовная база' }, PLACES);
    expect(out[0].coords).toEqual(PKC);
    expect(out[1].coords).toEqual([55.43, 159.42]);
    expect(out[2].coords).toEqual([52.962, 158.254]);
    expect(out[2].approx).toBe(true);
    expect(out[3].coords).toEqual(PKC);
    expect(out[3].approx).toBeUndefined();
  });
});

const D = (day: number, zone: string, coords: [number, number], extra: Partial<PlannerMapDay> = {}): PlannerMapDay =>
  ({ day, title: `День ${day}`, zone, coords, ...extra });

describe('линия и переезды', () => {
  const days = [
    D(1, 'avachinsky', PKC),
    D(2, 'avachinsky', [52.962, 158.254], { approx: true }),
    D(3, 'western', [53.3, 156.0]),
    D(4, 'western', [53.3, 156.0]),
    D(5, 'avachinsky', PKC),
  ];
  it('линия идёт по дням в порядке плана, день в той же точке — одна вершина', () => {
    expect(dayPath(days)).toEqual([PKC, [52.962, 158.254], [53.3, 156.0], PKC]);
    const line = buildPlannerMarkers({ routes: [], days, editingDayId: null }).find(m => m.id === ROUTE_LINE_ID);
    expect(line?.geometry?.coordinates).toEqual([PKC, [52.962, 158.254], [53.3, 156.0], PKC]);
    expect(line?.geometry?.dashArray).toBeTruthy();
  });
  it('на смене зоны — плашка с временем и транспортом из zone-graph', () => {
    expect(zoneLegNote('avachinsky', 'western')).toBe('≈ 7 ч · джип');
    expect(zoneLegNote('eastern', 'avachinsky')).toBe('≈ 5 ч · джип или вертолёт');
    expect(zoneLegNote('avachinsky', 'northern')).toMatch(/^только вертолёт · \d+ км$/);
    expect(zoneLegNote('avachinsky', 'avachinsky')).toBeNull();
    const legs = zoneLegs(days);
    expect(legs.map(l => [l.fromDay, l.toDay])).toEqual([[2, 3], [4, 5]]);
    const notes = buildPlannerMarkers({ routes: [], days, editingDayId: null }).filter(m => m.note);
    expect(notes).toHaveLength(1); // туда и обратно рядом — одна плашка
    expect(notes[0].note).toBe('≈ 7 ч · джип');
  });
  it('пин дня-ориентира говорит, что место — по описанию тура', () => {
    const pin = buildPlannerMarkers({ routes: [], days, editingDayId: null }).find(m => m.id === 'day_2');
    expect(pin?.description).toContain(APPROX_NOTE);
  });
  it('карта смотрит на открытый день, иначе на весь план', () => {
    expect(planFocusPoints(days, 3)).toEqual([[53.3, 156.0]]);
    expect(planFocusPoints(days, null)).toHaveLength(4);
  });
});

describe('полоса дней поверх карты', () => {
  const days = [
    { ...D(1, 'avachinsky', PKC), title: 'Прилёт', dateLabel: 'вт, 24 ноя' },
    { ...D(2, 'western', [53.3, 156.0]), title: 'Западное побережье', dateLabel: 'ср, 25 ноя' },
  ];
  it('день — кнопкой с номером и датой, переезд — плашкой, нажатие открывает день', () => {
    const onPick = vi.fn();
    const onOpen = vi.fn();
    const { rerender } = render(<PlannerDayStrip days={days} activeDay={null} onPick={onPick} onOpen={onOpen} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('≈ 7 ч · джип')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Западное побережье/ }));
    expect(onPick).toHaveBeenCalledWith(2);
    rerender(<PlannerDayStrip days={days} activeDay={2} onPick={onPick} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть в плане' }));
    expect(onOpen).toHaveBeenCalledWith(2);
  });
});

describe('туда и обратно', () => {
  it('один отрезок туда и обратно — одна плашка на карте, в полосе обе', () => {
    const PKC2: [number, number] = [53.01, 158.65];
    const days = [D(1, 'avachinsky', PKC2), D(2, 'western', [53.3, 156.0]), D(3, 'avachinsky', PKC2)];
    expect(zoneLegs(days)).toHaveLength(2);
    expect(buildPlannerMarkers({ routes: [], days, editingDayId: null }).filter(m => m.note)).toHaveLength(1);
  });
});
