/**
 * Сторож: пустой улов разведки не выдаётся за живые, но пустые источники.
 *
 * ── Что случилось 30.08 ───────────────────────────────────────────────────
 *
 * Watchdog третьи сутки писал: «Intelligence Monitor — 4 прогонов подряд без
 * результата, чаще всего: no_signals». А `no_signals` в словаре исходов
 * объявлен как «источники ответили, но пусто» — утверждение О ФАКТЕ:
 * источники живы, новостей нет.
 *
 * Код это подтвердить не мог. Исход `gather_failed` существовал, но был
 * НЕДОСТИЖИМ: он выставлялся только при отклонённом промисе домена, а
 * `gatherDomain` не отклонялся никогда — каждый отказ ленты проглатывал
 * собственный `.catch`, а поисковики отвечали пустым списком и на
 * отсутствие ключа, и на отказ сети.
 *
 * Три разные реальности приходили владельцу одним словом — и это слово
 * называло самую безобидную из трёх.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { judgeEmptyGather } from '@/lib/agents/intel-gather-census';

describe('пустота: факт о сети или факт о новостях', () => {
  it('ни одна лента не ответила — это отказ сбора, а не отсутствие новостей', () => {
    const v = judgeEmptyGather({
      attempted: 4, answered: 0, failed: 4,
      failures: ['openai.com: fetch failed', 'anthropic.com: 403'],
    });
    expect(v.outcome).toBe('gather_failed');
    expect(v.reason).toContain('ни одна из 4');
    expect(v.reason, 'причина без имён лент — чинить будут «разведку вообще»')
      .toContain('openai.com');
  });

  it('ленты ответили и пусты — вот теперь это правда о содержимом', () => {
    const v = judgeEmptyGather({ attempted: 3, answered: 3, failed: 0, failures: [] });
    expect(v.outcome).toBe('no_signals');
    expect(v.reason).toContain('3 из 3');
  });

  it('часть ответила, часть отказала — говорим и о неполноте', () => {
    // Молчать об отказах значит выдать частичную картину за полную.
    const v = judgeEmptyGather({ attempted: 5, answered: 2, failed: 3, failures: ['a: x'] });
    expect(v.outcome).toBe('no_signals');
    expect(v.reason).toContain('3 отказали');
  });

  it('лент не настроено вовсе — «мы не смотрели», а не «новостей нет»', () => {
    const v = judgeEmptyGather({ attempted: 0, answered: 0, failed: 0, failures: [] });
    expect(v.outcome).toBe('gather_failed');
    expect(v.reason).toMatch(/не настроено/);
  });

  it('длинный список отказов режется, но число названо', () => {
    const failures = ['a: 1', 'b: 2', 'c: 3', 'd: 4', 'e: 5'];
    const v = judgeEmptyGather({ attempted: 5, answered: 0, failed: 5, failures });
    expect(v.reason).toContain('и ещё 2');
  });

  it('«ответили» никогда не говорится там, где никто не ответил', () => {
    // Ровно то утверждение, которого код не мог подтвердить три дня.
    for (const failed of [1, 4, 40]) {
      const v = judgeEmptyGather({ attempted: failed, answered: 0, failed, failures: [] });
      expect(v.outcome).toBe('gather_failed');
    }
  });
});

describe('разведка судит переписью, а не догадкой', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/services/intelligence-monitor.service.ts'), 'utf-8');
  const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('пустой улов больше не объявляется no_signals напрямую', () => {
    expect(CODE, 'вернулся безусловный no_signals при пустом улове')
      .not.toMatch(/signals\.length === 0\)\s*return \{ outcome: 'no_signals' \}/);
    expect(CODE).toMatch(/judgeEmptyGather\(/);
  });

  it('отказ ленты доходит наверх, а не тонет в пустом списке', () => {
    // Прежде `.catch` возвращал `[] as RawSignal[]`, и отказ становился
    // неотличим от живой пустой ленты.
    expect(CODE).toMatch(/census\.failed\+\+/);
    expect(CODE).toMatch(/census\.answered\+\+/);
  });

  it('причина пустоты уезжает в результат прогона', () => {
    expect(CODE).toMatch(/empty_reasons/);
  });

  it('отказ сбора не глушится — остаётся след в логе', () => {
    expect(CODE).toMatch(/console\.error\(`\[intelligence\] домен/);
  });
});
