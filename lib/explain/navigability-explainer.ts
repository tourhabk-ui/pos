/**
 * Объяснение вердикта о ведении: решает код, пересказывает модель, проверяет
 * снова код.
 *
 * ── Зачем (21.09) ─────────────────────────────────────────────────────────
 *
 * На экране выбора маршрута человек читает сухое «Точка стоит в 7.9 км от
 * линии — данные маршрута не сходятся». Формулировка верная и для разбора
 * годится, а для решения «идти или не идти» — нет: непонятно, чем это грозит
 * и что делать.
 *
 * Это первая поверхность, где живой промпт уместен, и уместен он ровно
 * потому, что НИЧЕГО НЕ РЕШАЕТ. Вердикт уже вынесен `routeCardNavigability`;
 * здесь его пересказывают, а пересказ проверяют детерминированно
 * (`no-invention`). Ошибка модели стоит показа сухих причин вместо связной
 * фразы — и только.
 *
 * ── Что держит стоимость ──────────────────────────────────────────────────
 *
 * Объяснение спрашивается ЯВНО (`?explain=1`), а не на каждое открытие
 * карточки, и кэшируется по отпечатку решения: пока вердикт и факты те же,
 * платить второй раз незачем. Память процесса, а не таблица: механизм
 * пробный, и заводить схему под непроверенную затею рано.
 *
 * ── Чего здесь нет ────────────────────────────────────────────────────────
 *
 * Влияния на вердикт. Функция получает готовое решение и возвращает текст
 * либо причину, по которой текста нет. Вернуть другой вердикт она не может
 * по устройству — это и держит сторож.
 */

import { callAIFastOrNull } from '@/lib/ai/providers';
import {
  decisionFingerprint, type DecisionFact, type DecisionRecord,
} from '@/lib/explain/decision-record';
import { checkExplanation, MAX_EXPLANATION_CHARS } from '@/lib/explain/no-invention';
import type { Navigability } from '@/lib/routes/navigability';

/** Сколько объяснений держим в памяти процесса. */
const CACHE_LIMIT = 300;
const cache = new Map<string, string>();

export interface ExplainedDecision {
  /** Вердикт кода — повторён здесь, чтобы ответ был самодостаточен. */
  verdict: string;
  canLead: boolean;
  /** Сухие причины. Они же то, что показывается без объяснения и вместо него. */
  reasons: string[];
  /** Связный пересказ. `null` — объяснения нет, и почему, сказано рядом. */
  text: string | null;
  /**
   * Что произошло: `accepted` — пересказ проверен; `rejected` — модель
   * ответила, но противоречиво; `unavailable` — не ответила; `cached` — взято
   * из памяти. Разные слова, потому что это разные состояния (§4.0).
   */
  state: 'accepted' | 'rejected' | 'unavailable' | 'cached';
  /** Причина отказа — для журнала и отладки, не для показа человеку. */
  why: string | null;
}

/**
 * Снимок решения о ведении.
 *
 * Имя спорящей точки берётся у вызывающего: черта знает только номер, а
 * второе вычисление расстояния ради имени дало бы два ответа на один вопрос.
 */
export function navigabilityRecord(
  nav: Navigability,
  waypointNames: Array<string | null>,
): DecisionRecord {
  const facts: DecisionFact[] = [
    { key: 'verdict', label: 'вердикт', value: nav.verdict },
    { key: 'can_lead', label: 'можно ли обещать ведение', value: nav.canLead ? 'да' : 'нет' },
  ];
  if (nav.conflict) {
    const name = waypointNames[nav.conflict.index];
    facts.push({
      key: 'off_track_km',
      label: 'отход спорной точки от линии, км',
      value: nav.conflict.offTrackKm.toFixed(1),
    });
    if (name) facts.push({ key: 'conflict_place', label: 'спорная точка', value: name });
  }
  return {
    kind: 'route_navigability',
    verdict: nav.verdict,
    canLead: nav.canLead,
    reasons: [...nav.reasons],
    facts,
  };
}

/**
 * Промпт требует ровно того, что есть в записи.
 *
 * Требование, которое нечем выполнить, выполняется выдумкой — это записано в
 * §4.0 кровью маара «Медвежья чаша». Поэтому здесь не просят «интересную
 * деталь» и не просят совета: просят пересказать факты и сказать, что они
 * значат для выхода.
 */
function buildPrompt(rec: DecisionRecord): string {
  const facts = rec.facts.map((f) => `- ${f.label}: ${f.value}`).join('\n');
  const reasons = rec.reasons.map((r) => `- ${r}`).join('\n') || '- (причин нет, маршрут пригоден)';
  return [
    'Ты объясняешь туристу решение платформы о маршруте на Камчатке.',
    'Решение уже принято программой. Твоя работа — пересказать его понятно, а не пересматривать.',
    '',
    'ФАКТЫ РЕШЕНИЯ:',
    facts,
    '',
    'ПРИЧИНЫ (формулировки программы):',
    reasons,
    '',
    'ПРАВИЛА:',
    `- Одна-две фразы, не длиннее ${MAX_EXPLANATION_CHARS} знаков, по-русски.`,
    '- Опирайся ТОЛЬКО на факты выше. Ничего не добавляй: ни высот, ни времени, ни названий, которых тут нет.',
    '- Числа повторяй цифрами и ровно так, как они записаны. Не округляй и не пересчитывай.',
    '- Не советуй сходить с тропы и не обещай трек, если ведение не обещано.',
    '- Без эмодзи, без списков, без заголовков.',
    '- Скажи, что это значит для выхода: можно ли идти по этой линии и на что смотреть.',
  ].join('\n');
}

export async function explainNavigability(
  nav: Navigability,
  waypointNames: Array<string | null>,
): Promise<ExplainedDecision> {
  const rec = navigabilityRecord(nav, waypointNames);
  const base = { verdict: rec.verdict, canLead: rec.canLead, reasons: rec.reasons };

  const key = decisionFingerprint(rec);
  const hit = cache.get(key);
  if (hit !== undefined) return { ...base, text: hit, state: 'cached', why: null };

  const raw = await callAIFastOrNull(
    [{ role: 'user', content: buildPrompt(rec) }],
    // Ждём недолго: человек стоит перед выбором маршрута, а не читает отчёт.
    // Не дождались — остаются сухие причины, и это честный исход.
    { maxTokens: 300, timeoutMs: 12_000 },
  );
  const checked = checkExplanation(raw, rec);

  if (checked.state !== 'accepted') {
    // Ни «не ответила», ни «ответила неправдой» не превращаются в текст:
    // человек остаётся с сухими причинами, которые верны по построению.
    return { ...base, text: null, state: checked.state, why: checked.why };
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, checked.text);
  return { ...base, text: checked.text, state: 'accepted', why: null };
}

/** Для тестов: память процесса не должна протекать между случаями. */
export function resetExplanationCache(): void {
  cache.clear();
}
