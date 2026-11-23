/**
 * Сторож самого тормоза точности эволюции (24.08).
 *
 * До этого дня поле `precision`/`guesses_allowed` уже уходило наружу из
 * `GET /api/cron/evo-report`, но систематически его никто не читал — раннер
 * (`scripts/evo-report-issues.js`) только печатал строку в лог джобы, а job
 * оставался зелёным независимо от того, сколько прогонов подряд тормоз
 * держал `allowGuesses=false`. Крен знаменателя точности от массовой уборки
 * очереди (миграция 912, PR #1373) держал публикацию заморожённой несколько
 * прогонов незамеченной — обнаружили не автоматикой, а человеком, читающим
 * код руками.
 *
 * Механизм не мониторил собственное здоровье, только своё следствие
 * («0 находок», неотличимое от «код чист»). Сторож здесь — тот же приём,
 * что `IDLE_RUNS_THRESHOLD` (lib/agents/cron-idle.ts): не один просевший
 * прогон, а серия.
 *
 * С 23.11 серия не красит job. 39 из 40 прогонов evo-report с 18.10
 * краснели уже после того, как рука завела issue. Настоящий сбой выноса
 * в этом шуме не виден. Предупреждение остаётся, вынос того, что тормоз
 * пускает, идёт дальше. Порог 50% не снижен.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextPublishGateStreak, PUBLISH_GATE_STREAK_THRESHOLD } from '@/lib/agents/evo/precision';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const REPORT_ROUTE = read('app/api/cron/evo-report/route.ts');
const RUNNER = read('scripts/evo-report-issues.js');

describe('nextPublishGateStreak: чистая арифметика стрика', () => {
  it('allowGuesses=true — стрик сбрасывается в ноль, сколько бы ни накопилось', () => {
    expect(nextPublishGateStreak(true, 0)).toBe(0);
    expect(nextPublishGateStreak(true, 7)).toBe(0);
  });

  it('allowGuesses=false — стрик растёт на единицу от прошлого значения', () => {
    expect(nextPublishGateStreak(false, 0)).toBe(1);
    expect(nextPublishGateStreak(false, 1)).toBe(2);
    expect(nextPublishGateStreak(false, 2)).toBe(3);
  });

  it('порог — тот же приём, что у IDLE_RUNS_THRESHOLD: три, не один', () => {
    expect(PUBLISH_GATE_STREAK_THRESHOLD).toBe(3);
  });
});

describe('GET /api/cron/evo-report: стрик читается, пишется и уходит в ответ', () => {
  it('стрик читается из evo_agent_state перед решением', () => {
    expect(REPORT_ROUTE).toMatch(/key = 'publish_gate_blocked_streak'/);
  });

  it('вычисляется общей чистой функцией, а не своей копией арифметики', () => {
    expect(REPORT_ROUTE).toMatch(/nextPublishGateStreak\(decision\.allowGuesses, streakRows\[0\]\?\.value \?\? 0\)/);
  });

  it('записывается обратно — иначе стрик никогда не растёт между прогонами', () => {
    expect(REPORT_ROUTE).toMatch(/ON CONFLICT \(key\) DO UPDATE SET value = to_jsonb\(\$1::int\)/);
  });

  it('поле уходит в JSON-ответ — раннер должен его увидеть', () => {
    expect(REPORT_ROUTE).toMatch(/publish_gate_blocked_streak:\s*publishGateBlockedStreak/);
  });

  it('запись стрика не блокирует сам отчёт при сбое БД (некритичная телеметрия)', () => {
    const block = REPORT_ROUTE.slice(
      REPORT_ROUTE.indexOf("key = 'publish_gate_blocked_streak'"),
      REPORT_ROUTE.indexOf('publish_gate_blocked_streak: publishGateBlockedStreak'),
    );
    expect(block).toMatch(/\.catch\(/);
  });
});

describe('scripts/evo-report-issues.js: тормоз виден, но job из-за него не краснеет', () => {
  it('порог совпадает с общей константой', () => {
    expect(RUNNER).toMatch(/PUBLISH_GATE_STREAK_THRESHOLD = 3/);
  });

  it('поле стрика читается из ответа прода', () => {
    expect(RUNNER).toMatch(/publishGateBlockedStreak:\s*data\.publish_gate_blocked_streak/);
  });

  it('при длинном тормозе — предупреждение, не красный прогон', () => {
    // 39 из 40 прогонов с 18.10 краснели уже после успешного выноса issue.
    // Рука, которая не смогла завести задачу, тонула в этом стрике.
    const idx = RUNNER.indexOf('publishGateBlockedStreak >= PUBLISH_GATE_STREAK_THRESHOLD');
    expect(idx).toBeGreaterThan(-1);
    const block = RUNNER.slice(idx, idx + 700);
    expect(block).toMatch(/log\('WARN'/);
    expect(block).not.toMatch(/process\.exitCode = 1/);
    expect(block).not.toMatch(/process\.exit\(1\)/);
  });

  it('точность разведки печатается отдельно от кода', () => {
    expect(RUNNER).toMatch(/intelPrecision:\s*data\.intel_precision/);
    expect(RUNNER).toMatch(/intelGuessesAllowed === false/);
  });
});
