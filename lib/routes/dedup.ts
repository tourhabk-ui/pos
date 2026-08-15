/**
 * Слияние маршрутов-дублей — чистые правила, без сети и БД.
 *
 * Перепись 15.08 (data/audit/routes-pain-map-2026-08-15.md): 421 видимый
 * маршрут на 298 различимых якорей — «Поход вокруг Толбачиков» дважды,
 * «Долина Смерти» трижды. Механизм слияния у маршрутов отсутствовал:
 * places-dedup работает только с местами.
 *
 * Конструкция обсуждена с владельцем 15.08 (карт-бланш):
 *
 *   1. ТОЛЬКО поимённый режим. Авто-режима по похожести не будет вовсе:
 *      «Вачкажец (лыжный)» и «Вачкажец (снегоходный)» сидят на одном якоре
 *      с одним предметом — и это два разных продукта. Отличить их может
 *      человек, а не порог похожести.
 *   2. Геометрия: настоящий трек побеждает. Keep оставляет свой трек;
 *      но если у keep пусто или синтетика (source=waypoints_synthetic),
 *      а у merge настоящий снятый — трек переезжает. Это канон KML-инбокса.
 *   3. Туры (operator_tours.route_id) перевешиваются на keep автоматически
 *      и КАЖДЫЙ случай называется warning'ом: тур, смотрящий в скрытый
 *      маршрут, — это сломанная коммерция.
 *   4. Паспортные поля (PDF, МЧС, снаряжение) НЕ переносятся — только
 *      warning «у дубля есть паспортные данные, сверить». Автоперенос
 *      содержимого — тихое слияние текстов, оно уже стреляло.
 *
 * Здесь — валидация пар и правило геометрии; транзакции — в эндпоинте.
 */

export interface RoutePair {
  keep: string;
  merge: string;
}

/**
 * Проблемы списка пар. Один keep для нескольких merge разрешён (три записи
 * Долины Смерти сливаются за один заход); всё остальное, что делает план
 * неоднозначным, — отказ целиком, без частичного применения.
 */
export function pairListProblems(pairs: readonly RoutePair[]): string[] {
  const problems: string[] = [];
  const keeps = new Set(pairs.map(p => p.keep));
  const mergedOnce = new Set<string>();

  for (const p of pairs) {
    if (p.keep === p.merge) {
      problems.push(`${p.keep}: keep и merge — один и тот же id`);
      continue;
    }
    if (keeps.has(p.merge)) {
      problems.push(`${p.merge}: в одном списке стоит и как оставляемое, и как сливаемое`);
    }
    if (mergedOnce.has(p.merge)) {
      problems.push(`${p.merge}: сливается дважды — непонятно, куда`);
    }
    mergedOnce.add(p.merge);
  }
  return problems;
}

export interface GeometryInfo {
  /** GeoJSON есть вообще. */
  present: boolean;
  /** geometry->>'source' — 'waypoints_synthetic' значит прямые между точками. */
  source: string | null;
}

/** Настоящий снятый трек: есть и не синтетика. */
export function isRealTrack(g: GeometryInfo): boolean {
  return g.present && g.source !== 'waypoints_synthetic';
}

/**
 * Забирать ли трек у сливаемого. Правило «настоящий трек побеждает»:
 * переезд происходит ТОЛЬКО когда keep без настоящего трека, а merge — с ним.
 * Во всех остальных случаях keep оставляет своё: два настоящих трека —
 * повод для warning, а не для тихой замены.
 */
export function shouldAdoptGeometry(keep: GeometryInfo, merge: GeometryInfo): boolean {
  return !isRealTrack(keep) && isRealTrack(merge);
}

export interface PairFacts {
  keepName: string;
  mergeName: string;
  keepGeometry: GeometryInfo;
  mergeGeometry: GeometryInfo;
  /** Туров, смотрящих в сливаемый маршрут. */
  mergeTours: number;
  /** У сливаемого есть паспортные данные (pdf_url или mchs_phone). */
  mergeHasPassport: boolean;
}

/** Предупреждения по паре — то, что человек обязан увидеть в плане. */
export function pairWarnings(f: PairFacts): string[] {
  const w: string[] = [];
  if (shouldAdoptGeometry(f.keepGeometry, f.mergeGeometry)) {
    w.push(`${f.mergeName}: настоящий трек переезжает на «${f.keepName}» (у оставляемого ${f.keepGeometry.present ? 'синтетика' : 'пусто'})`);
  } else if (isRealTrack(f.keepGeometry) && isRealTrack(f.mergeGeometry)) {
    w.push(`${f.mergeName}: у ОБОИХ настоящие треки — оставлен трек «${f.keepName}», трек дубля не перенесён, сверить`);
  }
  if (f.mergeTours > 0) {
    w.push(`${f.mergeName}: ${f.mergeTours} тур(а) перевешиваются на «${f.keepName}» — проверить карточки туров`);
  }
  if (f.mergeHasPassport) {
    w.push(`${f.mergeName}: у дубля паспортные данные (PDF/МЧС) — не перенесены, сверить`);
  }
  return w;
}
