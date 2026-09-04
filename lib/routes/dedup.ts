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

/**
 * ── Перенос полей при слиянии (04.09) ──────────────────────────────────────
 *
 * До этого дня слияние переносило ровно четыре вещи: геометрию (и только
 * когда у keep нет настоящей), путевые точки, туры и отметку `merged_into_id`.
 * Всё остальное оставалось на скрытой записи, и предупреждение честно об этом
 * говорило — но человеку приходилось выбирать, что потерять.
 *
 * Случай, который это вскрыл: «Бабий камень» (официальный паспорт
 * visitkamchatka, телефон МЧС, две опасности, но без линии) и «Водопад Бабий
 * камень» (снятый трек в 148 точек и описание длиннее, но без паспорта). Ни
 * одна запись не богаче другой; любой выбор keep терял безопасность или путь.
 *
 * Правило переноса — «заполнить только пустое, никогда не перезаписывать»:
 *
 *   у keep пусто, у merge есть  → переносим
 *   у keep есть                 → не трогаем (короткое не затрёт длинное)
 *   у обоих есть, значения РАЗНЫЕ → конфликт, решает человек
 *
 * Третий исход не сливается автоматически намеренно (§4.0): склеить два
 * разных описания или два разных телефона МЧС нельзя, а выбрать одно молча —
 * значит подменить решение человека своим.
 *
 * `source_url` в списке есть, и правило его защищает само: у keep он указывает
 * на донора линии (§12, происхождение трека), непустой — значит не тронут.
 */
export type FieldKind = 'text' | 'array' | 'scalar';

export interface TransferField {
  col: string;
  kind: FieldKind;
  /** Зачем это поле переносить — для плана, который читает человек. */
  why: string;
}

/**
 * Поля, которые слияние доносит до keep. Список ЯВНЫЙ: перенос «всего, что
 * найдём» затронул бы служебное (dedupe_key, metadata, is_visible) и сделал
 * бы слияние непредсказуемым.
 */
export const TRANSFER_FIELDS: TransferField[] = [
  { col: 'pdf_url',                    kind: 'text',   why: 'официальный паспорт маршрута' },
  { col: 'source_url',                 kind: 'text',   why: 'страница-источник' },
  { col: 'mchs_phone',                 kind: 'text',   why: 'телефон МЧС' },
  { col: 'mchs_registration_required', kind: 'scalar', why: 'регистрация в МЧС обязательна' },
  { col: 'registration_required',      kind: 'scalar', why: 'требуется регистрация' },
  { col: 'park_name',                  kind: 'text',   why: 'природный парк' },
  { col: 'park_approval_url',          kind: 'text',   why: 'согласование с дирекцией парка' },
  { col: 'hazards',                    kind: 'array',  why: 'опасности маршрута' },
  { col: 'equipment',                  kind: 'array',  why: 'снаряжение' },
  { col: 'description',                kind: 'text',   why: 'описание' },
  { col: 'distance_km',                kind: 'scalar', why: 'дистанция' },
  { col: 'elevation_gain_m',           kind: 'scalar', why: 'набор высоты' },
  { col: 'duration_hours',             kind: 'scalar', why: 'длительность' },
  { col: 'season',                     kind: 'text',   why: 'сезон' },
  { col: 'route_type',                 kind: 'text',   why: 'тип маршрута' },
  { col: 'flora_fauna',                kind: 'text',   why: 'флора и фауна' },
  { col: 'accessibility',              kind: 'text',   why: 'доступность' },
];

/**
 * Пусто ли значение. Приходит текстом (`::text` из SQL), потому что сравнивать
 * и решать проще на одном виде, чем на пяти типах.
 *
 * Пустой массив приезжает как `{}` — это «нечего переносить», а не значение.
 * Для булева NULL — пусто, а `false` — ЗНАЧЕНИЕ: «регистрация не требуется»
 * сказано так же явно, как «требуется», и затирать его нельзя.
 */
export function isEmptyValue(raw: string | null, kind: FieldKind): boolean {
  if (raw === null || raw === undefined) return true;
  const v = raw.trim();
  if (v === '') return true;
  if (kind === 'array') return v === '{}';
  return false;
}

export interface FieldTransferPlan {
  /** Что переедет: keep пусто, merge есть. */
  fill: Array<{ col: string; why: string; value: string }>;
  /** Что решает человек: у обоих есть, и значения разные. */
  conflicts: Array<{ col: string; why: string; keep: string; merge: string }>;
}

/**
 * План переноса по одной паре. Чистая: на входе значения обеих записей
 * текстом, на выходе — что залить и о чём спросить человека.
 */
export function planFieldTransfer(
  keep: Record<string, string | null>,
  merge: Record<string, string | null>,
  fields: TransferField[] = TRANSFER_FIELDS,
): FieldTransferPlan {
  const plan: FieldTransferPlan = { fill: [], conflicts: [] };
  for (const f of fields) {
    const k = keep[f.col] ?? null;
    const m = merge[f.col] ?? null;
    const mergeEmpty = isEmptyValue(m, f.kind);
    if (mergeEmpty) continue;                       // переносить нечего
    const keepEmpty = isEmptyValue(k, f.kind);
    if (keepEmpty) {
      plan.fill.push({ col: f.col, why: f.why, value: (m ?? '').slice(0, 120) });
    } else if ((k ?? '').trim() !== (m ?? '').trim()) {
      plan.conflicts.push({
        col: f.col, why: f.why,
        keep: (k ?? '').slice(0, 120),
        merge: (m ?? '').slice(0, 120),
      });
    }
  }
  return plan;
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
  /** Что переносится и что осталось человеку. Без него план неполон. */
  transfer?: FieldTransferPlan;
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
  // Паспорт больше не теряется молча: он переносится правилом «заполнить
  // только пустое». Предупреждение остаётся ровно для того случая, когда
  // перенести нельзя — у keep своё непустое значение, и оно другое.
  const t = f.transfer;
  if (t) {
    if (t.fill.length > 0) {
      w.push(`${f.mergeName}: переезжает на «${f.keepName}» — ${t.fill.map(x => x.why).join(', ')}`);
    }
    for (const c of t.conflicts) {
      w.push(`${f.mergeName}: у обоих заполнено «${c.why}» (${c.col}), значения разные — оставлено значение «${f.keepName}», решает человек`);
    }
    if (f.mergeHasPassport && !t.fill.some(x => x.col === 'pdf_url' || x.col === 'mchs_phone')
        && !t.conflicts.some(x => x.col === 'pdf_url' || x.col === 'mchs_phone')) {
      w.push(`${f.mergeName}: паспортные данные дубля совпадают с оставляемым — переносить нечего`);
    }
  } else if (f.mergeHasPassport) {
    // Плана переноса нет вовсе — значит вызывающий его не посчитал. Молчать
    // об этом нельзя: «не переносили» и «нечего переносить» — разные вещи.
    w.push(`${f.mergeName}: у дубля паспортные данные (PDF/МЧС), перенос не рассчитан — сверить вручную`);
  }
  return w;
}
