// @vitest-environment node
/**
 * «Тихо в крае» и «молчит конвейер» — разные ответы (04.09).
 *
 * Дайджест напечатал в разделе «Камчатка»: «Нет значимых сигналов за
 * сегодня». Раздел кормится не из RSS, а из нашей таблицы `external_alerts`,
 * значит строка означает: за 25 часов не записано ни одной тревоги. Для
 * Камчатки это неправдоподобно, и та же беда уже была видна с другой стороны
 * (#1485, 30.08: сейсмо-канал отставал на 250 минут).
 *
 * Но по самому дайджесту два состояния неразличимы. Перепись их различает
 * ПАРОЙ фактов: были ли тревоги И ходил ли тот, кто их пишет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/alerts-census/route.ts'), 'utf-8');

describe('приговор даёт пара фактов, а не одна пустота', () => {
  it('три исхода названы и различимы', () => {
    for (const verdict of ['flowing', 'quiet', 'stalled']) {
      expect(SRC, verdict).toMatch(new RegExp(`'${verdict}'`));
    }
  });

  it('отказ переписи — «не смог», а не «тихо»', () => {
    expect(SRC).toMatch(/verdict: 'unknown'/);
    expect(SRC).toMatch(/console\.error\('\[alerts-census\]/);
  });

  it('пустые сутки судятся вместе с неделей — одни сутки бывают пустыми честно', () => {
    expect(SRC).toMatch(/last_25h/);
    expect(SRC).toMatch(/last_7d/);
  });
});

describe('список наполняющих агентов — из реестра, не из головы', () => {
  it('берётся из CRON_REGISTRY по разряду safety', () => {
    // Первая редакция набрала список руками и назвала `seismic-monitor` и
    // `wildfire-firms` — таких agentId в реестре нет. Тогда «ингест не
    // отмечался» означало бы всего лишь «спрашивал не тех».
    expect(SRC).toMatch(/CRON_REGISTRY/);
    expect(SRC).toMatch(/tier === 'safety'/);
    expect(SRC).not.toMatch(/'seismic-monitor'/);
    expect(SRC).not.toMatch(/'wildfire-firms'/);
  });

  it('в реестре есть кому наполнять таблицу — иначе перепись бессмысленна', () => {
    const safety = CRON_REGISTRY.filter((e) => e.tier === 'safety' && e.agentId);
    expect(safety.length).toBeGreaterThan(0);
    expect(safety.map((e) => e.agentId)).toContain('safety-ingest');
  });

  it('имена наблюдаемых агентов уезжают в ответ — иначе «не отмечался» непроверяемо', () => {
    expect(SRC).toMatch(/ingest_agents_watched/);
  });
});

describe('роут объявлен', () => {
  it('перепись значится ручной и только читающей', () => {
    expect(MANUAL_ENDPOINTS['alerts-census']).toBeTruthy();
    expect(MANUAL_ENDPOINTS['alerts-census']!.writes).toBe(false);
  });

  it('секрет сверяется до любого запроса к БД', () => {
    const secretAt = SRC.indexOf('timingSafeCompare');
    const queryAt = SRC.indexOf('pool.query');
    expect(secretAt).toBeGreaterThan(0);
    expect(secretAt).toBeLessThan(queryAt);
  });
});
