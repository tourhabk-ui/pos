/**
 * Диагностика ledger переживает собственную выкладку.
 *
 * Маркер запускает проверку тем же пушем, которым едет сам роут, а Timeweb
 * выкладывает контейнер около двенадцати минут. Второй прогон 31.08 поэтому
 * ответил HTTP 404 — и это НЕ «ledger пуст» и НЕ «инструмент сломан», а третий
 * исход: спросили раньше, чем появился отвечающий (§4.0).
 *
 * Сторож исполняет тот самый bash-блок из воркфлоу, а не сверяет его регулярками:
 * дважды подряд (PR #1472 с psql, PR #1481 с разбором логов Timeweb) непроверенная
 * логика воркфлоу уходила как рабочая и отказывала первым же прогоном. Приём —
 * репозиторный, тот же что в deploy-ancestry.test.ts: вынуть shell и запустить.
 *
 * Ответы прода подделываются подставным `curl` в PATH, читающим сценарий кодов
 * из файла. Ожидание сокращено через LEDGER_CHECK_DELAY/ATTEMPTS — единственное,
 * ради чего в воркфлоу заведены эти переменные.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';

interface WorkflowShape {
  jobs: Record<string, { 'timeout-minutes'?: number; steps: Array<{ run?: string }> }>;
}

const WORKFLOW = join(process.cwd(), '.github/workflows/safety-ledger-check.yml');

function checkScript(): string {
  const doc = load(readFileSync(WORKFLOW, 'utf8')) as WorkflowShape;
  const run = doc.jobs.check.steps.find((s) => typeof s.run === 'string')?.run;
  if (!run) throw new Error('в safety-ledger-check.yml не найден шаг с `run:`');
  return run;
}

let dir: string;

/**
 * Прогоняет шаг с подставным curl, отдающим коды по сценарию.
 *
 * @param codes  HTTP-коды по попыткам; `curl:<n>` вместо кода означает отказ
 *               самого curl с этим кодом выхода (обрыв связи при перезапуске
 *               контейнера).
 */
function runStep(codes: string[]): { code: number; out: string } {
  const home = mkdtempSync(join(dir, 'run-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(home, 'scenario'), codes.join('\n') + '\n');
  writeFileSync(join(home, 'attempt'), '0');

  // Подставной curl: берёт очередную строку сценария, пишет тело ответа туда,
  // куда просили (-o), и печатает код (-w). Последняя строка сценария
  // повторяется — так выражается «404 навсегда».
  const fakeCurl = `#!/usr/bin/env bash
n=$(cat "${home}/attempt"); n=$((n + 1)); echo "$n" > "${home}/attempt"
line=$(sed -n "\${n}p" "${home}/scenario")
[ -z "$line" ] && line=$(tail -n 1 "${home}/scenario")
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
case "$line" in
  curl:*) exit "\${line#curl:}" ;;
esac
if [ "$line" = "200" ]; then
  [ -n "$out" ] && printf '%s' '{"verdict":"Таблица есть, записей 3 — сверять цепочку","total_events":{"ok":true,"value":3}}' > "$out"
else
  [ -n "$out" ] && printf '%s' "тело для $line" > "$out"
fi
printf '%s' "$line"
`;
  writeFileSync(join(bin, 'curl'), fakeCurl);
  chmodSync(join(bin, 'curl'), 0o755);

  try {
    const out = execFileSync('bash', ['-e', '-c', checkScript()], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CRON_SECRET: 'секрет-для-теста',
        LEDGER_CHECK_URL: 'https://example.invalid/api/cron/safety-ledger-check',
        LEDGER_CHECK_ATTEMPTS: '3',
        LEDGER_CHECK_DELAY: '0',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('safety-ledger-check: ожидание выкладки — исполнением, не чтением', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-check-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('200 с первой попытки — вердикт печатается, ничего не ждём', () => {
    const { code, out } = runStep(['200']);
    expect(code).toBe(0);
    expect(out).toContain('HTTP 200 с попытки 1');
    expect(out).toContain('ВЕРДИКТ: Таблица есть, записей 3');
    expect(out).not.toContain('попытка 1 из');
  });

  it('404, пока идёт выкладка, затем 200 — успех, и ожидание названо словами', () => {
    const { code, out } = runStep(['404', '404', '200']);
    expect(code).toBe(0);
    expect(out).toContain('роута ещё нет');
    expect(out).toContain('HTTP 200 с попытки 3');
    expect(out).toContain('ВЕРДИКТ:');
  });

  it('обрыв связи при перезапуске контейнера ждётся так же, как 404', () => {
    const { code, out } = runStep(['curl:7', '200']);
    expect(code).toBe(0);
    expect(out).toContain('curl 7');
    expect(out).toContain('HTTP 200 с попытки 2');
  });

  it('404 до конца терпения — отказ, и он говорит «не смогли спросить», а не «ledger пуст»', () => {
    const { code, out } = runStep(['404']);
    expect(code).toBe(1);
    expect(out).toContain('роут так и не ответил');
    expect(out).toContain('«не смогли спросить», а не «ledger пуст»');
    // Приговор указывает на выкладку, а не на миграцию — иначе разбор пойдёт
    // не туда, ровно как 30.08 с пустой вкладкой при недоехавшем коде.
    expect(out).toContain('выкладку контейнера');
  });

  it('любой иной код — приговор сразу, без ожидания: это ответ роута, а не его отсутствие', () => {
    const { code, out } = runStep(['500', '200']);
    expect(code).toBe(1);
    expect(out).toContain('Роут ответил 500');
    expect(out).toContain('тело для 500');
    expect(out).not.toContain('попытка 1 из');
  });

  it('401 не ждётся тоже — неверный секрет чинится не временем', () => {
    const { code, out } = runStep(['401']);
    expect(code).toBe(1);
    expect(out).toContain('Роут ответил 401');
  });
});

describe('safety-ledger-check: терпение джоба больше терпения шага', () => {
  it('timeout-minutes покрывает полное ожидание выкладки с запасом', () => {
    const doc = load(readFileSync(WORKFLOW, 'utf8')) as WorkflowShape;
    const jobMinutes = doc.jobs.check['timeout-minutes'];
    expect(jobMinutes, 'у джоба обязан быть timeout-minutes').toBeTypeOf('number');

    const script = checkScript();
    const attempts = Number(/LEDGER_CHECK_ATTEMPTS:-(\d+)/.exec(script)?.[1]);
    const delay = Number(/LEDGER_CHECK_DELAY:-(\d+)/.exec(script)?.[1]);
    expect(attempts).toBeGreaterThan(0);
    expect(delay).toBeGreaterThan(0);

    // Тот же урок, что E-1 в cron-evo.yml: когда терпение вызывающего равно
    // бюджету исполнителя, «не уложился» и «не дождались» неразличимы.
    const waitSeconds = attempts * delay;
    expect(
      (jobMinutes as number) * 60,
      'джоб обрывает ожидание раньше, чем шаг успевает досчитать — исход снова станет неразличим',
    ).toBeGreaterThan(waitSeconds);

    // Выкладка Timeweb — около 12 минут (замеры прогонов deploy.yml 1369-1378).
    // Ждать меньше значит гарантированно получать 404 на своей же выкладке.
    expect(waitSeconds, 'ожидание короче выкладки Timeweb — 404 будет всегда').toBeGreaterThanOrEqual(12 * 60);
  });
});
