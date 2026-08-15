/**
 * Полевой паспорт маршрута — граница доверия к данным, сказанная ДО выбора.
 *
 * План Field Confidence Navigator, этап 1. Паспорт отвечает на вопрос,
 * который турист сейчас задать не может: «это маршрут, по которому можно
 * ориентироваться, — или ломаная между точками, или просто точки?»
 * Самая сильная защита платформы (различение трека и наброска) была видна
 * только после фиксации маршрута, в поле — то есть слишком поздно.
 *
 * Паспорт — ВЫЧИСЛЯЕМЫЙ контракт поверх существующих данных, не таблица:
 * род линии выводится одним правилом (lib/map/line-standard), версия — из
 * kamchatka_routes.route_version (миграция 863), доступ — из МЧС/парковых
 * колонок. Поля, которые некому наполнять (segment_confidence, review_owner),
 * сознательно не заводятся — данные без процесса обновления врут.
 *
 * Не путать с route_passport_ocr — это OCR PDF-паспортов visitkamchatka,
 * другая сущность.
 */

import { trackLine, gradeFromSource } from '@/lib/map/line-standard';
import type { LatLng } from '@/lib/routes/track-fidelity';

/**
 * Род навигационных данных маршрута:
 *   surveyed    — снятый трек: по линии можно идти;
 *   sketch      — линия построена прямыми между точками: ориентир, не тропа;
 *   unknown     — линия есть, происхождение не записано и плотность не судит;
 *   points_only — линии нет, есть путевые точки: ориентирование по азимутам;
 *   none        — нет ни линии, ни точек: навигация невозможна.
 */
export type PassportGrade = 'surveyed' | 'sketch' | 'unknown' | 'points_only' | 'none';

export interface RoutePassport {
  grade: PassportGrade;
  /** Записанный источник линии (idilesom/osm/gpx/…) или null. */
  source: string | null;
  /** Редакция линии и точек (kamchatka_routes.route_version, миграция 863). */
  version: number;
  waypointsCount: number;
  /** Когда паспорт подтверждали (passport_verified_at) — если подтверждали. */
  verifiedAt: string | null;
  /** Когда запись маршрута менялась в последний раз. */
  updatedAt: string | null;
  access: {
    mchsRequired: boolean;
    mchsPhone: string | null;
    parkName: string | null;
    parkApprovalUrl: string | null;
  };
  officialPassportUrl: string | null;
}

export interface PassportInput {
  track: LatLng[] | null;
  /** null — источник спрошен и не записан (не путать с «не спрашивали»). */
  geometrySource: string | null;
  waypointsCount: number;
  routeVersion: number | null;
  verifiedAt: string | null;
  updatedAt: string | null;
  mchsRequired: boolean;
  mchsPhone: string | null;
  parkName: string | null;
  parkApprovalUrl: string | null;
  officialPassportUrl: string | null;
}

export function buildRoutePassport(i: PassportInput): RoutePassport {
  // Род линии решает общий стандарт (источник важнее плотности) — здесь
  // только достраиваются состояния «линии нет вовсе».
  const line = trackLine(i.track, i.geometrySource);
  const grade: PassportGrade = line
    ? line.fidelity
    : i.waypointsCount >= 1
      ? 'points_only'
      : 'none';

  return {
    grade,
    source: i.geometrySource,
    // Записи без миграции 863 читаются как версия 1: «редакций не считали»
    // — это первая известная редакция, а не нулевая.
    version: i.routeVersion ?? 1,
    waypointsCount: i.waypointsCount,
    verifiedAt: i.verifiedAt,
    updatedAt: i.updatedAt,
    access: {
      mchsRequired: i.mchsRequired,
      mchsPhone: i.mchsPhone,
      parkName: i.parkName,
      parkApprovalUrl: i.parkApprovalUrl,
    },
    officialPassportUrl: i.officialPassportUrl,
  };
}

/**
 * Род линии для СПИСКА, где координаты не загружаются: только факт наличия
 * линии и записанный источник. Линия с незаписанным источником — «unknown»,
 * не «sketch» и не «surveyed»: неизвестность не притворяется знанием.
 *
 * `hasWaypoints === false` при отсутствии линии — «none»: маршрут без линии
 * и без точек не получает бейдж «Точки», которых у него нет. `undefined` —
 * вызывающий про точки не знает: остаётся «points_only» (списки навигации
 * фильтруют по наличию точек сами).
 */
export function lineGradeForList(
  hasLine: boolean,
  source: string | null,
  hasWaypoints?: boolean,
): PassportGrade {
  if (!hasLine) return hasWaypoints === false ? 'none' : 'points_only';
  return gradeFromSource(source) ?? 'unknown';
}

/** Бейдж рода данных — слово, которое видит турист при выборе. */
export function passportGradeLabel(grade: PassportGrade): string {
  switch (grade) {
    case 'surveyed':    return 'Трек';
    case 'sketch':      return 'Набросок';
    case 'unknown':     return 'Линия не проверена';
    case 'points_only': return 'Точки';
    case 'none':        return 'Нет данных';
  }
}

/**
 * Оговорка под бейджем — что этот род данных значит для ног.
 * Пустая строка у снятого трека: он не нуждается в оговорке.
 */
export function passportGradeNote(grade: PassportGrade): string {
  switch (grade) {
    case 'surveyed':    return '';
    case 'sketch':      return 'Линия построена прямыми между точками — не используйте её как тропу';
    case 'unknown':     return 'Происхождение линии не записано — сверяйтесь с местностью';
    case 'points_only': return 'Подтверждённой линии нет — ориентирование по точкам и азимутам';
    case 'none':        return 'Данных для навигации нет';
  }
}

/**
 * Подпись главного CTA перехода в поле. «Навигатор» обещает ведение по
 * линии — это обещание можно давать только снятому треку. Для остального
 * честное слово — «ориентирование»: направление и точки, не тропа.
 */
export function passportCtaLabel(grade: PassportGrade): string {
  return grade === 'surveyed' ? 'Открыть навигатор' : 'Открыть ориентирование';
}
