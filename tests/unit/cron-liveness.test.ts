/**
 * Инварианты живости cron-агентов + целостность реестра. Ловит вранье:
 * непроверяемая джоба не должна быть зелёной; safety — строгий порог.
 */
import { describe, it, expect } from 'vitest';
import { computeLiveness, overallPosture, livenessThresholds, GITHUB_CRON_FLOOR_MIN } from '@/lib/agents/cron-liveness';
import { CRON_REGISTRY, TIER_ORDER } from '@/lib/agents/cron-registry';

const MIN = 60_000;
const now = Date.UTC(2026, 6, 23, 12, 0, 0);

describe('computeLiveness', () => {
  const watchdog = { everyMin: 30, tier: 'safety' as const, agentId: 'watchdog' };

  it('свежий запуск — жив', () => {
    expect(computeLiveness(watchdog, now - 5 * MIN, now).status).toBe('alive');
  });

  it('опоздал в пределах late-порога', () => {
    // safety: late = 30*1.5+10 = 55, dead = 30*2.5+10 = 85
    expect(computeLiveness(watchdog, now - 60 * MIN, now).status).toBe('late');
  });

  it('за порогом dead — мёртв', () => {
    expect(computeLiveness(watchdog, now - 120 * MIN, now).status).toBe('dead');
  });

  it('нет телеметрии → unknown, НЕ зелёный', () => {
    const r = computeLiveness({ everyMin: 30, tier: 'safety', agentId: null }, now - 1 * MIN, now);
    expect(r.status).toBe('unknown');
    expect(r.minutesSince).toBeNull();
  });

  it('инструментирован, но запусков нет → never', () => {
    expect(computeLiveness(watchdog, null, now).status).toBe('never');
  });

  it('safety строже, чем content при равном everyMin', () => {
    const safety = livenessThresholds({ everyMin: 60, tier: 'safety' });
    const content = livenessThresholds({ everyMin: 60, tier: 'content' });
    expect(safety.deadAfterMin).toBeLessThan(content.deadAfterMin);
  });

  it('minutesSince не отрицателен при часах в будущем', () => {
    expect(computeLiveness(watchdog, now + 5 * MIN, now).minutesSince).toBe(0);
  });

  it('крон только на GitHub не числится мёртвым из-за разрыва в 5 часов', () => {
    const github = { everyMin: 30, tier: 'ops' as const, agentId: 'seat-requests-expire', githubOnly: true };
    expect(GITHUB_CRON_FLOOR_MIN).toBe(360);
    expect(computeLiveness(github, now - 5 * 60 * MIN, now).status).toBe('alive');
    expect(computeLiveness(github, now - 13 * 60 * MIN, now).status).toBe('late');
    expect(computeLiveness(github, now - 25 * 60 * MIN, now).status).toBe('dead');
    expect(computeLiveness(watchdog, now - 60 * MIN, now).status).toBe('late');
  });
});

describe('overallPosture', () => {
  it('мёртвый safety → alarm', () => {
    expect(overallPosture([{ tier: 'safety', status: 'dead' }])).toBe('alarm');
  });
  it('safety без телеметрии не роняет в alarm (unknown ≠ dead)', () => {
    expect(overallPosture([{ tier: 'safety', status: 'unknown' }])).toBe('calm');
  });
  it('мёртвый не-safety → attention', () => {
    expect(overallPosture([{ tier: 'content', status: 'dead' }])).toBe('attention');
  });
  it('всё живо → calm', () => {
    expect(overallPosture([{ tier: 'safety', status: 'alive' }, { tier: 'ops', status: 'alive' }])).toBe('calm');
  });
});

describe('журналы кронов без телеметрии', () => {
  const NEWLY_JOURNALED = [
    'client-errors-census', 'booking-auto-complete', 'tour-review-request', 'ssr-sentinel',
    'kuzmich-bad-outcomes', 'evo-judge', 'evo-review', 'kb-gap', 'engagement', 'smart-notify',
    'enrich-routes', 'routes-cache', 'kuzmich-places', 'import-routes',
    'kuzmich-route', 'kuzmich-tip', 'kuzmich-tour',
  ];

  it('семнадцать записей пишут свой agentId', () => {
    for (const key of NEWLY_JOURNALED) {
      const entry = CRON_REGISTRY.find((e) => e.key === key);
      expect(entry?.agentId, key).toBe(key);
    }
  });

  it('порог GitHub только у трёх кронов без второй ноги', () => {
    expect(CRON_REGISTRY.filter((e) => e.githubOnly).map((e) => e.key).sort()).toEqual([
      'agent-request-notify',
      'seat-requests-expire',
      'volcano-merge-gate',
    ]);
  });
});

describe('реестр cron целостен', () => {
  it('ключи уникальны', () => {
    const keys = CRON_REGISTRY.map(e => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('everyMin положителен, разряд известен', () => {
    for (const e of CRON_REGISTRY) {
      expect(e.everyMin).toBeGreaterThan(0);
      expect(TIER_ORDER).toContain(e.tier);
    }
  });
  it('triggerable только у инструментированных', () => {
    for (const e of CRON_REGISTRY) {
      if (e.triggerable) expect(e.agentId).not.toBeNull();
    }
  });
});
