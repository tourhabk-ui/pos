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

/** Категории находок, полученных ДЕТЕРМИНИРОВАННО (не догадка модели). */
export const DETERMINISTIC_CATEGORIES = new Set(['ux', 'security', 'tech_debt', 'intel']);

/**
 * Догадка ли это модели. Находки LLM-ревью маппятся в 'bug' (growth-agent),
 * поэтому именно они гасятся при низкой точности. Разведка ('intel')
 * заземлена в тексте дайджеста и под гашение не попадает.
 */
export function isModelGuess(category: string): boolean {
  return !DETERMINISTIC_CATEGORIES.has(category);
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
