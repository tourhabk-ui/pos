/**
 * Сторож: ранний выход дайджеста обязан называть судьбу AI-канала.
 *
 * ── Что случилось ─────────────────────────────────────────────────────────
 *
 * Пост в @ai_hub_money (40К подписчиков) живёт ВНУТРИ прогона дайджеста и
 * ПОСЛЕ всех восьми ворот публикации. Сработали ворота — функция вышла
 * раньше, и в канал не ушло ничего. Это поведение осознанное: непроверенный
 * выпуск лучше не публиковать нигде.
 *
 * Незамеченным осталось другое: ранние выходы не писали про канал НИЧЕГО.
 * Ни «ушло», ни «не ушло», ни почему. Метку `ai_digest_aborted` завели ещё
 * 17.08 вместе с объясняющим комментарием — и в ранние выходы не проставили.
 * Полтора месяца молчание канала не попадало в запись прогона вовсе, и
 * разбирать его приходилось догадками (владелец 29.08: «из-за него нет и
 * новостей в тг канале»).
 *
 * Пустое место в отчёте — это не «сведений нет», это «мы не сказали».
 *
 * ── Что здесь проверяется ─────────────────────────────────────────────────
 *
 * Каждый `return` из runScoutDigest, который НЕ дошёл до публикации в канал,
 * несёт `...AI_CHANNEL_ABORTED`. Проверка структурная (по исходнику), потому
 * что вызвать функцию целиком — это RSS четырёх источников, БД и две модели.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-digest';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf8');

/**
 * Возвраты из тела дайджеста, помеченные причиной пропуска. Именно они —
 * ранние выходы: успешный финал причины не имеет.
 */
function skippingReturns(): string[] {
  const out: string[] = [];
  // Возврат может быть в одну строку или в несколько — собираем от `return {`
  // до закрывающей `};` того же уровня вложенности (внутри нет вложенных
  // объектов, кроме спредов и тернарников — им фигурные скобки не нужны).
  const re = /return\s*\{[\s\S]*?\};/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC)) !== null) {
    if (m[0].includes('digest_skip_reason') || m[0].includes('digest_sent')) out.push(m[0]);
  }
  return out;
}

describe('ранний выход дайджеста называет судьбу AI-канала', () => {
  const returns = skippingReturns();

  it('такие возвраты вообще найдены — иначе сторож ничего не сторожит', () => {
    expect(returns.length).toBeGreaterThanOrEqual(6);
  });

  it('каждый возврат без публикации в канал несёт AI_CHANNEL_ABORTED', () => {
    const silent: string[] = [];
    for (const r of returns) {
      // Финальный возврат сам считает исход канала — у него есть aiSent/aiSkip.
      const isFinal = r.includes('ai_channel_sent: aiSent') || r.includes('aiSkip');
      if (isFinal) continue;
      if (!r.includes('AI_CHANNEL_ABORTED')) {
        silent.push(r.replace(/\s+/g, ' ').slice(0, 110));
      }
    }
    expect(
      silent,
      `возврат молчит про AI-канал (@ai_hub_money): ${silent.join(' || ')}`,
    ).toEqual([]);
  });

  it('константа проставляет и флаг, и причину — одного флага мало', () => {
    const decl = /const AI_CHANNEL_ABORTED = \{[\s\S]*?\} as const;/.exec(SRC)?.[0] ?? '';
    expect(decl).toContain('ai_channel_sent: false');
    expect(decl).toContain("ai_channel_skip_reason: 'ai_digest_aborted'");
  });

  it('причина названа словами, а не кодом', () => {
    expect(SKIP_REASON_LABELS.ai_digest_aborted).toBeTruthy();
    expect(SKIP_REASON_LABELS.ai_digest_aborted).not.toBe('ai_digest_aborted');
  });

  it('публикация в канал по-прежнему ПОСЛЕ ворот — это не регресс, а замысел', () => {
    // Если однажды пост в канал переедет ВЫШЕ фактчека, непроверенный текст
    // пойдёт сорока тысячам подписчиков. Порядок закреплён намеренно.
    const gate = SRC.indexOf("digest_skip_reason: 'unsourced_percents'");
    // Именно МЕСТО ЧТЕНИЯ переменной, а не её упоминание в словаре причин
    // наверху файла — иначе сторож меряет позицию комментария.
    const channel = SRC.indexOf('process.env.TELEGRAM_AI_CHANNEL_ID');
    expect(gate).toBeGreaterThan(0);
    expect(channel).toBeGreaterThan(0);
    expect(channel).toBeGreaterThan(gate);
  });
});
