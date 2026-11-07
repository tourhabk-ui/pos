// @vitest-environment node
/**
 * Чистка окружения подпроцессов Claude Code держится на bubblewrap.
 *
 * С CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 Claude Code без bwrap не стартует
 * вовсе: «bubblewrap is required for subprocess env scrubbing». Так 07.11
 * упал run 1 пробы ревьюера: девять работ за секунду, ни одного запроса к
 * модели. У четырёх рук шаг установки был, у пятой копии его не оказалось.
 *
 * Сторож держит связку, а не половину (CLAUDE.md, правило 10.09). В каждом
 * job, где чистка включена для шага с Claude Code (env шага или job, export в
 * run), раньше в том же job стоит шаг, который:
 *  - ставит bubblewrap;
 *  - снимает запрет AppArmor на непривилегированные пространства имён — на
 *    них bwrap строит песочницу.
 * Workflow судится по смыслу шагов (CLAUDE.md §4, 13.10), а не по форме строки.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

interface Step { name?: string; uses?: string; run?: string; env?: Record<string, unknown> }
interface Job { env?: Record<string, unknown>; steps?: Step[] }

const DIR = '.github/workflows';
const SCRUB = 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB';

const scrubOnByEnv = (env: Record<string, unknown> | undefined) => env != null && String(env[SCRUB]) === '1';
const scrubOnByRun = (run: string | undefined) => new RegExp(`\\b${SCRUB}=['"]?1\\b`).test(run ?? '');
/** Шаг запускает Claude Code: экшен рук или `claude -p` в скрипте. */
const runsClaude = (s: Step) =>
  (s.uses ?? '').startsWith('anthropics/claude-code-action')
  || /(^|[\s;|&(])claude\s+[^\n]*(?:-p|--print)\b/m.test(s.run ?? '');
/** Шаг ставит bubblewrap и снимает запрет AppArmor на пространства имён. */
const installsBwrap = (s: Step) =>
  /apt-get\s+install\b[^\n]*\bbubblewrap\b/.test(s.run ?? '')
  && /kernel\.apparmor_restrict_unprivileged_userns=0/.test(s.run ?? '');

interface Finding { where: string; claudeStep: string; bwrapBefore: boolean }

function scan(dir = DIR): Finding[] {
  const out: Finding[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const wf = load(readFileSync(join(dir, file), 'utf-8')) as { jobs?: Record<string, Job> } | null;
    for (const [jobId, job] of Object.entries(wf?.jobs ?? {})) {
      const steps = job.steps ?? [];
      const at = steps.findIndex((s) =>
        runsClaude(s) && (scrubOnByEnv(job.env) || scrubOnByEnv(s.env) || scrubOnByRun(s.run)));
      if (at < 0) continue;
      out.push({
        where: `${file}/${jobId}`,
        claudeStep: steps[at].name ?? steps[at].uses ?? `#${at}`,
        bwrapBefore: steps.slice(0, at).some(installsBwrap),
      });
    }
  }
  return out;
}

describe('чистка окружения подпроцессов — с bubblewrap в том же job', () => {
  const found = scan();

  it('находит руки с чисткой, пробу тоже (ноль — отказ сканера, а не «нарушений нет»)', () => {
    expect(found.map((f) => f.where)).toEqual(expect.arrayContaining([
      'issue-triage.yml/triage',
      'weekly-chronicle.yml/chronicle',
      'ci-sweeper.yml/sweep',
      'reviewer-model-probe.yml/review',
      'security-review.yml/review',
    ]));
  });

  it('перед каждым шагом с Claude Code под чисткой bubblewrap уже поставлен', () => {
    const missing = found.filter((f) => !f.bwrapBefore).map((f) => `${f.where} → «${f.claudeStep}»`);
    expect(missing).toEqual([]);
  });

  it('сканер различает: шаг после Claude Code и шаг без снятия запрета AppArmor — не установка', () => {
    const claude: Step = { name: 'Ревью', run: 'export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1\nclaude -p "/security-review" --model m' };
    const bwrap: Step = {
      name: 'bubblewrap',
      run: 'sudo apt-get install -y --no-install-recommends bubblewrap socat\nsudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    };
    const noSysctl: Step = { name: 'bubblewrap', run: 'sudo apt-get install -y bubblewrap' };
    expect(runsClaude(claude) && scrubOnByRun(claude.run)).toBe(true);
    expect(installsBwrap(bwrap)).toBe(true);
    expect(installsBwrap(noSysctl)).toBe(false);
    expect(runsClaude({ run: 'claude --version' })).toBe(false);
    expect(runsClaude({ uses: 'anthropics/claude-code-action@115e0b2c49222c831de6748ccdf365bb8d3ea9a3' })).toBe(true);
    expect(scrubOnByEnv({ [SCRUB]: '1' })).toBe(true);
    expect(scrubOnByEnv({ [SCRUB]: '0' })).toBe(false);
  });
});
