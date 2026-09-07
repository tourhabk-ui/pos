/**
 * «Тот ли код на проде» — отдельный вопрос от «давно ли перезапускались».
 *
 * 04.09 два замера подряд ушли впустую: шаг «дождись деплоя» смотрел на
 * uptime процесса и считал деплоем ЛЮБОЙ свежий рестарт — в том числе от
 * предыдущего мержа. Прогон уходил на старом коде и выглядел здоровым.
 *
 * Первая починка (#1582) поставила штамп через `env: { BUILD_TIME }` в
 * next.config.js. Замер 05.09 (prod-check run 8): на проде `build_time: null`
 * при uptime 464 с — в standalone-сборке значение до обработчика не доходит,
 * и ожидание отсиживало 25 минут впустую, ничего не дождавшись. Прежняя
 * редакция этого теста ДЕРЖАЛА неработающий механизм.
 *
 * Маркер деплоя один — public/version.json (scripts/write-version.js, commit +
 * built_at, с 23.08 во всех сборках). Его читает /api/health с диска, и по
 * нему же ждёт единый scripts/wait-for-deploy.sh. Судим код, а не прозу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripSh = (s: string) => s.replace(/^\s*#.*$/gm, '');

describe('штамп сборки — маркер version.json, не env', () => {
  it('next.config НЕ заводит второй штамп через env (на проде он был null)', () => {
    expect(stripTs(read('next.config.js'))).not.toMatch(/BUILD_TIME/);
  });

  it('/api/health читает public/version.json с диска и отдаёт built_at рядом с uptime', () => {
    const health = stripTs(read('app/api/health/route.ts'));
    expect(health).toMatch(/readFileSync\(join\(process\.cwd\(\), 'public', 'version\.json'\)/);
    expect(health).toMatch(/build_time: deploy\.built_at/);
    expect(health).toMatch(/uptime: process\.uptime\(\)/);
    expect(health).not.toMatch(/process\.env\.BUILD_TIME/);
  });

  it('отсутствие маркера — третье состояние с причиной, а не тихий null', () => {
    const health = stripTs(read('app/api/health/route.ts'));
    for (const reason of ['marker_missing', 'marker_unreadable', 'marker_malformed']) {
      expect(health, `нет исхода ${reason}`).toContain(`'${reason}'`);
    }
    expect(health).toMatch(/build_marker: deploy\.reason/);
    // 'unknown' из write-version.js — это «не смог», а не имя коммита.
    expect(health).toMatch(/o\.commit !== 'unknown'/);
  });
});

describe('замеры ждут СВОЮ сборку одним правилом', () => {
  const workflows = [
    '.github/workflows/ai-debug.yml',
    '.github/workflows/cron-scout-digest.yml',
    '.github/workflows/prod-check.yml',
  ];
  const script = stripSh(read('scripts/wait-for-deploy.sh'));

  it('скрипт спрашивает /version.json и принимает точный sha ЛИБО сборку новее коммита', () => {
    expect(script).toMatch(/\/version\.json/);
    expect(script).toMatch(/\$\{SERVED:0:7\}" = "\$\{WANT_SHA:0:7\}/);
    expect(script).toMatch(/\[ "\$BT" -ge "\$NEED" \]/);
    expect(script).toMatch(/built_at/);
    expect(script).not.toMatch(/api\/health/);
  });

  it('скрипт не судит по uptime — свежий рестарт не доказательство', () => {
    expect(script).not.toMatch(/uptime/);
  });

  it('«не дождались» говорится вслух, но не роняет замер', () => {
    expect(script).toMatch(/своей сборки не дождались/);
    expect(script.trim().endsWith('exit 0')).toBe(true);
  });

  it('все три прогона зовут общий скрипт с коммитом и его временем', () => {
    for (const w of workflows) {
      const src = read(w);
      expect(src, `${w}: не зовёт общий скрипт`).toMatch(/run: bash scripts\/wait-for-deploy\.sh/);
      expect(src, `${w}: не передаёт sha`).toMatch(/WANT_SHA: \$\{\{ github\.sha \}\}/);
      expect(src, `${w}: не передаёт время коммита`).toMatch(/NEED_AFTER: \$\{\{ github\.event\.head_commit\.timestamp \}\}/);
      expect(stripSh(src), `${w}: своё ожидание по build_time вместо общего скрипта`).not.toMatch(/build_time/);
    }
  });

  it('скрипт лежит в репозитории — без checkout перед шагом его не найти', () => {
    for (const w of workflows) {
      const src = read(w);
      const checkout = src.indexOf('uses: actions/checkout@');
      const wait = src.indexOf('run: bash scripts/wait-for-deploy.sh');
      expect(checkout, `${w}: нет checkout`).toBeGreaterThan(-1);
      expect(checkout, `${w}: checkout стоит ПОСЛЕ ожидания`).toBeLessThan(wait);
    }
  });
});
