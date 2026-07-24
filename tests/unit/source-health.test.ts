import { describe, it, expect } from 'vitest';
import {
  evaluateDeadSources,
  dueForAlert,
  formatDeadSourceAlert,
  type SourceExpectation,
  type SourceHealthRow,
} from '@/lib/services/safety/source-health';

const NOW = Date.parse('2026-07-24T12:00:00Z');
const H = 3_600_000;

const EXP: SourceExpectation[] = [
  { key: 'vk_mchs', label: 'VK', requiresEnv: 'VK_SERVICE_TOKEN', maxSilenceHours: 72 },
  { key: 'max_mchs', label: 'MAX', maxSilenceHours: 72 },
  { key: 'mchs_rss', label: 'МЧС RSS', maxSilenceHours: 96 },
];

function row(p: Partial<SourceHealthRow> & { source_key: string }): SourceHealthRow {
  return {
    label: null, last_status: null, last_run_at: null, last_nonempty_at: null,
    last_alerted_at: null, first_seen_at: null, raw_items: 0, inserted: 0, ...p,
  };
}

describe('evaluateDeadSources', () => {
  it('источник без строки → НЕ мёртв (период привыкания, ещё не наблюдался)', () => {
    expect(evaluateDeadSources([], EXP, NOW)).toHaveLength(0);
  });

  it('not_configured ловится сразу (VK без токена), без привыкания', () => {
    const rows = [
      row({ source_key: 'vk_mchs', last_status: 'not_configured', first_seen_at: new Date(NOW).toISOString() }),
      row({ source_key: 'max_mchs', last_status: 'ok', last_nonempty_at: new Date(NOW - 1 * H).toISOString() }),
      row({ source_key: 'mchs_rss', last_status: 'ok', last_nonempty_at: new Date(NOW - 1 * H).toISOString() }),
    ];
    const dead = evaluateDeadSources(rows, EXP, NOW);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ key: 'vk_mchs', reason: 'not_configured' });
  });

  it('свежий источник (в пределах порога) — не мёртв', () => {
    const rows = EXP.map((e) =>
      row({ source_key: e.key, last_status: 'ok', last_nonempty_at: new Date(NOW - 2 * H).toISOString() }),
    );
    expect(evaluateDeadSources(rows, EXP, NOW)).toHaveLength(0);
  });

  it('молчит дольше порога → silent с числом часов', () => {
    const rows = [
      row({ source_key: 'vk_mchs', last_status: 'empty', last_nonempty_at: new Date(NOW - 100 * H).toISOString(), first_seen_at: new Date(NOW - 200 * H).toISOString() }),
      row({ source_key: 'max_mchs', last_status: 'ok', last_nonempty_at: new Date(NOW - 1 * H).toISOString() }),
      row({ source_key: 'mchs_rss', last_status: 'ok', last_nonempty_at: new Date(NOW - 1 * H).toISOString() }),
    ];
    const dead = evaluateDeadSources(rows, EXP, NOW);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ key: 'vk_mchs', reason: 'silent', silentHours: 100 });
  });

  it('«ни разу не дал данных», но наблюдаем недолго (в привыкании) → НЕ мёртв', () => {
    const rows = [
      row({ source_key: 'vk_mchs', last_status: 'ok', last_nonempty_at: new Date(NOW - 1 * H).toISOString() }),
      // max: наблюдаем всего 2 ч (порог 72 ч) — рано судить
      row({ source_key: 'max_mchs', last_status: 'empty', last_nonempty_at: null, first_seen_at: new Date(NOW - 2 * H).toISOString() }),
      row({ source_key: 'mchs_rss', last_status: 'ok', last_nonempty_at: new Date(NOW - 1 * H).toISOString() }),
    ];
    expect(evaluateDeadSources(rows, EXP, NOW)).toHaveLength(0);
  });

  it('«ни разу не дал данных» и наблюдаем дольше порога → never', () => {
    const rows = [
      row({ source_key: 'vk_mchs', last_status: 'ok', last_nonempty_at: new Date(NOW - 1 * H).toISOString() }),
      // max: наблюдаем 100 ч (> 72 ч), сырых данных не было ни разу — реально мёртв
      row({ source_key: 'max_mchs', last_status: 'empty', last_nonempty_at: null, first_seen_at: new Date(NOW - 100 * H).toISOString() }),
      row({ source_key: 'mchs_rss', last_status: 'ok', last_nonempty_at: new Date(NOW - 1 * H).toISOString() }),
    ];
    const dead = evaluateDeadSources(rows, EXP, NOW);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ key: 'max_mchs', reason: 'never' });
  });
});

describe('dueForAlert — дебаунс', () => {
  const dead = [{ key: 'vk_mchs', label: 'VK', reason: 'not_configured' as const, silentHours: null }];

  it('не алертили → пора', () => {
    const rows = [row({ source_key: 'vk_mchs', last_alerted_at: null })];
    expect(dueForAlert(dead, rows, NOW, 12)).toHaveLength(1);
  });

  it('алертили недавно → ждём', () => {
    const rows = [row({ source_key: 'vk_mchs', last_alerted_at: new Date(NOW - 2 * H).toISOString() })];
    expect(dueForAlert(dead, rows, NOW, 12)).toHaveLength(0);
  });

  it('алертили давно → снова пора', () => {
    const rows = [row({ source_key: 'vk_mchs', last_alerted_at: new Date(NOW - 20 * H).toISOString() })];
    expect(dueForAlert(dead, rows, NOW, 12)).toHaveLength(1);
  });
});

describe('formatDeadSourceAlert', () => {
  it('человекочитаемый текст по каждой причине', () => {
    const msg = formatDeadSourceAlert([
      { key: 'vk_mchs', label: 'VK', reason: 'not_configured', silentHours: null },
      { key: 'max_mchs', label: 'MAX', reason: 'silent', silentHours: 80 },
      { key: 'mchs_rss', label: 'МЧС RSS', reason: 'never', silentHours: null },
    ]);
    expect(msg).toContain('VK: не настроен');
    expect(msg).toContain('MAX: молчит 80 ч');
    expect(msg).toContain('МЧС RSS: ни разу');
  });
});
