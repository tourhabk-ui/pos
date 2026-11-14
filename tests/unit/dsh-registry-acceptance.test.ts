// @vitest-environment node
/**
 * Приёмочный прогон для каталога коннекторов DeepSeek Harness
 * (.github/workflows/dsh-registry-acceptance.yml, слово владельца 13.11
 * «исправь, подай»).
 *
 * ── Что здесь опасного ────────────────────────────────────────────────────
 *
 * Прогон исполняет ЧУЖОЙ скрипт: проверяющий каталога принимает сервер по
 * отчёту своего же `run-runtime-acceptance.mjs`. Чужой код на нашем раннере
 * терпим при трёх условиях, и сторож держит каждое:
 *
 *  - исполняется тот коммит, который прочитан: в маркере полный sha, а ветку,
 *    короткий sha и путь наружу шаг отвергает ДО обращения к git;
 *  - у прогона нет секретов и нет прав на запись;
 *  - вызов один и читающий: инструмент из маркера — не заявка и не отмена.
 *
 * ── Чем судим ─────────────────────────────────────────────────────────────
 *
 * Шаги исполняются настоящим bash и python с подложенными git, node и curl —
 * правило судится исходом шага, а не его текстом. «Скрипт зовётся один раз»
 * считается по журналу подложенного node за ВЕСЬ прогон: счёт по строкам
 * пропускал второй вызов, дописанный через `;` или записанный как
 * `"\${SCRIPT}"` (ревью безопасности на #3341). По тексту и по разобранному
 * YAML судятся только запреты: слова `secrets` в прогоне нет ни в каком
 * написании, токен репозитория — только у шага ожидания выката.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { CHANGE_TOOL_NAMES, PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';

const ROOT = process.cwd();
const WF_PATH = '.github/workflows/dsh-registry-acceptance.yml';
const MARKER_PATH = '.github/triggers/dsh-registry-acceptance.json';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

interface Step { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; if?: string }
interface Workflow {
  on: { push?: { branches?: string[]; paths?: string[] }; schedule?: unknown };
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, { steps: Step[]; permissions?: Record<string, string>; env?: Record<string, string>; uses?: string; secrets?: unknown }>;
}
interface Marker {
  run: number; registry_repo: string; registry_sha: string; script: string;
  tool: string; args: Record<string, unknown>; reviewer: string;
}

// `on` в YAML 1.1 читается как ключ true — берём оба написания.
const rawWf = load(read(WF_PATH)) as Record<string, unknown>;
const wf = { ...rawWf, on: (rawWf.on ?? (rawWf as Record<string, unknown>)['true']) } as unknown as Workflow;
const steps = wf.jobs.accept.steps;
const stepRun = (name: string): string => {
  const s = steps.find((x) => x.name === name);
  if (!s?.run) throw new Error(`шага «${name}» нет`);
  return s.run;
};
const marker = JSON.parse(read(MARKER_PATH)) as Marker;

const WAIT_STEP = 'Wait for fresh deploy';
const PIN_STEP = 'Скрипт каталога — приколотый коммит';
const ACCEPT_STEP = 'Приёмочный прогон — один читающий вызов';
const FACTS_STEP = 'Состав сервера — кто меняет состояние';
const OUR_MCP = 'https://vedarai.ru/api/mcp';
const GOOD_SHA = 'a'.repeat(40);

/** Подложенный git: пишет каждый вызов в журнал, `rev-parse` отвечает FAKE_SHA, `checkout` кладёт скрипт. */
const FAKE_GIT = `#!/bin/bash
echo "$@" >> "$GIT_LOG"
case "$1" in
  fetch) [ "\${FAKE_FETCH_FAILS:-}" = 1 ] && exit 128; exit 0;;
  checkout) if [ -n "\${FAKE_SCRIPT:-}" ]; then mkdir -p "$(dirname "$FAKE_SCRIPT")"; echo '// stub' > "$FAKE_SCRIPT"; fi; exit 0;;
  rev-parse) echo "$FAKE_SHA"; exit 0;;
  *) exit 0;;
esac
`;

function runPinStep(over: Partial<Marker>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-accept-pin-'));
  try {
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, '.github/triggers'), { recursive: true });
    mkdirSync(join(dir, 'tmp'));
    writeFileSync(join(dir, 'bin/git'), FAKE_GIT);
    chmodSync(join(dir, 'bin/git'), 0o755);
    const m = { registry_repo: 'tourhabk-ui/dsh-mcp-connector-registry', registry_sha: GOOD_SHA, script: 'scripts/run.mjs', ...over };
    writeFileSync(join(dir, MARKER_PATH), JSON.stringify(m));
    const gitLog = join(dir, 'git.log');
    writeFileSync(gitLog, '');
    const r = spawnSync('bash', ['-c', stepRun(PIN_STEP)], {
      cwd: dir,
      env: {
        PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: join(dir, 'tmp'), GIT_LOG: gitLog,
        FAKE_SHA: GOOD_SHA, FAKE_SCRIPT: m.script, ...env,
      },
      encoding: 'utf8',
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, git: readFileSync(gitLog, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('шаг «приколотый коммит» — исполнением', () => {
  it('полный sha, свой путь, коммит тот же — шаг зелёный и называет каталог и сумму скрипта', () => {
    const r = runPinStep({});
    expect(r.out).toContain(`Каталог: tourhabk-ui/dsh-mcp-connector-registry @ ${GOOD_SHA}`);
    expect(r.out).toMatch(/Скрипт: scripts\/run\.mjs, sha256 [0-9a-f]{64}/);
    expect(r.code).toBe(0);
    expect(r.git).toContain(`fetch -q --depth 1 origin ${GOOD_SHA}`);
  });

  it('ветка или короткий sha вместо полного — красный, и git не зовётся вовсе', () => {
    for (const sha of ['main', 'add-vedar', GOOD_SHA.slice(0, 12), `${GOOD_SHA}0`, GOOD_SHA.toUpperCase()]) {
      const r = runPinStep({ registry_sha: sha });
      expect(r.code, sha).toBe(1);
      expect(r.out, sha).toContain('не полный sha');
      expect(r.git, sha).toBe('');
    }
  });

  it('репозиторий не вида owner/repo — красный до git', () => {
    for (const repo of ['https://evil.example/x/y', 'owner', 'a/b/c', 'a/b --upload-pack=x']) {
      const r = runPinStep({ registry_repo: repo });
      expect(r.code, repo).toBe(1);
      expect(r.git, repo).toBe('');
    }
  });

  it('путь скрипта наружу, абсолютный или не .mjs — красный до git', () => {
    for (const script of ['../x.mjs', 'scripts/../../x.mjs', '/etc/x.mjs', 'scripts/run.sh', 'scripts/run.mjs; id']) {
      const r = runPinStep({ script });
      expect(r.code, script).toBe(1);
      expect(r.git, script).toBe('');
    }
  });

  it('получен другой коммит — красный: исполнять можно только прочитанное', () => {
    const r = runPinStep({}, { FAKE_SHA: 'b'.repeat(40) });
    expect(r.code).toBe(1);
    expect(r.out).toContain('а приколот');
  });

  it('коммит не получен или скрипта в нём нет — красный «не смог», а не тихий пропуск', () => {
    const noFetch = runPinStep({}, { FAKE_FETCH_FAILS: '1' });
    expect(noFetch.code).toBe(1);
    expect(noFetch.out).toContain('не смог получить коммит');
    const noScript = runPinStep({}, { FAKE_SCRIPT: '' });
    expect(noScript.code).toBe(1);
    expect(noScript.out).toContain('в коммите нет файла');
  });
});

/** Питон шага — между `<<'PY'` и строкой `PY`. */
function heredocPython(run: string): string {
  const m = run.match(/<<'PY'[^\n]*\n([\s\S]*?)\nPY\b/);
  if (!m) throw new Error('heredoc PY не найден');
  return m[1];
}

function runFacts(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-accept-facts-'));
  try {
    const file = join(dir, 'tools.txt');
    writeFileSync(file, body);
    const r = spawnSync('python3', ['-c', heredocPython(stepRun(FACTS_STEP))], {
      env: { PATH: process.env.PATH ?? '', TOOLS_FILE: file }, encoding: 'utf8',
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('шаг «состав сервера» — исполнением на ответе нынешнего сервера', () => {
  const live = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: PUBLIC_MCP_TOOLS } });
  const changing = PUBLIC_MCP_TOOLS.filter((t) => (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint !== true);

  it('называет число инструментов и каждый меняющий состояние по имени', () => {
    const r = runFacts(live);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Инструментов: ${PUBLIC_MCP_TOOLS.length}`);
    expect(r.out).toContain(`Меняют состояние (readOnlyHint не true): ${changing.length}`);
    for (const t of changing) expect(r.out, t.name).toContain(`| ${t.name} |`);
    // Читающий инструмент в таблицу меняющих не попадает.
    expect(r.out).not.toContain('| get_tours |');
  });

  it('у каждой заявки — «consent обязателен: да» и имя с телефоном; у отмены и черновиков плана — нет', () => {
    const r = runFacts(live);
    const row = (name: string) => r.out.split('\n').find((l) => l.startsWith(`| ${name} |`)) ?? '';
    for (const name of WRITE_TOOL_NAMES) expect(row(name), name).toMatch(/\| да \| да \|$/);
    for (const name of [...CHANGE_TOOL_NAMES, 'make_trip_plan', 'edit_trip_plan']) expect(row(name), name).toMatch(/\| нет \| нет \|$/);
  });

  it('инструмент без объявленного readOnlyHint считается меняющим; согласие — по списку обязательных, а не по наличию поля', () => {
    const tools = [
      { name: 'reads', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
      { name: 'silent', inputSchema: { properties: {} } },
      { name: 'optional_consent', annotations: { readOnlyHint: false }, inputSchema: { properties: { consent: {}, name: {}, phone: {} }, required: ['name'] } },
    ];
    const r = runFacts(JSON.stringify({ result: { tools } }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('Меняют состояние (readOnlyHint не true): 2');
    expect(r.out).toContain('| silent |');
    expect(r.out).not.toContain('| reads |');
    expect(r.out.split('\n').find((l) => l.startsWith('| optional_consent |'))).toMatch(/\| нет \| да \|$/);
  });

  it('ответ потоком событий читается так же', () => {
    const r = runFacts(`event: message\ndata: ${live}\n\n`);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Инструментов: ${PUBLIC_MCP_TOOLS.length}`);
  });

  it('списка нет или он пуст — красный, а не «инструментов: 0»', () => {
    for (const body of ['', 'not json', JSON.stringify({ result: {} }), JSON.stringify({ result: { tools: [] } }), JSON.stringify({ error: { code: -1 } })]) {
      const r = runFacts(body);
      expect(r.code, body).toBe(1);
      expect(r.out, body).not.toContain('Инструментов:');
    }
  });
});

/** Подложенный node: каждый вызов — строка журнала, аргументы через \x1f. Код выхода — FAKE_NODE_EXIT. */
const FAKE_NODE = `#!/bin/bash
{ printf '%s\\x1f' "$@"; printf '\\n'; } >> "$NODE_LOG"
echo "- Decision: **\${FAKE_NODE_DECISION:-pass}**"
exit "\${FAKE_NODE_EXIT:-0}"
`;

/** Подложенный curl: пишет адрес и тело запроса в журнал, кладёт готовый ответ в файл из -o, печатает код 200. */
const FAKE_CURL = `#!/bin/bash
out=""; url=""; body=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -d) body="$2"; shift 2;;
    -w|-A|-H|--max-time) shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
printf '%s\\x1f%s\\n' "$url" "$body" >> "$CURL_LOG"
case "$url" in
  *vedarai.ru*) cp "$FAKE_TOOLS_FILE" "$out";;
  *) cp "$FAKE_REGISTRY_FILE" "$out";;
esac
printf 200
`;

/**
 * Весь прогон, кроме ожидания выката: каждый шаг с `run` — настоящим bash, в
 * порядке файла, с настоящим маркером. Журналы подложенных node и curl —
 * общие на все шаги: вызов, спрятанный в любом из них, в журнал попадёт.
 */
function runWholeJob(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-accept-job-'));
  try {
    const ws = join(dir, 'ws');
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(ws, '.github/triggers'), { recursive: true });
    mkdirSync(join(dir, 'tmp'));
    for (const [name, body] of [['git', FAKE_GIT], ['node', FAKE_NODE], ['curl', FAKE_CURL]] as const) {
      writeFileSync(join(dir, 'bin', name), body);
      chmodSync(join(dir, 'bin', name), 0o755);
    }
    writeFileSync(join(ws, MARKER_PATH), read(MARKER_PATH));
    const files = { git: join(dir, 'git.log'), node: join(dir, 'node.log'), curl: join(dir, 'curl.log'), summary: join(dir, 'summary.md') };
    for (const f of Object.values(files)) writeFileSync(f, '');
    writeFileSync(join(dir, 'tools.json'), JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: PUBLIC_MCP_TOOLS } }));
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({
      server: { name: 'ru.vedarai/mcp', version: '0.0.0-test', description: 'x' },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isLatest: true } },
    }));
    const codes: Array<{ step: string; code: number | null; out: string }> = [];
    for (const s of steps) {
      if (!s.run || s.name === WAIT_STEP) continue;
      const r = spawnSync('bash', ['-e', '-c', s.run], {
        cwd: ws,
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: join(dir, 'tmp'), GITHUB_WORKSPACE: ws, GITHUB_STEP_SUMMARY: files.summary,
          GIT_LOG: files.git, NODE_LOG: files.node, CURL_LOG: files.curl,
          FAKE_SHA: marker.registry_sha, FAKE_SCRIPT: marker.script,
          FAKE_TOOLS_FILE: join(dir, 'tools.json'), FAKE_REGISTRY_FILE: join(dir, 'registry.json'),
          ...env,
        },
        encoding: 'utf8',
      });
      codes.push({ step: s.name ?? '', code: r.status, out: `${r.stdout}${r.stderr}` });
    }
    const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean);
    return {
      codes,
      nodeCalls: lines(files.node).map((l) => l.split('\x1f').slice(0, -1)),
      curlCalls: lines(files.curl).map((l) => { const [url, body] = l.split('\x1f'); return { url, body }; }),
      summary: readFileSync(files.summary, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('весь прогон — исполнением: кого и сколько раз он зовёт', () => {
  it('чужой скрипт зовётся ровно один раз за весь прогон — с инструментом и аргументами маркера, на наш адрес', () => {
    const r = runWholeJob();
    for (const c of r.codes) expect(c.code, `${c.step}: ${c.out}`).toBe(0);
    expect(r.nodeCalls).toEqual([[
      marker.script, '--url', OUR_MCP, '--tool', marker.tool,
      '--args', JSON.stringify(marker.args), '--reviewer', marker.reviewer,
    ]]);
  });

  it('своим кодом прогон зовёт сервер один раз и только tools/list; второй запрос — в реестр MCP', () => {
    const r = runWholeJob();
    const ours = r.curlCalls.filter((c) => c.url.includes('vedarai.ru'));
    expect(ours).toHaveLength(1);
    expect(ours[0].url).toBe(OUR_MCP);
    expect((JSON.parse(ours[0].body) as { method: string }).method).toBe('tools/list');
    const others = r.curlCalls.filter((c) => !c.url.includes('vedarai.ru'));
    expect(others).toHaveLength(1);
    expect(new URL(others[0].url).hostname).toBe('registry.modelcontextprotocol.io');
    expect(others[0].body).toBe('');
  });

  it('сводка прогона несёт отчёт скрипта, состав сервера и запись реестра', () => {
    const r = runWholeJob();
    expect(r.summary).toContain('Decision: **pass**');
    expect(r.summary).toContain(`Инструментов: ${PUBLIC_MCP_TOOLS.length}`);
    expect(r.summary).toContain('version: 0.0.0-test');
  });

  it('скрипт ответил отказом — шаг приёмки красный', () => {
    const r = runWholeJob({ FAKE_NODE_EXIT: '1', FAKE_NODE_DECISION: 'fail' });
    expect(r.codes.find((c) => c.step === ACCEPT_STEP)?.code).not.toBe(0);
  });
});

describe('маркер приёмочного прогона', () => {
  it('приколот полный sha каталога, путь — .mjs внутри него', () => {
    expect(marker.registry_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(marker.registry_repo).toMatch(/^[A-Za-z0-9._-]+\/dsh-mcp-connector-registry$/);
    expect(marker.script).toMatch(/^scripts\/[A-Za-z0-9._/-]+\.mjs$/);
    expect(marker.script).not.toContain('..');
  });

  it('вызов один и читающий: инструмент сервера, не заявка и не отмена, без имени, телефона и согласия', () => {
    const tool = PUBLIC_MCP_TOOLS.find((t) => t.name === marker.tool) as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } } | undefined;
    expect(tool, `инструмента ${marker.tool} у сервера нет`).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).not.toBe(true);
    expect(WRITE_TOOL_NAMES.has(marker.tool)).toBe(false);
    expect(CHANGE_TOOL_NAMES.has(marker.tool)).toBe(false);
    for (const key of ['name', 'phone', 'consent', 'key', 'email']) expect(Object.keys(marker.args)).not.toContain(key);
    expect(JSON.stringify(marker.args)).not.toMatch(/@|\+7|\d{6,}/);
  });

  it('у каждого прогона названа причина', () => {
    const m = marker as unknown as Record<string, unknown>;
    expect(typeof m[`run${marker.run}_reason`]).toBe('string');
    expect(String(m[`run${marker.run}_reason`]).length).toBeGreaterThan(40);
  });
});

describe('прогон: без секретов, без записи, по своему маркеру', () => {
  const src = read(WF_PATH);
  const code = src.replace(/^[ \t]*#.*$/gm, '');

  it('запускается правкой своего маркера в main; расписания нет', () => {
    expect(wf.on.push?.branches).toEqual(['main']);
    expect(wf.on.push?.paths).toEqual([MARKER_PATH]);
    expect(wf.on.schedule).toBeUndefined();
  });

  it('права — только чтение; учётные данные checkout не остаются на диске', () => {
    expect(wf.permissions).toEqual({ contents: 'read', deployments: 'read' });
    expect(wf.jobs.accept.permissions).toBeUndefined();
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  it('секретов прогон не берёт — ни в каком написании', () => {
    // Слово целиком, а не `secrets.`: так же ловятся secrets['X'] и `secrets: inherit`.
    expect(code).not.toMatch(/\bsecrets\b/i);
    expect(wf.jobs.accept.secrets).toBeUndefined();
    // Чужой workflow или чужое действие получили бы окружение раннера: их здесь нет.
    expect(Object.keys(wf.jobs)).toEqual(['accept']);
    expect(wf.jobs.accept.uses).toBeUndefined();
    expect(steps.filter((s) => s.uses).map((s) => s.uses)).toEqual(['actions/checkout@v7', 'actions/setup-node@v7']);
  });

  it('токен репозитория есть только у шага ожидания выката и до чужого скрипта не доходит', () => {
    // Окружение уровня прогона и джоба получил бы каждый шаг, включая шаг со скриптом.
    expect(wf.env).toBeUndefined();
    expect(wf.jobs.accept.env).toBeUndefined();
    const TOKEN = /github\.token|GITHUB_TOKEN|GH_TOKEN/;
    for (const s of steps) {
      const blob = JSON.stringify({ env: s.env ?? {}, with: s.with ?? {}, run: s.run ?? '' });
      if (s.name === WAIT_STEP) expect(blob).toMatch(TOKEN);
      else expect(blob, s.name ?? s.uses).not.toMatch(TOKEN);
    }
    // У шагов, которые получают и исполняют чужой код, своего окружения нет вовсе.
    for (const name of [PIN_STEP, ACCEPT_STEP]) expect(steps.find((s) => s.name === name)?.env, name).toBeUndefined();
    // Шаг ожидания ничего не передаёт следующим шагам.
    expect(read('scripts/wait-for-deploy.sh')).not.toMatch(/GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH/);
    expect(steps.find((s) => s.name === WAIT_STEP)?.run).toBe('bash scripts/wait-for-deploy.sh');
  });

  it('репозиторий, коммит и путь скрипта берутся из маркера, а не вписаны в прогон', () => {
    expect(code).not.toContain(marker.registry_sha);
    expect(code).not.toContain(marker.script);
    expect(stepRun(PIN_STEP)).toContain(MARKER_PATH);
  });

  it('своим кодом прогон инструменты не вызывает: слова tools/call в нём нет', () => {
    // Сколько раз и с чем зовётся чужой скрипт, судит блок «весь прогон — исполнением».
    expect(code).not.toContain('tools/call');
  });
});
