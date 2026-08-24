/**
 * Точка трека — место на Камчатке, а не «конечное число».
 *
 * Полевой скрин 17.08: на карте навигации через весь экран шла сплошная
 * зелёная линия — горизонталь от Магаданской области за восточный край
 * карты, тогда как человек и путевые точки стояли под Петропавловском.
 * Сплошная зелёная означает «здесь идут», и по ней идут.
 *
 * Причина: проверялась только конечность числа. Точка с нулевой долготой
 * или с переставленными местами lat/lng проходила как валидная — а широта
 * больше 90 не широта вовсе, и точка в тысяче километров от края не точка
 * этого трека, чем бы она ни была в базе.
 *
 * Вторая половина того же скрина: карточка ОДНОВРЕМЕННО писала «Линия и
 * точки маршрута расходятся», не показывала расстояние — и рисовала эту
 * линию. Экран говорил «не верь этому» и «вот путь» сразу; из двух
 * сообщений в поле читают нарисованное.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlausibleTrackPoint, extractTrackpoints } from '@/lib/routes/track';

const PLANNING = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('координата вне Камчатки не координата этого трека', () => {
  it('настоящие точки края принимаются', () => {
    expect(isPlausibleTrackPoint(53.02, 158.65)).toBe(true);  // Петропавловск
    expect(isPlausibleTrackPoint(56.06, 160.64)).toBe(true);  // Ключевская сопка
    expect(isPlausibleTrackPoint(51.4, 156.9)).toBe(true);    // юг края
  });

  it('нулевая долгота отсекается — та самая линия через весь экран', () => {
    // lat 53 + lng 0 даёт горизонталь от Камчатки до Гринвича.
    expect(isPlausibleTrackPoint(53.02, 0)).toBe(false);
  });

  it('переставленные оси отсекаются', () => {
    // [lat, lng] вместо [lng, lat]: широта 158 не существует.
    expect(isPlausibleTrackPoint(158.65, 53.02)).toBe(false);
  });

  it('физически невозможные значения отсекаются до проверки границ', () => {
    expect(isPlausibleTrackPoint(91, 160)).toBe(false);
    expect(isPlausibleTrackPoint(55, 181)).toBe(false);
    expect(isPlausibleTrackPoint(NaN, 160)).toBe(false);
    expect(isPlausibleTrackPoint(55, Infinity)).toBe(false);
  });

  it('далёкие, но валидные координаты — не этот трек', () => {
    expect(isPlausibleTrackPoint(55.75, 37.61)).toBe(false);  // Москва
    expect(isPlausibleTrackPoint(35.68, 139.69)).toBe(false); // Токио
  });
});

describe('мусор не доезжает до карты через extractTrackpoints', () => {
  it('LineString чистится от негодных точек', () => {
    const pts = extractTrackpoints(
      {
        type: 'LineString',
        coordinates: [
          [158.65, 53.02],  // годная
          [0, 53.02],       // нулевая долгота — источник горизонтали
          [158.70, 53.05],  // годная
          [53.02, 158.65],  // переставленные оси
        ],
      },
      null,
    );
    expect(pts).toHaveLength(2);
    expect(pts.every(p => p.lng > 154 && p.lng < 175)).toBe(true);
  });

  it('legacy payload.track чистится так же', () => {
    const pts = extractTrackpoints(null, {
      track: [
        { lat: 53.02, lng: 158.65 },
        { lat: 53.02, lng: 0 },
        { lat: 0, lng: 0 },
      ],
    });
    expect(pts).toHaveLength(1);
  });
});

describe('линия, которой не верим, не рисуется', () => {
  /**
   * Регресс 24.08: прежняя версия этого сторожа проверяла буквальный текст
   * `const line = trackTrusted ? track : fallback` — то есть требовала
   * ИМЕННО ТУ строку, в которой и была ошибка. dataConflict отключал трек,
   * но код падал на fallback (прямую между путевыми точками), и получался
   * тот же полный экран уверенной линии, от которого чинили 17.08— просто
   * из точек, а не из geometry. Полевой отчёт 24.08 (владелец, тестовый
   * прогон вне маршрута): в схеме «вид сверху» трек рисуется как надо, на
   * настоящей карте — прямая линия через весь экран.
   *
   * Сторож проверяет ПОВЕДЕНИЕ: при расхождении линия гасится целиком, а не
   * то, какими словами это написано в исходнике.
   */
  it('при расхождении гасится ЛЮБАЯ линия — трек и фолбэк по точкам тоже', () => {
    const body = PLANNING.slice(
      PLANNING.indexOf('const mapMarkers: MapMarker[] = useMemo'),
      PLANNING.indexOf('}, [track, waypoints, currentWpIdx'),
    );
    // `line` присваивается один раз — и это присваивание обязано начинаться
    // с проверки dataConflict, а не с выбора между track и fallback.
    const assigns = [...body.matchAll(/\bconst line = /g)];
    expect(assigns).toHaveLength(1);
    const line = body.slice(assigns[0].index, assigns[0].index + 200);
    expect(line).toMatch(/^const line = approach\?\.dataConflict === true\s*\n?\s*\?\s*null/);
  });

  it('без расхождения трек по-прежнему предпочтён фолбэку по точкам', () => {
    expect(PLANNING).toMatch(/const trackTrusted = track && track\.length >= 2;/);
  });

  it('расхождение входит в зависимости карты — иначе линия застынет', () => {
    // Без этого memo не пересоберётся, когда расхождение обнаружится.
    const deps = PLANNING.slice(PLANNING.indexOf('}, [track, waypoints, currentWpIdx'));
    expect(deps.slice(0, 160)).toMatch(/approach\?\.dataConflict/);
  });
});
