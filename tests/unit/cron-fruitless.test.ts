/**
 * Сторож бесплодных прогонов: крон идёт и не доводит дело до конца.
 *
 * Случай, ради которого написан: разведчик молчал двадцать два дня при
 * зелёном кроне. Каждое утро запуск был, свежие материалы находились
 * (`items_processed` больше нуля — для сторожа холостых это «работа сделана»),
 * а выпуск не уходил: фактчек-судья не мог ответить, потому что молчали
 * провайдеры. Статус таких прогонов `partial`, а сторож падающих смотрит
 * только `failed`. Двадцать два прогона подряд не подняли ни одной тревоги.
 */
import { describe, it, expect } from 'vitest';
import {
  findFruitlessCrons, formatFruitlessCrons, FRUITLESS_RUNS_THRESHOLD,
  type CronOutcomeRow,
} from '@/lib/agents/cron-fruitless';
import type { CronEntry } from '@/lib/agents/cron-registry';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-23T09:00:00Z');

function entry(key: string, agentId: string | null, tier: CronEntry['tier'] = 'growth'): CronEntry {
  return {
    key, label: key, description: '', workflow: `${key}.yml`, cron: '0 7 * * *',
    schedule: 'ежедневно', everyMin: 1440, tier, agentId, triggerable: false,
  };
}

/** n прогонов подряд, свежайший — сегодня, по одному в сутки. */
function runs(agent: string, statuses: string[], reason?: string): CronOutcomeRow[] {
  return statuses.map((status, i) => ({
    agent_id: agent,
    status,
    ended_at: new Date(NOW - i * DAY).toISOString(),
    skip_reason: status === 'success' ? null : (reason ?? null),
  }));
}

describe('findFruitlessCrons: щель между «сделал работу» и «довёл до конца»', () => {
  const registry = [entry('scout-digest', 'scout-digest')];

  it('двадцать два partial подряд — тревога с причиной и сроком', () => {
    const history = [
      ...runs('scout-digest', Array(22).fill('partial'), 'judge_unavailable'),
      // Последний настоящий выпуск — 22 дня назад.
      { agent_id: 'scout-digest', status: 'success', ended_at: new Date(NOW - 22 * DAY).toISOString(), skip_reason: null },
    ];
    const found = findFruitlessCrons(registry, history, NOW);
    expect(found).toHaveLength(1);
    expect(found[0].runs).toBe(22);
    expect(found[0].daysSinceSuccess).toBe(22);
    expect(found[0].dominantReason).toBe('judge_unavailable');
    expect(formatFruitlessCrons(found)).toContain('judge_unavailable');
    expect(formatFruitlessCrons(found)).toContain('22');
  });

  it('успех в серии обнуляет её — молчания нет', () => {
    const history = runs('scout-digest', ['partial', 'success', 'partial', 'partial', 'partial']);
    expect(findFruitlessCrons(registry, history, NOW)).toEqual([]);
  });

  it(`меньше ${FRUITLESS_RUNS_THRESHOLD} подряд — не тревога: пустой день бывает законно`, () => {
    const history = runs('scout-digest', ['partial', 'partial', 'success', 'success']);
    expect(findFruitlessCrons(registry, history, NOW)).toEqual([]);
  });

  it('серия из одних failed отдана сторожу падающих — тревогу не дублируем', () => {
    // У «упало» другой адрес разбора и другая формулировка; две тревоги об
    // одном приучают пролистывать обе.
    const history = runs('scout-digest', ['failed', 'failed', 'failed', 'failed']);
    expect(findFruitlessCrons(registry, history, NOW)).toEqual([]);
  });

  it('смешанная серия partial и failed — тревога наша', () => {
    const history = runs('scout-digest', ['partial', 'failed', 'partial', 'partial'], 'judge_unavailable');
    const found = findFruitlessCrons(registry, history, NOW);
    expect(found).toHaveLength(1);
    expect(found[0].runs).toBe(4);
  });

  it('короткая история — предмет liveness, не этой проверки', () => {
    expect(findFruitlessCrons(registry, runs('scout-digest', ['partial', 'partial']), NOW)).toEqual([]);
  });

  it('крон без телеметрии пропускается: судить не по чему', () => {
    const found = findFruitlessCrons([entry('no-telemetry', null)], runs('no-telemetry', Array(9).fill('partial')), NOW);
    expect(found).toEqual([]);
  });

  it('успеха не было вовсе — так и говорим, а не выдумываем срок', () => {
    const found = findFruitlessCrons(registry, runs('scout-digest', Array(5).fill('partial')), NOW);
    expect(found[0].daysSinceSuccess).toBeNull();
    expect(formatFruitlessCrons(found)).toContain('успеха не было');
  });

  it('причина не записана — не выдумывается', () => {
    const found = findFruitlessCrons(registry, runs('scout-digest', Array(5).fill('partial')), NOW);
    expect(found[0].dominantReason).toBeNull();
    expect(formatFruitlessCrons(found)).toContain('причина пропуска не записана');
  });

  it('преобладающая причина — самая частая, а не самая свежая', () => {
    const history: CronOutcomeRow[] = [
      { agent_id: 'scout-digest', status: 'partial', ended_at: new Date(NOW).toISOString(), skip_reason: 'near_repeat' },
      { agent_id: 'scout-digest', status: 'partial', ended_at: new Date(NOW - DAY).toISOString(), skip_reason: 'judge_unavailable' },
      { agent_id: 'scout-digest', status: 'partial', ended_at: new Date(NOW - 2 * DAY).toISOString(), skip_reason: 'judge_unavailable' },
      { agent_id: 'scout-digest', status: 'partial', ended_at: new Date(NOW - 3 * DAY).toISOString(), skip_reason: 'judge_unavailable' },
    ];
    expect(findFruitlessCrons(registry, history, NOW)[0].dominantReason).toBe('judge_unavailable');
  });

  it('safety-крон делает тревогу критической', () => {
    const found = findFruitlessCrons(
      [entry('safety-thing', 'safety-thing', 'safety')],
      runs('safety-thing', Array(5).fill('partial')),
      NOW,
    );
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('safety-thing');
  });
});
