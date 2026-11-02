/**
 * Страж норм мессенджера: штатные реплики Кузьмича в MAX/Telegram — до ~100
 * слов связного текста и не больше одного вопроса. Списки и ссылки не в счёт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { messengerNormIssues, proseWords, questionCount } from '@/lib/kuzmich/channel-norms';
import { CANCEL_IDLE_REPLY, STALE_CONFIRM_REPLY, statusReplyText } from '@/lib/kuzmich/code-first';
import { KUZMICH_SYSTEM, BOOKING_CONSENT_LINE } from '@/lib/kuzmich/core';

const FILES = ['lib/kuzmich/core.ts', 'app/api/max/kuzmich/route.ts', 'app/api/telegram/kuzmich/route.ts', 'lib/kuzmich/code-first.ts'];

function replyLiterals(src: string): string[] {
  const out: string[] = [];
  const rx = /reply(?:Fn)?\(\s*chatId,\s*(?:'((?:[^'\\]|\\.)*)'|`([^`$]*)`)/g;
  for (const m of src.matchAll(rx)) out.push((m[1] ?? m[2]).replace(/\\n/g, '\n'));
  const join = /reply(?:Fn)?\(\s*chatId,\s*\[([\s\S]*?)\]\.join\('\\n'\)/g;
  for (const m of src.matchAll(join)) {
    const parts = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
    out.push(parts.join('\n'));
  }
  return out;
}

describe('нормы мессенджера', () => {
  it('счёт: списки и ссылки не входят', () => {
    const list = ['Выберите тур:', ...Array.from({ length: 40 }, (_, i) => `- Тур номер ${i} на вулкан с гидом`)].join('\n');
    expect(proseWords(list)).toBe(2);
    expect(questionCount('Как вас зовут? Сколько человек?')).toBe(2);
  });
  it('промпт Кузьмича называет лимит и один вопрос', () => {
    expect(KUZMICH_SYSTEM).toMatch(/до ~100 слов/);
    expect(KUZMICH_SYSTEM).toMatch(/ОДНОГО вопроса/);
  });
  it('штатные реплики кода укладываются', () => {
    const texts = [CANCEL_IDLE_REPLY, STALE_CONFIRM_REPLY, BOOKING_CONSENT_LINE,
      statusReplyText({ tour: 'Авача', accommodation: null, date: '2026-07-15', human: 'Ждёт ответа оператора.', next: 'Оператор свяжется.', page: 'https://vedarai.ru/request-status#k' })];
    for (const f of FILES) texts.push(...replyLiterals(readFileSync(f, 'utf8')));
    expect(texts.length).toBeGreaterThan(15);
    const bad = texts.map((t) => [t.slice(0, 60), messengerNormIssues(t)] as const).filter(([, i]) => i.length);
    expect(bad).toEqual([]);
  });
});
