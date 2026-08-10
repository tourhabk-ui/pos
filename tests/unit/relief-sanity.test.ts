/**
 * Трек и название говорят про одно место.
 *
 * Человек планирует выход по названию, а идёт по треку. Если они про разные
 * места, он узнает об этом там, где выяснять поздно. До появления высот такой
 * трек выглядел как любой другой; теперь данные противоречат сами себе, и
 * противоречие ловится арифметикой.
 *
 * Тесты стерегут и обратное — что проверка не кричит на здоровых маршрутах.
 * Сторож, поднимающий тревогу на половине базы, перестают читать через день.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkRoute, checkRoutes, distanceKm, summarize,
  MAX_TRACK_OFFSET_KM, MIN_SUMMIT_M, type RouteReliefRow,
} from '@/lib/routes/relief-sanity';

function row(over: Partial<RouteReliefRow> = {}): RouteReliefRow {
  return {
    id: 'r1',
    title: 'Вулкан Авачинский',
    lat: 53.256, lng: 158.83,
    trackLat: 53.26, trackLng: 158.84,
    maxElevationM: 2724,
    minElevationM: 525,
    ...over,
  };
}

describe('здоровый маршрут молчит', () => {
  it('трек рядом с точкой, высота на месте — тревоги нет', () => {
    expect(checkRoute(row())).toEqual([]);
  });

  it('маршрут без «высотного» слова не обязан подниматься', () => {
    // Бухта, пляж, озеро — им низкие отметки к лицу.
    expect(checkRoute(row({ title: 'Бухта Русская', maxElevationM: 6 }))).toEqual([]);
  });

  it('нет данных — нет и обвинений', () => {
    expect(checkRoute(row({ trackLat: null, trackLng: null, maxElevationM: null }))).toEqual([]);
    expect(checkRoute(row({ lat: null, lng: null, maxElevationM: null }))).toEqual([]);
  });
});

describe('чужой трек виден по расстоянию', () => {
  it('трек за сотню километров от точки маршрута — находка', () => {
    const f = checkRoute(row({ trackLat: 54.5, trackLng: 160.5 }));
    expect(f.map(x => x.kind)).toContain('track_far');
    expect(f[0].detail).toMatch(/\d+ км/);
  });

  it('порог не срабатывает на длинном, но своём маршруте', () => {
    // Начало трека в паре десятков километров от объявленной точки — обычное
    // дело: точка ставится на объект, а выходят с дороги.
    const near = distanceKm(53.256, 158.83, 53.4, 159.0);
    expect(near).toBeLessThan(MAX_TRACK_OFFSET_KM);
    expect(checkRoute(row({ trackLat: 53.4, trackLng: 159.0 }))).toEqual([]);
  });
});

describe('название обещает высоту, которой в треке нет', () => {
  it('«Вулкан Кроноцкий» на уровне моря — находка', () => {
    // Тот самый случай 09.08: сопка 3528 м, а трек −1..45 м. Модель не
    // ошиблась — трек ведёт не туда.
    const f = checkRoute(row({
      id: 'kronotsky', title: 'Вулкан Кроноцкий',
      lat: 54.75, lng: 160.53, trackLat: 54.75, trackLng: 160.53,
      maxElevationM: 45, minElevationM: -1,
    }));
    expect(f.map(x => x.kind)).toEqual(['summit_too_low']);
    expect(f[0].detail).toContain('45 м');
  });

  it('гора, сопка, перевал и пик проверяются наравне с вулканом', () => {
    for (const title of ['Гора Седло', 'Сопка Мишенная', 'Вилючинский перевал', 'Пик Ивана']) {
      expect(checkRoute(row({ title, maxElevationM: 100 })).length).toBe(1);
    }
  });

  it('невысокая, но настоящая сопка тревоги не поднимает', () => {
    expect(checkRoute(row({ title: 'Сопка Петровская', maxElevationM: MIN_SUMMIT_M + 1 })).length).toBe(0);
  });
});

describe('итог читается человеком', () => {
  it('расхождений нет — так и сказано', () => {
    expect(summarize([], 338)).toMatch(/расхождений нет/);
  });

  it('в итоге видно, чего и сколько', () => {
    const findings = checkRoutes([
      row({ id: 'a', trackLat: 56, trackLng: 162 }),
      row({ id: 'b', title: 'Вулкан Кроноцкий', maxElevationM: 45 }),
    ]);
    const s = summarize(findings, 338);
    expect(s).toContain('338');
    expect(s).toMatch(/чужим треком/);
    expect(s).toMatch(/без обещанной высоты/);
  });
});

describe('проверка доступна с прода', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/api/cron/relief-coverage/route.ts'), 'utf-8');

  it('живёт рядом с замером покрытия, а не отдельным эндпоинтом', () => {
    expect(SRC).toMatch(/mode'\) === 'sanity'/);
    expect(SRC).toMatch(/checkRoutes\(parsed\)/);
  });

  it('высоты берутся из третьего числа координат, с проверкой типа', () => {
    // jsonb_array_length падает на элементе, который массивом не является:
    // один битый трек уронил бы проверку для всех остальных.
    expect(SRC).toMatch(/jsonb_typeof\(c\) = 'array'/);
  });

  it('чинить автоматически не пытаемся', () => {
    // Имена мест на Камчатке путаные; подгонка геометрии под название сделает
    // ложь достовернее, а не правду вернее.
    expect(SRC).not.toMatch(/UPDATE kamchatka_routes[\s\S]{0,200}sanity/);
  });
});
