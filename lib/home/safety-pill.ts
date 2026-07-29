/**
 * lib/home/safety-pill.ts
 *
 * Состояние безопасности одной строкой для шапки главной.
 *
 * Дроби здесь нет намеренно. Макет предлагал «12 из 16 районов открыто», но
 * районного статуса в базе не существует: зон всего четыре
 * (avachinsky/western/eastern/northern), а `location_real_time_status` считается
 * по 763 точкам — знаменатель 763 читается как шум, а не как обстановка.
 * Показываем то, что знаем точно: спокойно, сколько предупреждений или опасность.
 *
 * Счётчик предупреждений приходит из выборки с `LIMIT 5` (fetchSafety), поэтому
 * пятёрка может означать «пять и больше». Пишем «5+», а не ровное «5»: цифра,
 * которая молча упирается в потолок, — это то же враньё, только аккуратное.
 */

export type SafetyTone = 'calm' | 'warning' | 'danger';

export interface SafetyPill {
  tone: SafetyTone;
  text: string;
}

/** Предупреждение / предупреждения / предупреждений. */
export function pluralWarnings(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'предупреждений';
  switch (n % 10) {
    case 1: return 'предупреждение';
    case 2:
    case 3:
    case 4: return 'предупреждения';
    default: return 'предупреждений';
  }
}

export interface SafetyPillInput {
  activeCount: number;
  maxSeverity: number;
  /** Сколько строк максимум могла вернуть выборка — при равенстве счётчик неполон. */
  limit?: number;
}

export function safetyPill({ activeCount, maxSeverity, limit = 5 }: SafetyPillInput): SafetyPill {
  if (activeCount <= 0) return { tone: 'calm', text: 'Сегодня: спокойно' };
  // severity 2+ — тот же порог, по которому уходит push-рассылка и краснеет
  // recommender_status. Одно правило на всю платформу, не отдельное для витрины.
  if (maxSeverity >= 2) return { tone: 'danger', text: 'Сегодня: опасность' };
  const capped = activeCount >= limit;
  const n = capped ? `${limit}+` : String(activeCount);
  return { tone: 'warning', text: `Сегодня: ${n} ${pluralWarnings(capped ? limit + 1 : activeCount)}` };
}
