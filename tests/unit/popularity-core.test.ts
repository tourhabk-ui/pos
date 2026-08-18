/**
 * Список ядра: спрос рядом с состоянием.
 *
 * Владелец после ночи разбора: «я уже не знаю, как навести порядок». Порядок в
 * четырёхстах записях разом не наводится — наводится ядро: два-три десятка
 * маршрутов, за которые платформа отвечает. Очередь задаёт спрос, иначе время
 * уйдёт на маршрут, который никто не открывает.
 *
 * Сторож держит три свойства списка:
 *   1. сигналы спроса НЕ складываются в один балл;
 *   2. «чего не хватает» названо задачей, а не приговором;
 *   3. облёт в работу не попадает — он не чинится разметкой.
 */
import { describe, it, expect } from 'vitest';
import { byDemand, whatIsMissing, idFromPath } from '@/lib/routes/popularity';

describe('очередь ядра', () => {
  const row = (visitors: number, bookings: number, views: number) =>
    ({ id: 'x', title: 't', visitors, bookings, views, tours: 0 });

  it('ведут РАЗНЫЕ посетители, а не открытия', () => {
    // Одна вкладка, обновлённая двадцать раз, маршрут популярным не делает.
    const a = row(3, 0, 100);
    const b = row(10, 0, 12);
    expect([a, b].sort(byDemand)[0].visitors).toBe(10);
  });

  it('при равных посетителях решают брони', () => {
    const a = row(5, 0, 90);
    const b = row(5, 2, 10);
    expect([a, b].sort(byDemand)[0].bookings).toBe(2);
  });

  it('сигналы не складываются в один балл', () => {
    // Курса обмена между просмотром и бронью не существует; выдуманный балл
    // нельзя ни проверить, ни объяснить. Поэтому сортировка лексикографична:
    // много просмотров НЕ перевешивают посетителей.
    const many = row(1, 0, 10_000);
    const few = row(2, 0, 2);
    expect([many, few].sort(byDemand)[0].visitors).toBe(2);
  });
});

describe('чего не хватает записи', () => {
  it('пригодный маршрут в работу не попадает', () => {
    expect(whatIsMissing({ verdict: 'navigable', waypoints: 5, hasLine: true })).toBeNull();
  });

  it('облёт не чинится разметкой и в работу не попадает', () => {
    expect(whatIsMissing({ verdict: 'not_on_foot', waypoints: 0, hasLine: true })).toBeNull();
  });

  it('задача названа делом, а не приговором', () => {
    expect(whatIsMissing({ verdict: 'orientation_only', waypoints: 0, hasLine: true }))
      .toContain('разметить точки');
    expect(whatIsMissing({ verdict: 'orientation_only', waypoints: 1, hasLine: true }))
      .toContain('разметить точки');
    expect(whatIsMissing({ verdict: 'not_a_route', waypoints: 0, hasLine: false }))
      .toContain('нет ни линии, ни точек');
  });
});

describe('путь страницы → запись', () => {
  it('идентификатор берётся вторым сегментом', () => {
    expect(idFromPath('/routes/abc-123', 'routes')).toBe('abc-123');
    expect(idFromPath('/places/def-456', 'places')).toBe('def-456');
  });

  it('подстраница считается тому же маршруту', () => {
    // Человек, дошедший до подготовки, интересовался маршрутом сильнее.
    expect(idFromPath('/routes/abc-123/prepare', 'routes')).toBe('abc-123');
  });

  it('чужой путь не считается', () => {
    expect(idFromPath('/marketplace/tours/9', 'routes')).toBeNull();
    expect(idFromPath('/routes', 'routes')).toBeNull();
  });
});
