/**
 * Ожидание выкладки переживает собственную выкладку.
 *
 * Маркер запускает проверку тем же пушем, которым едет сам роут, а Timeweb
 * выкладывает контейнер около двенадцати минут. Второй прогон 31.08 поэтому
 * ответил HTTP 404 — и это НЕ «данных нет» и НЕ «инструмент сломан», а третий
 * исход: спросили раньше, чем появился отвечающий (§4.0).
 *
 * Сторож ИСПОЛНЯЕТ настоящий цикл ожидания, а не сверяет его регулярками:
 * дважды подряд (PR #1472 с psql, PR #1481 с разбором логов Timeweb) непроверенная
 * логика воркфлоу уходила как рабочая и отказывала первым же прогоном. Приём —
 * репозиторный, тот же что в deploy-ancestry.test.ts: вынуть shell и запустить.
 *
 * Цикл живёт в `scripts/ci/wait-for-contract.sh`, а не внутри воркфлоу: у него
 * появился второй пользователь (перепись реестра схемы), и две копии разошлись
 * бы — в этом репозитории расхождение копий уже было корнем худших дефектов.
 * Сторож поэтому один, общий, и держит поведение обоих воркфлоу сразу; каждому
 * из них остаётся отдельная проверка «объявленная версия одна на двоих».
 *
 * Ответы прода подделываются подставным `curl` в PATH, читающим сценарий кодов
 * из файла. Ожидание сокращено через WAIT_DELAY/WAIT_ATTEMPTS — единственное,
 * ради чего в скрипте заведены эти переменные.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';

interface WorkflowShape {
  jobs: Record<
    string,
    { 'timeout-minutes'?: number; steps: Array<{ run?: string; env?: Record<string, string> }> }
  >;
}

const WORKFLOW = join(process.cwd(), '.github/workflows/safety-ledger-check.yml');
const WAIT_SCRIPT = join(process.cwd(), 'scripts/ci/wait-for-contract.sh');

function checkScript(): string {
  return readFileSync(WAIT_SCRIPT, 'utf8');
}

/** Шаг воркфлоу, который зовёт ожидание, — вместе с его переменными. */
function waitingStep(workflow: string): { run: string; env: Record<string, string> } {
  const doc = load(readFileSync(workflow, 'utf8')) as WorkflowShape;
  for (const job of Object.values(doc.jobs)) {
    const step = job.steps.find((s) => s.run?.includes('wait-for-contract.sh'));
    if (step) return { run: step.run as string, env: step.env ?? {} };
  }
  throw new Error(`в ${workflow} нет шага, зовущего wait-for-contract.sh`);
}

/**
 * Все пользователи общего ожидания. Новый воркфлоу, зовущий скрипт, обязан
 * появиться здесь: иначе он унаследует механизм, но не его проверки — и
 * сломанный питон в его печати выяснится первым прогоном в проде.
 */
const USERS = [
  {
    name: 'safety-ledger-check',
    workflow: WORKFLOW,
    route: 'app/api/cron/safety-ledger-check/route.ts',
  },
  {
    name: 'schema-registry-census',
    workflow: join(process.cwd(), '.github/workflows/schema-registry-census.yml'),
    route: 'app/api/cron/schema-registry-census/route.ts',
  },
];

let dir: string;

/**
 * Прогоняет ШАГ ВОРКФЛОУ целиком с подставным curl, отдающим коды по сценарию.
 *
 * Именно шаг, а не один общий скрипт: ожидание вынесено в скрипт, а печать
 * вердикта осталась у каждого воркфлоу своя, и разбор ответа питоном — тоже
 * его часть. Питон внутри блочного скаляра YAML уже ломался в этом репозитории
 * (шапка timeweb-deploy-logs.yml, IndentationError), и поймать это можно только
 * исполнением.
 *
 * @param codes  HTTP-коды по попыткам. `curl:<n>` вместо кода — отказ самого
 *               curl с этим кодом выхода (обрыв связи при перезапуске
 *               контейнера). `200old` — ответ 200 от ПРЕЖНЕЙ версии контракта:
 *               именно так выглядел прогон 4, где роут уехал прошлым коммитом,
 *               ответил мгновенно и воркфлоу напечатал устаревшие события как
 *               «последние».
 */
function runStep(codes: string[], workflow = WORKFLOW): { code: number; out: string } {
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
case "$line" in
  200)
    [ -n "$out" ] && printf '%s' '{"contract_version":2,"verdict":"Таблица есть, записей 3 — сверять цепочку","counts":{"absent":1},"tables":[{"table":"transfer_bookings","state":"absent","columns":[]}],"recent":{"ok":true,"value":[{"event_id":"10005"}]}}' > "$out"
    line=200 ;;
  200old)
    [ -n "$out" ] && printf '%s' '{"verdict":"Таблица есть, записей 3 — сверять цепочку","counts":{"absent":1},"tables":[{"table":"transfer_bookings","state":"absent","columns":[]}],"recent":{"ok":true,"value":[{"id":"9999"}]}}' > "$out"
    line=200 ;;
  *)
    [ -n "$out" ] && printf '%s' "тело для $line" > "$out" ;;
esac
printf '%s' "$line"
`;
  writeFileSync(join(bin, 'curl'), fakeCurl);
  chmodSync(join(bin, 'curl'), 0o755);

  const step = waitingStep(workflow);
  try {
    const out = execFileSync('bash', ['-e', '-c', step.run], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CRON_SECRET: 'секрет-для-теста',
        // URL подставной, а WAIT_OUT берётся ИЗ ВОРКФЛОУ: путь к телу ответа
        // объявлен в одном месте, а читает его питон в другом, и разойтись они
        // могут молча. Подменять его здесь значило бы стеречь согласие двух
        // мест, подставив им своё третье.
        ...step.env,
        WAIT_URL: 'https://example.invalid/api/cron/probe',
        WAIT_ATTEMPTS: '3',
        WAIT_DELAY: '0',
        // Номер зафиксирован НАМЕРЕННО: сторож стережёт механизм ожидания, а не
        // текущую версию контракта. Иначе каждый бамп в проде ломал бы тест, и
        // его чинили бы правкой ожиданий — то есть сторож обслуживал бы себя.
        // Совпадение номеров роута и воркфлоу проверяется отдельно, ниже.
        WAIT_CONTRACT: '2',
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

describe('ожидание выкладки — исполнением, не чтением', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-check-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(USERS)('$name: 200 с первой попытки — вердикт печатается, ничего не ждём', ({ workflow }) => {
    const { code, out } = runStep(['200'], workflow);
    expect(code).toBe(0);
    expect(out).toContain('HTTP 200 с попытки 1');
    expect(out).toContain('ВЕРДИКТ: Таблица есть, записей 3');
    expect(out).not.toContain('попытка 1 из');
  });

  it.each(USERS)('$name: 404, пока идёт выкладка, затем 200 — успех, и ожидание названо словами', ({ workflow }) => {
    const { code, out } = runStep(['404', '404', '200'], workflow);
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

  it('404 до конца терпения — отказ, и он говорит «не смогли спросить», а не «данных нет»', () => {
    const { code, out } = runStep(['404']);
    expect(code).toBe(1);
    // Формулировка покрывает оба исхода ожидания — «не отвечал вовсе» и
    // «отвечал прежней версией контракта»; здесь проверяется первый.
    expect(out).toContain('нужного ответа не дождались');
    expect(out).toContain('HTTP 404');
    expect(out).toContain('«не смогли спросить», а не ответ роута');
    // Приговор указывает на выкладку, а не на то, что роут диагностирует —
    // иначе разбор пойдёт не туда, ровно как 30.08 с пустой вкладкой «Журнал»
    // при недоехавшем коде: искали бы миграцию 925, а дело было в контейнере.
    expect(out).toContain('выкладку контейнера');
  });

  it('200 от ПРЕЖНЕЙ версии контракта ждётся, а не принимается за ответ', () => {
    // Дефект прогона 4 вживую: роут уехал прошлым коммитом, ответил 200
    // мгновенно, и устаревшие события были напечатаны как «последние».
    // Достижимость отвечающего и нужность его версии — разные вопросы.
    const { code, out } = runStep(['200old', '200old', '200']);
    expect(code).toBe(0);
    expect(out).toContain('контракт 0 < 2');
    expect(out).toContain('прод отвечает прежней версией');
    expect(out).toContain('HTTP 200 с попытки 3');
    // Напечатан вердикт НОВОГО ответа, не прежнего.
    expect(out).toContain('event_id');
    expect(out).not.toContain('"id": "9999"');
  });

  it('прежний контракт до конца терпения — отказ, и он называет причину верно', () => {
    const { code, out } = runStep(['200old']);
    expect(code).toBe(1);
    expect(out).toContain('нужного ответа не дождались');
    expect(out).toContain('контракт 0 < 2');
    // Формулировка обязана покрывать оба случая: «не отвечал» и «отвечал старым».
    expect(out).toContain('отвечал прежней версией контракта');
    expect(out).toContain('«не смогли спросить», а не ответ роута');
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

describe('объявленная версия контракта — одна на двоих', () => {
  it.each(USERS)('$name: роут и воркфлоу называют один и тот же номер', ({ workflow, route }) => {
    // Половинчатый бамп — самый вероятный способ сломать эту защиту: подняли в
    // роуте, забыли в воркфлоу (проверка ослабла и снова пропустит устаревший
    // ответ) либо наоборот (воркфлоу ждёт версию, которой не будет, и краснеет
    // через пятнадцать минут). Обе половины держатся здесь.
    const declared = /contract_version:\s*(\d+)/.exec(readFileSync(join(process.cwd(), route), 'utf8'))?.[1];
    const expected = waitingStep(workflow).env.WAIT_CONTRACT;

    expect(declared, 'роут обязан объявлять contract_version').toBeTruthy();
    expect(expected, 'воркфлоу обязан объявлять ожидаемую версию').toBeTruthy();
    expect(String(expected), `воркфлоу ждёт ${expected}, роут отдаёт ${declared} — бамп сделан наполовину`).toBe(
      declared,
    );
  });

  it.each(USERS)('$name: воркфлоу спрашивает СВОЙ роут, а не чужой', ({ workflow, route }) => {
    // Скопированный воркфлоу с чужим URL отвечал бы бодро и не о том.
    const endpoint = route.replace(/^app\/api/, '/api').replace(/\/route\.ts$/, '');
    expect(waitingStep(workflow).env.WAIT_URL).toContain(endpoint);
  });
});

describe('терпение джоба больше терпения шага', () => {
  it.each(USERS)('$name: timeout-minutes покрывает полное ожидание выкладки', ({ workflow }) => {
    const doc = load(readFileSync(workflow, 'utf8')) as WorkflowShape;
    const job = Object.values(doc.jobs).find((j) => j.steps.some((s) => s.run?.includes('wait-for-contract.sh')));
    const jobMinutes = job?.['timeout-minutes'];
    expect(jobMinutes, 'у джоба обязан быть timeout-minutes').toBeTypeOf('number');

    const script = checkScript();
    const attempts = Number(/WAIT_ATTEMPTS:-(\d+)/.exec(script)?.[1]);
    const delay = Number(/WAIT_DELAY:-(\d+)/.exec(script)?.[1]);
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

  it('копий цикла ожидания не заведено — он один', () => {
    // Смысл выноса. Вторая копия перестала бы ждать версию контракта тихо: обе
    // выглядели бы рабочими, и разошлись бы они молча.
    for (const { workflow, name } of USERS) {
      const src = readFileSync(workflow, 'utf8');
      expect(src.includes('while :;'), `${name} завёл свой цикл вместо общего скрипта`).toBe(false);
    }
  });
});
