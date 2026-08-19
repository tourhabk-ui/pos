/**
 * lib/routes/census-verdict.ts — Ф6: не дать правилу разъехаться.
 *
 * Перепись уже считает распределение доказательств. Чего у неё не было —
 * СУЖДЕНИЯ: цифры печатались в лог, и решал их человек, если смотрел. Сторож,
 * который зависит от того, посмотрел ли кто-то в лог, — не сторож.
 *
 * ── Почему пороги живут здесь, а не в голове ───────────────────────────────
 *
 * План Ф6 требует прямо: пороги «определены на первой стабильной переписи и
 * ЗАПИСАНЫ В РЕПОЗИТОРИИ, а не в памяти». Порог, который помнит человек,
 * незаметно смягчается — сначала на единицу, потом на десяток, и через месяц
 * красное перестаёт краснеть.
 *
 * ── Красное обязано быть адресуемым ────────────────────────────────────────
 *
 * У каждой находки есть `action` — что именно делать. Сигнал без действия
 * читается как шум и через неделю выключается. Это не украшение отчёта: 19.08
 * строка «канал mcp не отдал ни одного тура» провисела восемь суток именно
 * потому, что не называла, ЧТО чинить.
 */

import type { GeometryAudit } from '@/lib/routes/geometry-audit';

/**
 * Замер 19.08.2026 — первая перепись, где все слои считались исправно.
 *
 * Это НЕ желаемые значения, а измеренные. Порог, рождённый красным, выключают
 * в первую же неделю (тот же урок, что у ночной сверки каналов).
 */
export const CENSUS_BASELINE = {
  /** Маршрутов, которые платформа вправе предлагать как путь. */
  navigable: 215,
  /** Связей «маршрут здесь проходит» после разметки рода (миграция 874). */
  waypointLinks: 134,
  /** Линий с уликами записи — снятый прибором трек. */
  recordedTracks: 277,
  /** Записей в очередях уборки: растёт — данные портятся быстрее, чем чинятся. */
  cleanupTotal: 86,
} as const;

/**
 * Насколько дозволено просесть, прежде чем это регрессия.
 *
 * Просадка на единицы штатна: маршрут сняли с публикации, у линии отозвали
 * улику. Просадка на десятую часть — нет.
 */
export const TOLERANCE = 0.1;

export interface CensusFinding {
  metric: string;
  expected: number;
  actual: number;
  /** Что делать. Без этого сигнал через неделю выключают. */
  action: string;
}

export interface CensusVerdict {
  red: boolean;
  findings: CensusFinding[];
  /** Прогон не состоялся: считать было нечего или нечем. */
  refused: string | null;
}

const floorOf = (base: number): number => Math.floor(base * (1 - TOLERANCE));

/**
 * Судить перепись.
 *
 * Ноль посчитанных маршрутов — ОТКАЗ, а не идеальная чистота: пустой прогон,
 * выданный за успешный, — тот самый дефект, ради которого весь Ф6 и затеян
 * (CLAUDE.md §4.0).
 */
export function judgeCensus(
  audit: Pick<GeometryAudit, 'routes_counted' | 'navigability' | 'link_kinds' | 'track_evidence' | 'cleanup_queues' | 'link_kind_available'>,
  baseline: typeof CENSUS_BASELINE = CENSUS_BASELINE,
): CensusVerdict {
  if (!audit.routes_counted) {
    return {
      red: true, findings: [],
      refused: 'перепись посчитала ноль маршрутов — считать было нечего или нечем; это отказ, а не чистота',
    };
  }

  const findings: CensusFinding[] = [];

  const navigable = audit.navigability?.navigable ?? 0;
  if (navigable < floorOf(baseline.navigable)) {
    findings.push({
      metric: 'пригодные маршруты', expected: floorOf(baseline.navigable), actual: navigable,
      action: 'сверить navigability_reasons с прошлой переписью: упало правило, порог или сами данные',
    });
  }

  // Разметка рода связей могла не доехать. Это не «стало хуже», это «нечем
  // считать» — и различать обязательно, иначе миграция, не применившаяся на
  // проде, покажется деградацией данных.
  if (!audit.link_kind_available) {
    findings.push({
      metric: 'разметка link_kind', expected: 1, actual: 0,
      action: 'миграция 874 не применена на проде — проверить журнал деплоя, а не данные',
    });
  } else {
    const waypoints = audit.link_kinds?.waypoint ?? 0;
    if (waypoints < floorOf(baseline.waypointLinks)) {
      findings.push({
        metric: 'связи «маршрут здесь проходит»', expected: floorOf(baseline.waypointLinks), actual: waypoints,
        action: 'проверить, не переразметило ли что-то waypoint в nearby: род ставится по улике происхождения, а не по расстоянию',
      });
    }
  }

  const recorded = audit.track_evidence?.recorded ?? 0;
  if (recorded < floorOf(baseline.recordedTracks)) {
    findings.push({
      metric: 'линии с уликами записи', expected: floorOf(baseline.recordedTracks), actual: recorded,
      action: 'сверить track_evidence_reasons: улика теряется от перезаписи геометрии или от смены правила',
    });
  }

  const queues = Object.values(audit.cleanup_queues ?? {})
    .reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0), 0);
  if (queues > Math.ceil(baseline.cleanupTotal * (1 + TOLERANCE))) {
    findings.push({
      metric: 'записи в очередях уборки', expected: Math.ceil(baseline.cleanupTotal * (1 + TOLERANCE)), actual: queues,
      action: 'разобрать очередь по причинам (lib/routes/cleanup-queue): данные портятся быстрее, чем чинятся',
    });
  }

  return { red: findings.length > 0, findings, refused: null };
}

/**
 * Инварианты, которые стережёт сторож, а не человек (Ф6 плана).
 *
 * Каждый назван вместе с файлом, который его держит: инвариант без адреса
 * проверки — это пожелание. Список читается тестом, поэтому переименование
 * сторожа заметят сразу, а не через месяц.
 */
export const CENSUS_INVARIANTS = [
  {
    id: 'sketch-never-navigable',
    text: 'набросок никогда не равен «пригоден»',
    guard: 'tests/unit/route-navigability.test.ts',
  },
  {
    id: 'no-core-without-donor',
    text: 'запись без подтверждённого донора не попадает в ядро',
    guard: 'tests/unit/track-attachment-audit.test.ts',
  },
  {
    id: 'derived-not-input',
    text: 'производные этапы не участвуют во входных данных классификатора',
    guard: 'tests/unit/derived-stages.test.ts',
  },
  {
    id: 'offline-pack-has-trust-version',
    text: 'у офлайн-пакета есть версия решения доверия',
    guard: 'tests/unit/field-pack-manifest.test.ts',
  },
  {
    id: 'no-raw-geometry-line',
    text: 'ни один экран не рисует навигационную линию из сырой geometry',
    guard: 'tests/unit/map-line-standard.test.ts',
  },
] as const;

/** Отчёт человеку. Числа сверху, действие — рядом с каждой находкой. */
export function renderCensusVerdict(v: CensusVerdict): string {
  if (v.refused) {
    return `Перепись не состоялась.\n\n${v.refused}`;
  }
  if (!v.red) return 'Перепись в пределах порогов.';

  const lines = [`Перепись вышла за пороги: находок ${v.findings.length}.`, ''];
  for (const f of v.findings) {
    lines.push(`- **${f.metric}**: ${f.actual} при пороге ${f.expected}`);
    lines.push(`  что делать: ${f.action}`);
  }
  lines.push('');
  lines.push('Пороги измерены 19.08.2026 и лежат в `lib/routes/census-verdict.ts`.');
  lines.push('Смягчать их можно только вместе с объяснением, почему прежнее значение было неверным.');
  return lines.join('\n');
}
