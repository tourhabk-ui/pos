/**
 * Оценка риска места для «Анализатора безопасности» (/tools/safety) — с
 * исходом «не оценён» (15.10, §0 «честность»).
 *
 * До 15.10 оценка начиналась с единицы. Место, о котором платформа не знает
 * ничего — опасности, выведенные шаблоном 070 из типа места, сняты с показа
 * (lib/safety/profile-source.ts), сложности нет, предупреждений нет, —
 * получало «1/5 · Низкий риск» зелёным. Незнание выглядело хорошей новостью.
 * Туда же попадала записанная опасность вне короткого списка: термальное поле
 * давало тот же «низкий риск».
 *
 * Правило:
 *   ничего не записано и предупреждений нет → null («не оценён»);
 *   записана любая опасность                → не ниже 2;
 *   газ, лавины или сложность 4–5           → не ниже 3;
 *   предупреждение уровня N (шкала 0–3)     → не ниже N + 1.
 */

const SEVERE_HAZARDS = ['volcanic_gas', 'avalanche'];

export function placeRiskScore(
  hazards: string[],
  alertSeverity: number | null,
  difficultyLevel: number | null,
): number | null {
  const severity = alertSeverity != null && alertSeverity > 0 ? alertSeverity : 0;
  if (hazards.length === 0 && difficultyLevel == null && severity === 0) return null;
  let score = 1;
  if (severity > 0) score = Math.max(score, Math.min(5, severity + 1));
  if (hazards.length > 0) score = Math.max(score, 2);
  if (hazards.some((h) => SEVERE_HAZARDS.includes(h))) score = Math.max(score, 3);
  if (difficultyLevel != null && difficultyLevel >= 4) score = Math.max(score, 3);
  return score;
}
