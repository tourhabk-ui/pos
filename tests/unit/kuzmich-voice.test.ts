/**
 * Голос Кузьмича в канале — один на все промпты, обвес режется числом.
 *
 * 21.08 владелец сравнил первые посты канала с «нынешними»: первый — живой
 * персонаж от первого лица без единого хэштега; нынешний — SMM-шаблон
 * («Зимний телепорт», буллеты «почему круто», 17 хэштегов, «мы с
 * Кузьмичом» — автор выпал из персонажа, эмодзи в каждом абзаце).
 *
 * Принципы голоса живут ОДНОЙ константой и подмешиваются во все канальные
 * промпты — пять разных формулировок в пяти промптах уже разъехались.
 * Хэштег-простыня и эмодзи-обвес — детерминированный guard в канале
 * публикации: промпт не гвард (§8), 12.07 и 19.08 это уже доказывали.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockingTextIssue } from '@/lib/notifications/post-validation';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('голос — одна константа на все промпты Кузьмича', () => {
  it('каждый канальный промпт Кузьмича несёт KUZMICH_CHANNEL_VOICE', () => {
    // По строкам, а не одним регэкспом до бэктика: внутри промптов живут
    // вложенные template-литералы, и `[^`]*` обрывался бы на них.
    const lines = read('lib/notifications/telegram-channel.ts').split('\n');
    const bad: number[] = [];
    lines.forEach((line, i) => {
      if (!/Ты — Кузьмич/.test(line)) return;
      const window = lines.slice(i, i + 40).join('\n');
      if (!window.includes('KUZMICH_CHANNEL_VOICE')) bad.push(i + 1);
    });
    const total = lines.filter(l => /Ты — Кузьмич/.test(l)).length;
    expect(total, 'промпты Кузьмича не найдены — сторож ослеп').toBeGreaterThanOrEqual(4);
    expect(bad, 'промпт без общего голоса заведёт свой диалект (строки)').toEqual([]);
  });

  it('ни один промпт не требует эмодзи', () => {
    const src = read('lib/notifications/telegram-channel.ts');
    expect(src).not.toMatch(/начни с эмодзи/i);
  });
});

describe('SMM-обвес режется детерминированно', () => {
  const kuzmich = 'Эй, курортники! Дикие Озерки — те самые дикие ванны в 4 км от Кеткино. ' +
    'Сероводородом пахнет как после шашлыка, вода горячая, метан пузырится — зажигалку не подносить.';

  it('живой пост с парой эмодзи проходит', () => {
    expect(blockingTextIssue(`${kuzmich} Кто был — пишите. \u{1F525}\u{1F6C1}`)).toBeNull();
  });

  it('хэштег-простыня блокируется', () => {
    const tags = '#камчатка #елизово #термалка #эмжо #поход #снег #wildkamchatka #kamchatka';
    expect(blockingTextIssue(`${kuzmich} ${tags}`)).toContain('хэштег');
  });

  it('эмодзи-обвес блокируется', () => {
    const issue = blockingTextIssue(`\u{2744}\u{1F6C1} ${kuzmich} \u{1F525}\u{1F60E}\u{1F43B}\u{2728}`);
    expect(issue).toContain('эмодзи');
  });

  it('дайджест с тремя-четырьмя тегами не задет', () => {
    expect(blockingTextIssue(`${kuzmich} #AI #LLM #DeepSeek`)).toBeNull();
  });
});
