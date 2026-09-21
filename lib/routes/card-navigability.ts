/**
 * Вердикт о ведении для карточки маршрута — считается в одном месте.
 *
 * ── Зачем вынесено (21.09) ────────────────────────────────────────────────
 *
 * Сборка вердикта жила выражением на месте внутри `app/api/routes/[id]`:
 * разбор геометрии, улика прибора, паспорт, рода точек и связей, способ
 * передвижения — всё внутри одного объекта ответа. Пока спрашивал один
 * читатель, это было незаметно.
 *
 * Читателей стало два: объяснение решения (`/api/routes/[id]/explain`)
 * обязано пересказывать ТОТ ЖЕ вердикт, который человек видит на экране.
 * Посчитай оно свой — получилось бы два правила (§12), и разошлись бы они
 * молча: на экране одно, в объяснении другое, и проверить некому.
 *
 * ── Почему линия возвращается наружу ──────────────────────────────────────
 *
 * Вызывающему она тоже нужна (вычисленные этапы), а два разбора одной
 * геометрии рядом — это две линии, которые рано или поздно разойдутся. Здесь
 * разбор один, и его результат отдаётся вместе с вердиктом.
 *
 * Улика прибора при этом считается по СЫРОЙ геометрии: высота лежит третьим
 * числом, разбор в пары его отбрасывает, а прореживание выравнивает шаг —
 * то есть стирает главный признак живой записи.
 */

import { extractTrackpoints, decimateTrackWithScale } from '@/lib/routes/track';
import { buildRoutePassport } from '@/lib/routes/passport';
import { routeNavigability, type Navigability } from '@/lib/routes/navigability';
import { trackEvidence } from '@/lib/routes/track-evidence';
import { asLinkKind, isPathPoint } from '@/lib/routes/link-kind';
import { detectTravelMode } from '@/lib/routes/travel-mode';

/**
 * Строка путевой точки в том виде, в каком её отдаёт запрос карточки.
 *
 * Имена — КОЛОНОК ЗАПРОСА (`p.lat AS place_lat`), а не таблицы. Разница
 * стоила платформе трёх недель молчания: фильтр карточки спрашивал `w.lat`,
 * такого поля в результате нет, `undefined != null` — ложь, и до черты не
 * доходило НИ ОДНОЙ путевой точки. Любой маршрут, сколько бы точек ему ни
 * разметили, получал «линию не с чем сверить: путевых точек меньше двух».
 *
 * Поэтому тип здесь есть: чтобы следующее такое рассогласование поймал
 * компилятор, а не человек в поле.
 */
export interface WaypointRow {
  place_lat: unknown;
  place_lng: unknown;
  place_name?: string | null;
  location_type?: string | null;
  link_kind?: string | null;
}

/** Есть ли у строки обе координаты. Точка без них путём не является. */
export function hasCoords(w: WaypointRow): boolean {
  return w.place_lat != null && w.place_lng != null;
}

export interface CardNavigabilityInput {
  /** Сырая геометрия записи — нужна улике прибора. */
  geometry: unknown;
  /** payload карточки: второй источник точек линии. */
  payload: Record<string, unknown> | null;
  /** Путевые точки — ТОЛЬКО с координатами: точка без них путём не является. */
  waypointRows: WaypointRow[];
  title: string | null;
  activityType: string | null;
}

export interface CardNavigability {
  navigability: Navigability;
  /** Разобранная линия — тот же единственный разбор. `null`, если линии нет. */
  track: Array<[number, number]> | null;
}

export function routeCardNavigability(i: CardNavigabilityInput): CardNavigability {
  const { points } = decimateTrackWithScale(extractTrackpoints(
    i.geometry as { type?: string; coordinates?: number[][] } | null,
    i.payload,
  ));
  const track = points.length >= 2 ? points.map((p) => [p.lat, p.lng] as [number, number]) : null;

  const wps = i.waypointRows.map((w) => ({ lat: Number(w.place_lat), lng: Number(w.place_lng) }));
  // Рода нужны черте, чтобы не считать противоречием центроид парка.
  const wpTypes = i.waypointRows.map((w) => w.location_type ?? null);
  // Род связи: «рядом» не описывает путь и в суждении не участвует.
  const wpKinds = i.waypointRows.map((w) => asLinkKind(w.link_kind ?? null));

  const navigability = routeNavigability({
    evidence: trackEvidence(i.geometry).verdict,
    grade: buildRoutePassport({
      track,
      geometrySource: ((i.geometry as { source?: string } | null)?.source ?? null),
      // Паспорт считает ТОЧКИ ПУТИ: «рядом» линию не поверяет.
      waypointsCount: wpKinds.filter(isPathPoint).length,
      routeVersion: null, verifiedAt: null, updatedAt: null,
      mchsRequired: false, mchsPhone: null, parkName: null,
      parkApprovalUrl: null, officialPassportUrl: null,
    }).grade,
    track,
    waypoints: wps,
    waypointTypes: wpTypes,
    waypointKinds: wpKinds,
    // Способ передвижения: у облёта линию не проходят по земле, и обещание
    // ведения к нему не относится.
    mode: detectTravelMode(i.title, i.activityType),
  });

  return { navigability, track };
}
