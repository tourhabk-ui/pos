/**
 * lib/routes/trust-decision.ts — решение о доверии к маршруту.
 *
 * План «Порядок в маршрутах», Ф2. Единственный авторитетный ответ на вопрос
 * «что платформа вправе обещать по этой записи»: состояние, причины словами и
 * НАБОР ПРОВЕРЯЕМЫХ ФАКТОВ, из которых состояние собрано.
 *
 * ── Почему факты, а не одно поле ──────────────────────────────────────────
 *
 * Одно «пригоден/не пригоден» скрывает причину: экран не может объяснить
 * отказ, перепись не видит, КАКОЙ факт исчез, а срок годности не выражается
 * вовсе. Решение владельца 19.08 (по практике AllTrails и модели W3C PROV):
 * хранить основания рядом с итогом.
 *
 * ── Почему lineKind отделён от истории копии ──────────────────────────────
 *
 * В первой редакции контракта у рода линии стояло значение «копия источника»
 * рядом с «снятый трек» и «синтетика». Это снова одно слово за две разные
 * вещи: копия с источника может быть и снятым треком, и наброском прямыми —
 * свойства ортогональные. `lineKind` отвечает только «чем линия является»,
 * история копии живёт в `sourceMatch` и `donorBinding`.
 *
 * ── Решение A: три улики вместо двух точек ────────────────────────────────
 *
 * Черта требовала ≥2 путевых точек, иначе «линию не с чем сверить». Для 264
 * записей это был приговор без вины: у линии просто нет разметки.
 *
 * Но у линии появились три НЕЗАВИСИМЫЕ улики, и вместе они сильнее, чем две
 * точки на ней:
 *
 *   1. запись прибора — высота на каждой точке при неровном шаге;
 *   2. совпадение с оригиналом — наша копия равна странице-источнику;
 *   3. личность донора — страница является собственным источником записи.
 *
 * Третья обязательна: первые две говорят о ЛИНИИ, а не о её принадлежности
 * этой карточке. Без неё право получили бы и линии, привинченные по близости
 * старта, — ровно те, что дали «Восхождение на Вилючинский» с чужим треком.
 *
 * Четвёртое условие — СВЕЖЕСТЬ. Сверка сравнивала копию со страницей на тот
 * день; протухшая улика ничем не лучше отсутствующей.
 */

import { routeNavigability, type Navigability, type NavigabilityInput } from '@/lib/routes/navigability';
import { checkFreshness, type CheckFreshness } from '@/lib/routes/track-reconcile';
import type { TravelMode } from '@/lib/routes/travel-mode';

/** Чем линия ЯВЛЯЕТСЯ — без примеси того, откуда она скопирована. */
export type LineKind = 'recorded_track' | 'sketch' | 'unknown';

/** Принадлежит ли линия этой карточке. */
export type DonorBinding = 'confirmed' | 'proximity_only' | 'missing';

/** Совпадение нашей копии с оригиналом (Ф1, route_source_checks). */
export type SourceMatch = 'verified' | 'truncated' | 'different' | 'not_checked';

/** Непрерывна ли линия — разрыв не склеивается прямой (§12). */
export type Continuity = 'continuous' | 'segmented' | 'unknown';

export interface TrustEvidence {
  lineKind: LineKind;
  sourceRecorded: boolean;
  donorBinding: DonorBinding;
  sourceMatch: SourceMatch;
  continuity: Continuity;
  activityFit: 'foot' | 'non_foot' | 'unknown';
  checkedAt: string | null;
}

export interface RouteTrustDecision {
  state: Navigability['verdict'];
  canLead: boolean;
  reasons: string[];
  evidence: TrustEvidence;
  freshness: CheckFreshness;
  /**
   * Сработало ли решение A — право вести получено по трём уликам, а не по
   * путевым точкам. Нужно отчётам: рост пригодных без разметки должен быть
   * ВИДЕН как таковой, а не выглядеть внезапным улучшением данных.
   */
  ledByEvidence: boolean;
}

export interface TrustInput extends Omit<NavigabilityInput, 'mode'> {
  mode?: TravelMode;
  /** Сохранённая сверка с источником; null — сверки не было. */
  sourceCheck: {
    verdict: string | null;
    checkedAt: string | Date | null;
    geometryHash: string | null;
  } | null;
  /** Отпечаток НАШЕЙ линии сейчас — чтобы понять, ту ли линию сверяли. */
  geometryHash: string | null;
  /** Связь линии с этой карточкой. */
  donorBinding: DonorBinding;
  /** Непрерывность линии, если её считали. */
  continuity?: Continuity;
  /** Момент «сейчас» — передаётся, чтобы решение было воспроизводимым. */
  now: Date;
}

/** Вердикт сверки → факт о копии. Незнакомое и отсутствующее — «не сверяли». */
export function toSourceMatch(verdict: string | null | undefined): SourceMatch {
  switch (verdict) {
    case 'same': return 'verified';
    case 'ours_truncated': return 'truncated';
    case 'line_moved':
    case 'ours_extra':
    case 'elevation_lost': return 'different';
    default: return 'not_checked';
  }
}

export function routeTrustDecision(i: TrustInput): RouteTrustDecision {
  const freshness = checkFreshness(
    i.sourceCheck ? { checkedAt: i.sourceCheck.checkedAt, geometryHash: i.sourceCheck.geometryHash } : null,
    i.geometryHash,
    i.now,
  );
  const sourceMatch = toSourceMatch(i.sourceCheck?.verdict);

  const lineKind: LineKind =
    i.grade === 'sketch' ? 'sketch'
      : i.evidence === 'recorded' ? 'recorded_track'
        : 'unknown';

  /**
   * Три улики плюс свежесть. Порядок условий не важен, важна их
   * СОВМЕСТНОСТЬ: каждое закрывает свою дыру, и любое одиночное снятие
   * возвращает старую ошибку.
   *
   * `sketch` исключён отдельно и намеренно: улика прощает незнание
   * происхождения, но не знание обратного.
   */
  const provenLine =
    lineKind === 'recorded_track' &&
    sourceMatch === 'verified' &&
    i.donorBinding === 'confirmed' &&
    freshness === 'current';

  const nav = routeNavigability({
    grade: i.grade,
    track: i.track,
    waypoints: i.waypoints,
    waypointTypes: i.waypointTypes,
    waypointKinds: i.waypointKinds,
    evidence: i.evidence,
    mode: i.mode,
    // Решение A: право вести можно получить и без путевых точек — но только
    // когда все три улики на месте и не протухли.
    lineProvenWithoutWaypoints: provenLine,
  });

  return {
    state: nav.verdict,
    canLead: nav.canLead,
    reasons: nav.reasons,
    evidence: {
      lineKind,
      sourceRecorded: i.grade !== 'points_only' && i.grade !== 'unknown',
      donorBinding: i.donorBinding,
      sourceMatch,
      continuity: i.continuity ?? 'unknown',
      activityFit: i.mode === undefined ? 'unknown' : i.mode === 'foot' ? 'foot' : 'non_foot',
      checkedAt: i.sourceCheck?.checkedAt
        ? (i.sourceCheck.checkedAt instanceof Date
          ? i.sourceCheck.checkedAt.toISOString()
          : i.sourceCheck.checkedAt)
        : null,
    },
    freshness,
    ledByEvidence: provenLine && nav.verdict === 'navigable',
  };
}
