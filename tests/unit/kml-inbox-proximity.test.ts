/**
 * Привязка трека по близости: чужой путь не должен лечь на карточку.
 *
 * Лог импорта 26.07, партия из пятнадцати треков:
 *
 *   vulkan-ichinskaya-sopka.kml → matched_route «Эссовские (Уксичанские)
 *                                 термальные источники», match_by «proximity»
 *
 * Это разные объекты. Спасло только то, что у источников трек уже был и
 * сработало правило «реальное не перетираем»; будь геометрия пустой — на
 * карточку источников лёг бы путь на вулкан, и человек пошёл бы по нему.
 *
 * Причина камчатская: маршруты стартуют из общих посёлков. Эссо — перевалка
 * и к Уксичанским источникам, и к Ичинской сопке. Прежнее правило брало ОДИН
 * конец трека и мерило до центра маршрута: старт в километре от Эссо объявлял
 * маршрутом Эссо всё, что оттуда выходит, куда бы оно ни вело.
 *
 * Ошибка в эту сторону дороже пропуска: непривязанный трек уходит на ревью и
 * ждёт человека, а привязанный к чужому маршруту ведёт человека не туда.
 */
import { describe, it, expect } from 'vitest';
import {
  trackSpanKm, distanceToTrackKm,
  MAX_MATCH_DIST_KM, AMBIGUOUS_MARGIN_KM, PROXIMITY_MAX_TRACK_KM,
} from '@/lib/import/kml-inbox';

/** Координаты KML: [lng, lat]. */
const ESSO: [number, number] = [158.6900, 55.9300];

/** Длинный трек: от Эссо к Ичинской сопке, десятки километров на запад. */
const LONG_TRACK: number[][] = Array.from({ length: 60 }, (_, i) => [
  158.6900 - i * 0.016,
  55.9300 - i * 0.004,
]);

/** Короткий трек: Синичкино, четыре километра. */
const SHORT_TRACK: number[][] = Array.from({ length: 86 }, (_, i) => [
  158.6382 + i * 0.0006,
  53.0787 + i * 0.00004,
]);

describe('расстояние меряется до всего трека, а не до его конца', () => {
  it('маршрут посередине пути виден как близкий', () => {
    // Мерка «только до концов» не увидела бы очевидного совпадения.
    const middle = LONG_TRACK[30];
    expect(distanceToTrackKm(middle[1], middle[0], LONG_TRACK)).toBeLessThan(0.1);
  });

  it('далёкий маршрут остаётся далёким', () => {
    expect(distanceToTrackKm(51.45, 157.12, SHORT_TRACK)).toBeGreaterThan(100);
  });

  it('пустой трек не даёт нулевого расстояния', () => {
    // Ноль здесь читался бы как «совпало идеально» — то же «0 вместо неизвестно».
    expect(distanceToTrackKm(53, 158, [])).toBe(Infinity);
  });
});

describe('габарит трека решает, значит ли что-нибудь близость', () => {
  it('трек к Ичинской сопке — длинный', () => {
    expect(trackSpanKm(LONG_TRACK)).toBeGreaterThan(PROXIMITY_MAX_TRACK_KM);
  });

  it('трек Синичкино — короткий, близость по нему свидетельствует', () => {
    expect(trackSpanKm(SHORT_TRACK)).toBeLessThan(PROXIMITY_MAX_TRACK_KM);
  });

  it('порог оставляет дневные маршруты рабочими', () => {
    // Слишком низкий порог отправил бы на ревью всё подряд и завалил человека.
    expect(PROXIMITY_MAX_TRACK_KM).toBeGreaterThanOrEqual(5);
  });
});

describe('тот самый случай: Эссо у старта длинного трека', () => {
  it('якорь Эссо действительно рядом со стартом — вот на чём ловилось прежнее правило', () => {
    expect(distanceToTrackKm(ESSO[1], ESSO[0], LONG_TRACK)).toBeLessThan(MAX_MATCH_DIST_KM);
  });

  it('но трек длинный, и по близости привязка теперь запрещена', () => {
    // Условие целиком: близко — да; можно привязывать — нет.
    const nearEnough = distanceToTrackKm(ESSO[1], ESSO[0], LONG_TRACK) <= MAX_MATCH_DIST_KM;
    const allowed = trackSpanKm(LONG_TRACK) <= PROXIMITY_MAX_TRACK_KM;
    expect(nearEnough).toBe(true);
    expect(allowed).toBe(false);
  });
});

describe('однозначность: два почти одинаковых кандидата — не выбор', () => {
  it('запас требуется заметный, а не любой', () => {
    expect(AMBIGUOUS_MARGIN_KM).toBeGreaterThan(0);
  });

  it('два маршрута у одного порога различаются меньше запаса', () => {
    // Классический камчатский случай: две тропы от одной стоянки.
    const a = distanceToTrackKm(53.0787, 158.6382, SHORT_TRACK);
    const b = distanceToTrackKm(53.0790, 158.6390, SHORT_TRACK);
    expect(Math.abs(a - b)).toBeLessThan(AMBIGUOUS_MARGIN_KM);
  });
});

describe('правило подключено к импорту, а не лежит библиотекой', () => {
  it('импорт спрашивает габарит трека прежде, чем привязывать по близости', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/import/kml-inbox.ts'), 'utf-8',
    ) as string;
    expect(src).toMatch(/trackSpanKm\([\s\S]{0,80}PROXIMITY_MAX_TRACK_KM/);
    expect(src).toMatch(/AMBIGUOUS_MARGIN_KM/);
    // Мерки «до одного конца» остаться не должно: она и была дефектом.
    expect(src).not.toMatch(/haversineKm\(last\[1\], last\[0\]/);
  });
});
