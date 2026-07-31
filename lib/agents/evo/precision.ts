/**
 * Точность эволюции = цена её ошибки.
 *
 * Инцидент 24.07: десять ложных critical ушли в трекер, и это не стоило
 * системе ничего — ни одна метрика не сдвинулась, никакой тормоз не сработал.
 * Уверенное враньё обходилось дешевле молчания.
 *
 * Здесь считаем долю находок, которые человек принял, против отвергнутых.
 * Падает ниже порога — эволюция перестаёт публиковать ДОГАДКИ (находки
 * LLM-ревью) и зовёт человека. Детерминированные находки (static-checks,
 * мок-детектор) продолжают идти: они не гадают, а читают синтаксис, поэтому
 * их точность не зависит от настроения модели.
 *
 * Честная деградация вместо уверенного вранья — тот же принцип, что «прочёс
 * ослеп» у скана и «фид молчит» у разведки.
 *
 * Чистые функции — под тестом.
 */

/**
 * Категории находок, полученных ДЕТЕРМИНИРОВАННО (не догадка модели):
 * static-checks и мок-детектор читают синтаксис, а не гадают.
 *
 * Разведки ('intel') здесь БОЛЬШЕ НЕТ. Прежнее обоснование — «заземлена в
 * тексте дайджеста» — смешивает два разных заземления: находку сочиняет
 * `callAIDecision` по RSS, и то, что она верно пересказывает новость, ничего
 * не говорит о её применимости к нашему коду и приоритетам. Пока intel был
 * выведен из-под тормоза, он оставался единственной категорией, которая
 * публиковалась при просевшей точности, — и трекер заполнялся именно им.
 */
export const DETERMINISTIC_CATEGORIES = new Set(['ux', 'security', 'tech_debt']);

/**
 * Догадка ли это модели. Находки LLM-ревью маппятся в 'bug' (growth-agent),
 * разведка — в 'intel'; обе гасятся при низкой точности.
 */
export function isModelGuess(category: string): boolean {
  return !DETERMINISTIC_CATEGORIES.has(category);
}

/** Вердикт человека, снятый с закрытой задачи GitHub. */
export type IssueVerdict = 'fixed' | 'rejected' | null;

/**
 * Как закрытие задачи человеком превращается в статус находки.
 *
 * Считать надо ОБА вердикта. Раньше засчитывался только отказ, и точность —
 * accepted/(accepted+rejected) — систематически ползла вниз: отказы копились,
 * принятия нет. Ниже порога гаснут догадки модели, то есть код-находки, и в
 * трекере остаётся только то, что выведено из-под тормоза.
 *
 * `undefined`/`null` — задача закрыта без указания причины (так закрывались
 * старые issue). Вердиктом это не считаем: догадка здесь двигала бы метрику,
 * на которой держится глушение, а пропуск всего лишь оставляет находку в работе.
 */
export function issueVerdict(stateReason: string | null | undefined): IssueVerdict {
  if (stateReason === 'completed') return 'fixed';
  if (stateReason === 'not_planned' || stateReason === 'duplicate') return 'rejected';
  return null;
}

export interface PrecisionStats {
  /** Находки, принятые человеком (accepted/fixed). */
  accepted: number;
  /** Отвергнутые человеком или стражем (rejected/ignored). */
  rejected: number;
}

/** Минимум наблюдений, до которого судить о точности рано. */
export const MIN_SAMPLE = 8;

/** Порог: ниже — публикация догадок останавливается. */
export const PRECISION_FLOOR = 0.5;

/**
 * Точность: accepted / (accepted + rejected). null — выборка мала,
 * судить рано (период привыкания, как у сторожа источников).
 */
export function computePrecision(s: PrecisionStats): number | null {
  const total = s.accepted + s.rejected;
  if (total < MIN_SAMPLE) return null;
  return s.accepted / total;
}

export interface PublishDecision {
  /** Публиковать ли догадки модели. */
  allowGuesses: boolean;
  precision: number | null;
  /** Причина для лога/алерта — человекочитаемая. */
  reason: string;
}

/**
 * Решение о публикации. Детерминированные находки идут ВСЕГДА — гасим только
 * догадки, и только когда данных достаточно, чтобы утверждать деградацию.
 */
export function decidePublish(s: PrecisionStats, floor = PRECISION_FLOOR): PublishDecision {
  const precision = computePrecision(s);
  if (precision === null) {
    return {
      allowGuesses: true,
      precision: null,
      reason: `точность ещё не измерена (наблюдений ${s.accepted + s.rejected} < ${MIN_SAMPLE})`,
    };
  }
  if (precision < floor) {
    return {
      allowGuesses: false,
      precision,
      reason:
        `точность ${(precision * 100).toFixed(0)}% ниже порога ${(floor * 100).toFixed(0)}% ` +
        `(принято ${s.accepted}, отвергнуто ${s.rejected}) — догадки модели не публикуются, ` +
        `идут только детерминированные находки`,
    };
  }
  return {
    allowGuesses: true,
    precision,
    reason: `точность ${(precision * 100).toFixed(0)}% — публикация в норме`,
  };
}

/** Фильтр находок по решению: при запрете догадок оставляем только детерминированные. */
export function applyPublishDecision<T extends { category: string }>(
  findings: T[],
  decision: PublishDecision,
): T[] {
  if (decision.allowGuesses) return findings;
  return findings.filter((f) => !isModelGuess(f.category));
}
