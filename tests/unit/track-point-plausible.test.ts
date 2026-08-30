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
    // Правка 29.08: построение line/trackTrusted переехало в общую функцию
    // computeRouteLineMarker (используется и mapMarkers, и backgroundMapMarkers
    // — см. описание выше), но инвариант тот же: `line` присваивается один
    // раз, и это присваивание обязано начинаться с проверки dataConflict,
    // а не с выбора между track и fallback.
    const body = PLANNING.slice(
      PLANNING.indexOf('function computeRouteLineMarker'),
      PLANNING.indexOf('function OnTrailTab'),
    );
    const assigns = [...body.matchAll(/\bconst line = /g)];
    expect(assigns).toHaveLength(1);
    const line = body.slice(assigns[0].index, assigns[0].index + 100);
    expect(line).toMatch(/^const line = dataConflict\s*\?\s*null/);
  });

  it('без расхождения трек по-прежнему предпочтён фолбэку по точкам', () => {
    const body = PLANNING.slice(
      PLANNING.indexOf('function computeRouteLineMarker'),
      PLANNING.indexOf('function OnTrailTab'),
    );
    expect(body).toMatch(/const trackTrusted = track != null && track\.length >= 2;/);
  });

  it('расхождение входит в зависимости карты — иначе линия застынет', () => {
    // Без этого memo не пересоберётся, когда расхождение обнаружится.
    const deps = PLANNING.slice(PLANNING.indexOf('}, [track, waypoints, currentWpIdx'));
    expect(deps.slice(0, 160)).toMatch(/approach\?\.dataConflict/);
  });
});

describe('фоновый слой карты — только линия, независимо посчитанная (владелец 29.08, два скрина)', () => {
  /**
   * Скрин 1: постоянная карта-фон (Шаг 1 редизайна) видна ВСЕГДА, в т.ч. под
   * приборной колонкой — кружок-пин путевой точки «3» торчал в узком
   * промежутке между геройской карточкой и панелью действий. Пины рассчитаны
   * на полноэкранный режим «Карта», где им есть место.
   *
   * Скрин 2 (тот же день, следом): фон брал mapMarkers.filter(...) —
   * ту же identity, что и живой mapMarkers, зависящий от crumbs/
   * approachLine (обновляются на каждом шаге человека). Карта «постоянно
   * моргает» — фон пересоздавался вслед за живым треком. Фикс — не фильтр
   * над живым массивом, а НЕЗАВИСИМЫЙ useMemo с узким набором зависимостей
   * (через общую функцию computeRouteLineMarker, не вторую копию логики
   * построения линии).
   */
  it('backgroundMapMarkers — свой useMemo через computeRouteLineMarker, не фильтр над mapMarkers', () => {
    const at = PLANNING.indexOf('const backgroundMapMarkers: MapMarker[] = useMemo');
    expect(at).toBeGreaterThan(0);
    const body = PLANNING.slice(at, PLANNING.indexOf('}, [', at) + 200);
    expect(body).toMatch(/computeRouteLineMarker\(/);
    expect(body).not.toMatch(/mapMarkers\.filter/);
    // Узкие зависимости — явно НЕ включают coords/crumbs/approachLine/
    // currentWpIdx: это и есть то, что раньше заставляло фон мигать.
    const depsAt = body.indexOf('}, [');
    const deps = body.slice(depsAt, depsAt + 120);
    expect(deps).not.toMatch(/crumbs/);
    expect(deps).not.toMatch(/approachLine/);
    expect(deps).not.toMatch(/currentWpIdx/);
  });

  it('mapMarkers (живой, полноэкранный режим) строит линию той же общей функцией', () => {
    const at = PLANNING.indexOf('const mapMarkers: MapMarker[] = useMemo');
    expect(at).toBeGreaterThan(0);
    const body = PLANNING.slice(at, at + 400);
    expect(body).toMatch(/computeRouteLineMarker\(/);
  });

  it('постоянная карта-фон использует независимый набор, полноэкранная — полный живой', () => {
    expect(PLANNING).toMatch(/markers=\{showMap \? mapMarkers : backgroundMapMarkers\}/);
  });
});
