/**
 * Живость сейсмо-реле стало видно (17.09).
 *
 * С 03.09 t.me-каналы приносит воркер Cloudflare infra/safety-relay каждые
 * 5 минут; раннер GitHub — запасной путь на 5-6 доставок в сутки. Оба шлют с
 * одной меткой workflow_post, а порог checkSeismicWorkflowDelay — сутки:
 * он молчит и при живом реле, и при мёртвом. Реле было объявлено (выкатка,
 * маркер, /selftest), а сторожа не имело — «объявленный исход без
 * источника» на самом дорогом направлении. Проба 514 (17.09):
 * telegram_seismic_age_min = 1 при раннере два часа назад — реле живо; эта
 * проверка держит, чтобы это оставалось замером, а не памятью.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  seismicRelayIssue,
  SEISMIC_RELAY_MIN_POSTS_PER_HOUR,
  SEISMIC_RELAY_MIN_OBSERVED_MIN,
} from '@/lib/agents/watchdog';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf-8');

describe('seismicRelayIssue — уровень по цене ошибки', () => {
  it('реле живо (~12 POST/час) — молчим', () => {
    expect(seismicRelayIssue(12, 10_000)).toBeNull();
    expect(seismicRelayIssue(SEISMIC_RELAY_MIN_POSTS_PER_HOUR, 10_000)).toBeNull();
  });

  it('только раннер (0-1 POST/час) — WARN, не КРИТ: данные идут, но часами', () => {
    for (const n of [0, 1, 2]) {
      const a = seismicRelayIssue(n, 10_000);
      expect(a, `${n} POST/час`).not.toBeNull();
      expect(a?.critical).toBe(false);
      expect(a?.count).toBe(n);
      expect(a?.details).toMatch(/реле/i);
      expect(a?.details).toMatch(/USGS/);
    }
  });

  it('первые два часа после выката журнал пуст — не судим', () => {
    expect(seismicRelayIssue(0, SEISMIC_RELAY_MIN_OBSERVED_MIN - 1)).toBeNull();
  });

  it('порог с запасом: норма 12, порог 3 — дрожание крона Cloudflare не будит', () => {
    expect(SEISMIC_RELAY_MIN_POSTS_PER_HOUR).toBeLessThanOrEqual(4);
    expect(SEISMIC_RELAY_MIN_POSTS_PER_HOUR).toBeGreaterThanOrEqual(2);
  });
});

describe('checkSeismicRelayAlive — форма', () => {
  it('считает именно POST-доставки за последний час', () => {
    expect(SRC).toMatch(/metadata->>'trigger' = 'workflow_post'\s*\n\s*AND ended_at > NOW\(\) - INTERVAL '60 minutes'/);
  });

  it('отказ проверки не глушится', () => {
    const body = SRC.slice(SRC.indexOf('async function checkSeismicRelayAlive'), SRC.indexOf('async function checkDeadSafetyCrons'));
    expect(body).toMatch(/console\.error\('\[watchdog\] checkSeismicRelayAlive:/);
    expect(body).toMatch(/checkFailure\('checkSeismicRelayAlive'/);
  });

  it('шапка соседней проверки больше не называет GitHub единственным носителем', () => {
    // До 17.09 комментарий утверждал «их приносит GitHub Actions» — с 03.09 это
    // неправда, и читающий верил описанию.
    const header = SRC.slice(SRC.indexOf('── Задержка сейсмо-канала из Telegram'), SRC.indexOf('export const SEISMIC_WORKFLOW_WARN_MIN'));
    expect(header).toMatch(/Cloudflare/);
    expect(header).toMatch(/checkSeismicRelayAlive/);
  });
});
