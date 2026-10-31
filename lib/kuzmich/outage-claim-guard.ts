/**
 * lib/kuzmich/outage-claim-guard.ts — выдуманный «сбой» вместо штатной заявки.
 *
 * Повод — снимок CTO 31.10: «Поскольку прямой доступ к базе сервиса временно
 * ограничен, заявки … передаются специалисту в ручном режиме». База работала;
 * мгновенного бронирования нет by design, заявку подтверждает человек.
 * Промпт это запрещает (KUZMICH_SYSTEM, «ЗАЯВКА — НЕ СБОЙ»), а сторож
 * детерминированно заменяет такое предложение честной строкой.
 *
 * Модуль чистый. Сторож: tests/unit/kuzmich-outage-claim-guard.test.ts.
 */

const OUTAGE_RE = /(доступ[а-яё]* к баз[а-яё]*[^.!?\n]{0,40}(ограничен|недоступ|закрыт)|баз[аеуы] (данных |сервиса )?(временно )?(недоступн|ограничен|не работает)|в ручном режиме|database (is )?(temporarily )?(unavailable|limited|down)|access to the database is (temporarily )?(limited|restricted)|handled manually)/iu;

export const OUTAGE_HONEST_LINE =
  'Заявка создана. Оператор свяжется с вами для подтверждения. Мгновенного бронирования нет — подтверждает человек.';

export interface OutageGuardResult { text: string; removed: string[] }

export function guardOutageClaims(answer: string): OutageGuardResult {
  if (!OUTAGE_RE.test(answer)) return { text: answer, removed: [] };
  const removed: string[] = [];
  const paragraphs = answer.split(/\n\s*\n/).map((para) => {
    const kept: string[] = [];
    let inserted = false;
    for (const s of para.split(/(?<=[.!?])\s+/).filter((x) => x.trim() !== '')) {
      if (!OUTAGE_RE.test(s)) { kept.push(s); continue; }
      removed.push(s);
      if (!inserted && !answer.includes(OUTAGE_HONEST_LINE)) { kept.push(OUTAGE_HONEST_LINE); inserted = true; }
    }
    return kept.join(' ');
  }).filter((p) => p.trim() !== '');
  return { text: paragraphs.join('\n\n'), removed };
}
