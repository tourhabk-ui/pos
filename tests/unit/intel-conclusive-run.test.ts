/**
 * Разведка: «сходил и не нашёл» — это результат, а не поломка.
 *
 * ПОВОД (скриншот владельца 06.09). Watchdog каждые полчаса: «Крон идёт, но
 * результата нет — Intelligence Monitor — 3 прогонов подряд без результата,
 * успеха не было за всё окно, чаще всего: no_signals».
 *
 * Прогон на проде (prod-check run 21) сказал другое:
 *
 *   raw_signals: 72, findings: 0,
 *   outcomes: { nothing_relevant: 1, no_signals: 2, gather_failed: 0 },
 *   empty_reasons: [
 *     "competitors: 1 из 2 лент ответили и пусты, 1 отказали: visitkamchatka.ru: HTTP 200, 136 КБ, HTML вместо ленты",
 *     "travel_industry: 1 из 5 лент ответили и пусты, 4 отказали: ..." ]
 *
 * То есть 72 сигнала собраны, модель честно ответила «ничего применимого» —
 * ровно то, что промпт и просит, — а статус прогона считался по числу
 * находок, и законная тишина выглядела поломкой. Тревога, которую нельзя
 * погасить работой, приучает пролистывать: этот урок уже стоил вечного
 * push_undelivered.
 *
 * При этом НАСТОЯЩАЯ беда в том же ответе была: две ленты отдают HTML вместо
 * RSS, четыре отказали — и алерт называл их числом, а не именами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeEmptyGather } from '@/lib/agents/intel-gather-census';
import { findFruitlessCrons, formatFruitlessCrons } from '@/lib/agents/cron-fruitless';
import type { CronEntry } from '@/lib/agents/cron-registry';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/--.*$/gm, '');

describe('прогон, доведённый до конца, считается успехом', () => {
  const SERVICE = strip(read('lib/services/intelligence-monitor.service.ts'));
  const ROUTE = strip(read('app/api/cron/intelligence/route.ts'));

  it('правило одно и живёт в сервисе', () => {
    expect(SERVICE).toMatch(/const conclusive = outcomes\.gather_failed === 0/);
    expect(SERVICE).toMatch(/outcomes\.no_signals === 0/);
    expect(SERVICE).toMatch(/outcomes\.model_mute === 0/);
    expect(SERVICE).toMatch(/outcomes\.model_malformed === 0/);
  });

  it('статус прогона берётся из него, а не из числа находок', () => {
    expect(ROUTE).toMatch(/status: report\.conclusive \? 'success' : 'partial'/);
    expect(ROUTE).not.toMatch(/report\.domains\.length > 0 \? 'success'/);
  });

  it('мёртвая лента вердиктом не считается — о ней молчать нельзя', () => {
    // no_signals в списке условий: домен с HTML вместо RSS не должен
    // проходить как «сходил и ничего не нашёл».
    const rule = SERVICE.slice(SERVICE.indexOf('const conclusive'), SERVICE.indexOf('const skipReason'));
    expect(rule).toContain('no_signals === 0');
  });
});

describe('алерт называет ленту, а не только класс беды', () => {
  const entry: CronEntry = {
    key: 'intelligence', label: 'Intelligence Monitor',
    description: '', workflow: 'x.yml', cron: '0 6 * * *', schedule: '',
    everyMin: 1440, tier: 'content', agentId: 'intelligence', triggerable: false,
  } as CronEntry;

  const runs = [
    { agent_id: 'intelligence', status: 'partial', ended_at: '2026-09-06T05:00:00Z',
      skip_reason: 'no_signals',
      detail: 'travel_industry: 1 из 5 лент ответили и пусты, 4 отказали: rustravelforum.com: HTTP 200, HTML вместо ленты' },
    { agent_id: 'intelligence', status: 'partial', ended_at: '2026-09-06T04:00:00Z', skip_reason: 'no_signals', detail: null },
    { agent_id: 'intelligence', status: 'partial', ended_at: '2026-09-06T03:00:00Z', skip_reason: 'no_signals', detail: null },
  ];

  it('подробность из свежего прогона попадает в строку тревоги', () => {
    const list = findFruitlessCrons([entry], runs, Date.parse('2026-09-06T06:00:00Z'));
    expect(list).toHaveLength(1);
    expect(list[0].detail).toContain('rustravelforum.com');
    expect(formatFruitlessCrons(list)).toContain('rustravelforum.com');
  });

  it('подробности нет — строка прежняя, без выдуманных скобок', () => {
    const bare = runs.map((r) => ({ ...r, detail: null }));
    const list = findFruitlessCrons([entry], bare, Date.parse('2026-09-06T06:00:00Z'));
    expect(list[0].detail).toBeNull();
    expect(formatFruitlessCrons(list)).not.toContain('()');
  });

  it('Watchdog берёт подробность из прогона, а не сочиняет', () => {
    expect(strip(read('lib/agents/watchdog.ts'))).toMatch(/metadata->'empty_reasons'->>0.*AS detail/);
  });
});

describe('отказавшие ленты названы поимённо', () => {
  it('в причине стоят имена, а не только счёт', () => {
    const verdict = judgeEmptyGather({
      attempted: 5,
      answered: 1,
      failed: 4,
      failures: ['rata-news.ru: HTTP 404', 'ator.ru: таймаут', 'atorus.ru: HTTP 403', 'tourprom.ru: сеть'],
      empties: ['rustravelforum.com: HTTP 200, 184 КБ, HTML вместо ленты'],
    });
    expect(verdict.outcome).toBe('no_signals');
    expect(verdict.reason).toContain('rata-news.ru: HTTP 404');
    expect(verdict.reason).toContain('4 отказали');
    // Показываем три и честно говорим, что есть ещё.
    expect(verdict.reason).toContain('и ещё 1');
    expect(verdict.reason).toContain('rustravelforum.com');
  });

  it('ни одна не ответила — по-прежнему gather_failed, а не «новостей нет»', () => {
    const verdict = judgeEmptyGather({
      attempted: 3, answered: 0, failed: 3,
      failures: ['a: HTTP 500', 'b: таймаут', 'c: сеть'],
    });
    expect(verdict.outcome).toBe('gather_failed');
  });
});
