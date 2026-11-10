// @vitest-environment node
/**
 * Удаление логов прогонов Actions, в которые попало лишнее (10.11).
 *
 * Репозиторий публичный. До #3203 шаг «живые вопросы» проверки Кузьмича
 * печатал ответ роута целиком — сообщения туристов в открытом логе. Владелец
 * 10.11: «удаляй». У агента права на это нет (403), удаляет workflow по
 * маркеру: scripts/actions-logs-purge.mjs.
 *
 * Сторож судит поведение на подложенном API GitHub с памятью — лог после
 * DELETE перестаёт отдаваться, как у настоящего:
 *  - под чистку идут только прогоны названного workflow раньше границы;
 *    чужие прогоны и прогоны после границы лог сохраняют;
 *  - «удалено» — когда лог перестал отдаваться у прогона И у его заданий;
 *    DELETE 204 при живом логе — отказ;
 *  - сломанная проба («лога нет» на всё подряд) не выдаётся за успех:
 *    контрольный свежий прогон обязан отдавать лог;
 *  - сухой прогон и маркер без mode ничего не удаляют;
 *  - границу и список workflow маркер не двигает;
 *  - отказ доходит до красного прогона: код выхода программы и шаг workflow
 *    исполняются по-настоящему (bash -e, как на раннере), сводка пишется и
 *    при отказе, причина отказа GitHub названа словами.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PURGEABLE, githubApi, main, purge, readOrder } from '../../scripts/actions-logs-purge.mjs';

const REPO = 'o/r';
const TARGET = 'cron-kuzmich-eval.yml';
const BEFORE = PURGEABLE[TARGET].before;

interface FakeJob { id: number; logs: boolean }
interface FakeRun {
  id: number; run_number: number; created_at: string; event: string; status: string; path: string;
  logs: boolean; jobs: FakeJob[];
}
interface Reply { status: number; json: unknown; message?: string }
type Override = (method: string, path: string, runs: FakeRun[]) => Reply | undefined;

function run(id: number, createdAt: string, extra: Partial<FakeRun> = {}): FakeRun {
  return {
    id, run_number: id, created_at: createdAt, event: 'schedule', status: 'completed',
    path: `.github/workflows/${TARGET}`, logs: true, jobs: [{ id: id * 10, logs: true }], ...extra,
  };
}

/** Обычная картина: пять прогонов под границей (у первого лог истёк), один после, два чужих. */
function usualRuns(): FakeRun[] {
  return [
    run(1, '2026-07-06T09:04:56Z', { logs: false, jobs: [{ id: 10, logs: false }] }),
    run(2, '2026-09-14T05:00:00Z'),
    run(3, '2026-10-12T05:00:00Z', { event: 'push' }),
    run(4, '2026-11-03T10:00:00Z', { event: 'workflow_dispatch', jobs: [{ id: 40, logs: true }, { id: 41, logs: true }] }),
    run(5, '2026-11-09T13:43:25Z'),
    run(6, '2026-11-10T15:10:00Z'),
    run(7, '2026-11-10T16:00:00Z', { path: '.github/workflows/ci.yml' }),
    run(8, '2026-11-10T16:30:00Z', { path: '.github/workflows/deploy.yml' }),
  ];
}

function fakeGithub(runs: FakeRun[], override?: Override) {
  const calls: Array<{ method: string; path: string }> = [];
  const jobOf = (id: number) => runs.flatMap((r) => r.jobs).find((j) => j.id === id);
  const api = async (method: string, path: string): Promise<Reply> => {
    calls.push({ method, path });
    const forced = override?.(method, path, runs);
    if (forced) return forced;
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === `/repos/${REPO}/actions/runs?status=completed&per_page=30`) {
      const done = runs.filter((r) => r.status === 'completed').sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { status: 200, json: { workflow_runs: done.slice(0, 30) } };
    }
    if (method === 'GET' && (m = /^\/repos\/o\/r\/actions\/workflows\/([^/]+)\/runs\?per_page=100&page=(\d+)$/.exec(path))) {
      const mine = runs.filter((r) => r.path === `.github/workflows/${m![1]}`).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const page = Number(m[2]);
      return { status: 200, json: { workflow_runs: mine.slice((page - 1) * 100, page * 100) } };
    }
    if ((m = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/logs$/.exec(path))) {
      const target = runs.find((r) => r.id === Number(m![1]));
      if (!target) return { status: 404, json: null };
      if (method === 'GET') return { status: target.logs ? 302 : 410, json: null };
      if (method === 'DELETE') {
        if (!target.logs) return { status: 404, json: null };
        target.logs = false;
        for (const job of target.jobs) job.logs = false;
        return { status: 204, json: null };
      }
    }
    if (method === 'GET' && (m = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs\?filter=all&per_page=100$/.exec(path))) {
      const target = runs.find((r) => r.id === Number(m![1]));
      return target ? { status: 200, json: { jobs: target.jobs.map((j) => ({ id: j.id })) } } : { status: 404, json: null };
    }
    if (method === 'GET' && (m = /^\/repos\/o\/r\/actions\/jobs\/(\d+)\/logs$/.exec(path))) {
      const job = jobOf(Number(m[1]));
      return { status: job?.logs ? 302 : 410, json: null };
    }
    return { status: 500, json: null };
  };
  const deleted = () => calls.filter((c) => c.method === 'DELETE').map((c) => Number(/runs\/(\d+)\//.exec(c.path)![1]));
  return { api, calls, deleted, runs };
}

const ORDER = { ok: true as const, mode: 'apply', workflow: TARGET, before: BEFORE };
const noSleep = async () => {};

async function go(gh: ReturnType<typeof fakeGithub>, mode: 'apply' | 'dry' = 'apply') {
  const lines: string[] = [];
  const result = await purge({ api: gh.api, repo: REPO, order: { ...ORDER, mode }, log: (l: string) => lines.push(l), sleep: noSleep });
  return { result, lines, text: lines.join('\n') };
}

const withLogs = (runs: FakeRun[]) => runs.filter((r) => r.logs || r.jobs.some((j) => j.logs)).map((r) => r.id);

describe('удаление логов: что стирается и что остаётся', () => {
  it('стирает логи прогонов под границей, чужие и поздние не трогает', async () => {
    const gh = fakeGithub(usualRuns());
    const { result, text } = await go(gh);

    expect(result.ok).toBe(true);
    expect(withLogs(gh.runs)).toEqual([6, 7, 8]);
    expect(gh.deleted().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(text).toContain('Итог: удалено 4, лога уже не было 1, отказов 0, не обработано 0.');
    expect(text).toContain('Причина: до #3203');
    expect(text).toMatch(/#5 5 2026-11-09 schedule: удалено \(DELETE 204\)/);
    expect(text).toMatch(/#1 1 2026-07-06 schedule: лога уже не было/);
  });

  it('прогон ровно на границе под чистку не идёт', async () => {
    const gh = fakeGithub([...usualRuns(), run(9, BEFORE)]);
    await go(gh);
    expect(gh.deleted()).not.toContain(9);
    expect(withLogs(gh.runs)).toContain(9);
  });

  it('читает перечень постранично: 130 прогонов — все обработаны', async () => {
    const many = Array.from({ length: 130 }, (_, i) => run(100 + i, '2026-10-01T00:00:00Z'));
    const gh = fakeGithub([...many, run(7, '2026-11-10T16:00:00Z', { path: '.github/workflows/ci.yml' })]);
    const { result } = await go(gh);
    expect(result.ok).toBe(true);
    expect(gh.deleted()).toHaveLength(130);
    expect(withLogs(gh.runs)).toEqual([7]);
  });

  it('повторный прогон после удачного — зелёный и ничего не ломает', async () => {
    const gh = fakeGithub(usualRuns());
    await go(gh);
    const again = await go(gh);
    expect(again.result.ok).toBe(true);
    expect(again.text).toContain('Итог: удалено 0, лога уже не было 5, отказов 0, не обработано 0.');
    expect(withLogs(gh.runs)).toEqual([6, 7, 8]);
  });
});

describe('удаление логов: «удалено» — это прочитано обратно', () => {
  it('DELETE отвечает 403 — отказ с причиной от GitHub, логи на месте; после трёх подряд обход остановлен', async () => {
    const gh = fakeGithub(usualRuns(), (method) => (method === 'DELETE'
      ? { status: 403, json: null, message: 'Resource not accessible by integration' } : undefined));
    const { result, text } = await go(gh);
    expect(result.ok).toBe(false);
    expect(text).toMatch(/#5 5 .*НЕ удалено: лог ещё отдаётся \(DELETE 403: Resource not accessible by integration\)/);
    // Право не появится к следующему прогону: три отказа подряд — и дальше не стучим.
    expect(gh.deleted()).toEqual([5, 4, 3]);
    expect(text).toContain('ОСТАНОВЛЕНО');
    expect(text).toContain('отказов 3, не обработано 2.');
    expect(withLogs(gh.runs)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('отказ не по праву и не по лимиту обхода не прерывает: каждому прогону даётся попытка', async () => {
    const gh = fakeGithub(usualRuns(), (method) => (method === 'DELETE' ? { status: 500, json: null } : undefined));
    const { result, text } = await go(gh);
    expect(result.ok).toBe(false);
    expect(gh.deleted().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(text).not.toContain('ОСТАНОВЛЕНО');
    expect(text).toContain('отказов 4, не обработано 0.');
  });

  it('два отказа по праву и успех между ними счёт подряд сбрасывают', async () => {
    const gh = fakeGithub(usualRuns(), (method, path) => (method === 'DELETE' && /runs\/(5|4|2)\/logs$/.test(path)
      ? { status: 403, json: null } : undefined));
    const { text } = await go(gh);
    expect(text).not.toContain('ОСТАНОВЛЕНО');
    expect(gh.deleted()).toEqual([5, 4, 3, 2, 1]);
    expect(text).toContain('удалено 1, лога уже не было 1, отказов 3, не обработано 0.');
  });

  it('DELETE отвечает 204, а лог всё ещё отдаётся — отказ', async () => {
    const gh = fakeGithub(usualRuns(), (method) => (method === 'DELETE' ? { status: 204, json: null } : undefined));
    const { result, text } = await go(gh);
    expect(result.ok).toBe(false);
    expect(text).toMatch(/НЕ удалено: лог ещё отдаётся \(DELETE 204\)/);
  });

  it('лог прогона исчез, а лог задания остался — отказ', async () => {
    const gh = fakeGithub(usualRuns(), (method, path, runs) => {
      const m = /runs\/(\d+)\/logs$/.exec(path);
      if (method !== 'DELETE' || !m) return undefined;
      runs.find((r) => r.id === Number(m[1]))!.logs = false;
      return { status: 204, json: null };
    });
    const { result, text } = await go(gh);
    expect(result.ok).toBe(false);
    expect(text).toMatch(/#4 4 .*НЕ удалено: лог задания 40 ещё отдаётся/);
  });

  it('после удаления проба отвечает не 404 и не 410 — «не смог проверить», а не «удалено»', async () => {
    let removed = false;
    const gh = fakeGithub(usualRuns(), (method, path) => {
      if (!/runs\/5\/logs$/.exec(path)) return undefined;
      if (method === 'DELETE') { removed = true; return { status: 204, json: null }; }
      return removed ? { status: 403, json: null } : undefined;
    });
    const { result, text } = await go(gh);
    expect(result.ok).toBe(false);
    expect(text).toMatch(/#5 5 .*не смог проверить после запроса на удаление \(HTTP 403, DELETE 204\)/);
  });

  it('проба лога задания не ответила — «не смог проверить», а не «удалено»', async () => {
    const gh = fakeGithub(usualRuns(), (method, path) => (/jobs\/41\/logs$/.test(path) ? { status: 500, json: null } : undefined));
    const { result, text } = await go(gh);
    expect(result.ok).toBe(false);
    expect(text).toMatch(/#4 4 .*не смог проверить лог задания 41 \(HTTP 500\)/);
  });

  it('перечень заданий не прочитан — «не смог проверить»', async () => {
    const gh = fakeGithub(usualRuns(), (method, path) => (/runs\/3\/jobs/.test(path) ? { status: 502, json: null } : undefined));
    const { result, text } = await go(gh);
    expect(result.ok).toBe(false);
    expect(text).toMatch(/#3 3 .*не смог проверить задания прогона \(HTTP 502\)/);
  });

  it('удаление доходит до чтения не сразу — проба повторяется и дожидается', async () => {
    let stale = 2;
    let pauses = 0;
    const gh = fakeGithub(usualRuns(), (method, path, runs) => {
      if (method !== 'GET' || !/runs\/2\/logs$/.test(path)) return undefined;
      const gone = !runs.find((r) => r.id === 2)!.logs;
      if (gone && stale > 0) { stale -= 1; return { status: 302, json: null }; }
      return undefined;
    });
    const lines: string[] = [];
    const result = await purge({ api: gh.api, repo: REPO, order: ORDER, log: (l: string) => lines.push(l), sleep: async () => { pauses += 1; } });
    expect(result.ok).toBe(true);
    expect(pauses).toBe(2);
    expect(lines.join('\n')).toMatch(/#2 2 .*удалено/);
  });

  it('незавершённый прогон не трогается и краснит итог', async () => {
    const gh = fakeGithub([...usualRuns(), run(9, '2026-11-09T00:00:00Z', { status: 'in_progress' })]);
    const { result, text } = await go(gh);
    expect(result.ok).toBe(false);
    expect(gh.deleted()).not.toContain(9);
    expect(text).toMatch(/#9 9 .*прогон не завершён \(in_progress\)/);
  });
});

describe('удаление логов: сломанная проба не выдаётся за успех', () => {
  it('на любой запрос лога приходит 404 — контроль не проходит, ничего не удаляется', async () => {
    const gh = fakeGithub(usualRuns(), (method, path) => (method === 'GET' && /\/logs$/.test(path) ? { status: 404, json: null } : undefined));
    const { result, text } = await go(gh);
    expect(result).toMatchObject({ ok: false, stage: 'control' });
    expect(gh.deleted()).toEqual([]);
    expect(text).toContain('ни у одного свежего чужого прогона лог не отдаётся');
    expect(withLogs(gh.runs)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('контролем служит чужой прогон, а не прогон того же workflow', async () => {
    const gh = fakeGithub(usualRuns().filter((r) => r.path.endsWith(TARGET)));
    const { result, text } = await go(gh);
    expect(result).toMatchObject({ ok: false, stage: 'control' });
    expect(text).toContain('свежих чужих прогонов нет');
    expect(gh.deleted()).toEqual([]);
  });

  it('перечень свежих прогонов не прочитан — отказ до удаления', async () => {
    const gh = fakeGithub(usualRuns(), (method, path) => (path.includes('status=completed') ? { status: 0, json: null } : undefined));
    const { result } = await go(gh);
    expect(result).toMatchObject({ ok: false, stage: 'control' });
    expect(gh.deleted()).toEqual([]);
  });

  it('перечень прогонов workflow не прочитан — отказ, а не «чистить нечего»', async () => {
    const gh = fakeGithub(usualRuns(), (method, path) => (path.includes('/workflows/') ? { status: 500, json: null } : undefined));
    const { result, text } = await go(gh);
    expect(result).toMatchObject({ ok: false, stage: 'list' });
    expect(text).toContain('перечень прогонов, страница 1: HTTP 500');
    expect(gh.deleted()).toEqual([]);
  });

  it('под границу не попал ни один прогон — отказ: ноль при ожидаемой работе не успех', async () => {
    const gh = fakeGithub(usualRuns().filter((r) => r.id >= 6));
    const { result, text } = await go(gh);
    expect(result).toMatchObject({ ok: false, stage: 'empty' });
    expect(text).toContain('под границу не попал ни один');
  });

  it('у прогона не читается дата — отказ, а не тихий пропуск', async () => {
    const gh = fakeGithub([...usualRuns(), run(9, 'вчера')]);
    const { result, text } = await go(gh);
    expect(result).toMatchObject({ ok: false, stage: 'list' });
    expect(text).toContain('у 1 прогонов не читается дата');
    expect(gh.deleted()).toEqual([]);
  });
});

describe('удаление логов: сухой прогон', () => {
  it('ничего не удаляет и называет, где лог ещё лежит', async () => {
    const gh = fakeGithub(usualRuns());
    const { result, text } = await go(gh, 'dry');
    expect(result.ok).toBe(true);
    expect(gh.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(withLogs(gh.runs)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(text).toContain('План: лог есть у 4, лога уже нет у 1, не смог проверить 0. Ничего не удалялось.');
  });

  it('проба одного прогона не ответила — план красный', async () => {
    const gh = fakeGithub(usualRuns(), (method, path) => (/runs\/3\/logs$/.test(path) ? { status: 503, json: null } : undefined));
    const { result, text } = await go(gh, 'dry');
    expect(result.ok).toBe(false);
    expect(text).toMatch(/#3 3 .*не смог проверить \(HTTP 503\)/);
  });
});

describe('удаление логов: маркер', () => {
  it('без mode — сухой прогон; граница берётся из списка, а не из маркера', () => {
    expect(readOrder({ workflow: TARGET, before: '2099-01-01T00:00:00Z' })).toEqual({ ok: true, mode: 'dry', workflow: TARGET, before: BEFORE });
    expect(readOrder({ workflow: TARGET, mode: 'apply' })).toMatchObject({ ok: true, mode: 'apply', before: BEFORE });
  });

  it('workflow не из списка, чужой режим и не-объект — отказ', () => {
    for (const bad of [
      { workflow: 'ci.yml', mode: 'apply' },
      { workflow: 'toString', mode: 'apply' },
      { mode: 'apply' },
      { workflow: TARGET, mode: 'APPLY' },
      { workflow: TARGET, mode: true },
      [TARGET],
      null,
      'apply',
    ]) {
      expect(readOrder(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it('граница списка — влитие #3203: прогоны после него печатают только числа', () => {
    expect(Object.keys(PURGEABLE)).toEqual([TARGET]);
    expect(BEFORE).toBe('2026-11-10T14:44:45Z');
  });

  it('маркер в репозитории разбирается и называет workflow из списка', () => {
    const marker = JSON.parse(readFileSync(join(process.cwd(), '.github/triggers/actions-logs-purge.json'), 'utf8'));
    const order = readOrder(marker);
    expect(order).toMatchObject({ ok: true, workflow: TARGET });
    expect(String(marker.reason)).toMatch(/владел/i);
  });
});

describe('удаление логов: доступ к API', () => {
  it('за переадресацией на архив не идёт и шлёт токен заголовком', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status: 302, headers: { Location: 'https://example.invalid/archive.zip' } });
    }) as unknown as typeof fetch;
    const reply = await githubApi('t0ken', fetchStub)('GET', '/repos/o/r/actions/runs/5/logs');
    expect(reply).toEqual({ status: 302, json: null });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://api.github.com/repos/o/r/actions/runs/5/logs');
    expect(seen[0].init.redirect).toBe('manual');
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer t0ken');
  });

  it('отказ API несёт причину словами GitHub; тело переадресации не читается', async () => {
    const denied = (async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration', status: '403' }), { status: 403 })) as unknown as typeof fetch;
    expect(await githubApi('t', denied)('DELETE', '/x')).toEqual({ status: 403, json: null, message: 'Resource not accessible by integration' });
    const bare = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await githubApi('t', bare)('GET', '/x')).toEqual({ status: 404, json: null });
    const long = (async () => new Response(JSON.stringify({ message: 'я'.repeat(500) }), { status: 429 })) as unknown as typeof fetch;
    expect((await githubApi('t', long)('GET', '/x')).message).toHaveLength(200);
  });

  it('сеть не дошла или тело не JSON — status 0, а не «лога нет»', async () => {
    const down = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect(await githubApi('t', down)('GET', '/x')).toEqual({ status: 0, json: null });
    const junk = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    expect(await githubApi('t', junk)('GET', '/x')).toEqual({ status: 0, json: null });
  });
});

describe('удаление логов: workflow', () => {
  const requireCjs = createRequire(import.meta.url);
  const { load } = requireCjs('js-yaml') as { load: (src: string) => unknown };
  const src = readFileSync(join(process.cwd(), '.github/workflows/actions-logs-purge.yml'), 'utf8');
  const wf = load(src) as {
    on: { push: { branches: string[]; paths: string[] } } & Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, { permissions: Record<string, string>; 'timeout-minutes': number; steps: Array<{ run?: string; env?: Record<string, string> }> }>;
  };

  it('запускается только правкой своего маркера в main', () => {
    expect(Object.keys(wf.on)).toEqual(['push']);
    expect(wf.on.push).toEqual({ branches: ['main'], paths: ['.github/triggers/actions-logs-purge.json'] });
  });

  it('право actions: write — только у задания чистки, у workflow прав нет', () => {
    expect(wf.permissions).toEqual({});
    expect(Object.keys(wf.jobs)).toEqual(['purge']);
    expect(wf.jobs.purge.permissions).toEqual({ contents: 'read', actions: 'write' });
    expect(wf.jobs.purge['timeout-minutes']).toBeGreaterThan(0);
  });

  const step = wf.jobs.purge.steps.find((st) => st.run?.includes('scripts/actions-logs-purge.mjs'))!;

  it('зовёт скрипт чистки с токеном задания и своим маркером', () => {
    expect(step.env).toEqual({ GH_TOKEN: '${{ github.token }}', MARKER: '.github/triggers/actions-logs-purge.json' });
  });

  /** Шаг исполняется как на раннере без `shell:` — `bash -e`; вместо node — подложенная программа. */
  function runStep(stub: string) {
    const dir = mkdtempSync(join(tmpdir(), 'purge-step-'));
    writeFileSync(join(dir, 'node'), `#!/usr/bin/env bash\n${stub}\n`, { mode: 0o755 });
    const summary = join(dir, 'summary.md');
    const r = spawnSync('bash', ['-e', '-c', step.run!], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir, GH_TOKEN: 'x', MARKER: 'm' },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' };
  }

  it('отказ скрипта — шаг красный, и сводка с причиной написана', () => {
    const r = runStep("echo '#5 5 2026-11-09 schedule: НЕ удалено: лог ещё отдаётся (DELETE 403)'; echo 'Итог: удалено 0, лога уже не было 0, отказов 1, не обработано 0.'; exit 1");
    expect(r.code).toBe(1);
    expect(r.summary).toContain('НЕ удалено: лог ещё отдаётся (DELETE 403)');
    expect(r.out).toContain('Итог: удалено 0');
  });

  it('успех скрипта — шаг зелёный, сводка написана', () => {
    const r = runStep("echo 'Итог: удалено 4, лога уже не было 1, отказов 0, не обработано 0.'; exit 0");
    expect(r.code).toBe(0);
    expect(r.summary).toContain('## Удаление логов прогонов');
    expect(r.summary).toContain('Итог: удалено 4');
  });

  it('код 0 без строки итога — шаг красный: молчание не успех', () => {
    const r = runStep('exit 0');
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::скрипт вышел с кодом 0, не напечатав итога');
  });
});

describe('удаление логов: программа и её код выхода', () => {
  const SCRIPT = join(process.cwd(), 'scripts/actions-logs-purge.mjs');
  const MARKER = join(process.cwd(), '.github/triggers/actions-logs-purge.json');
  const ENV = { GITHUB_REPOSITORY: REPO, GH_TOKEN: 't', MARKER };
  const quiet = () => { const lines: string[] = []; return { lines, log: (l: string) => { lines.push(l); } }; };

  it('маркер репозитория в режиме apply: всё удалено — 0; DELETE отвергнут — 1', async () => {
    expect(JSON.parse(readFileSync(MARKER, 'utf8')).mode).toBe('apply');
    const ok = fakeGithub(usualRuns());
    const out = quiet(); const err = quiet();
    expect(await main({ env: ENV, api: ok.api, log: out.log, error: err.log, sleep: noSleep })).toBe(0);
    expect(withLogs(ok.runs)).toEqual([6, 7, 8]);
    expect(err.lines).toEqual([]);

    const denied = fakeGithub(usualRuns(), (method) => (method === 'DELETE' ? { status: 403, json: null } : undefined));
    const err2 = quiet();
    expect(await main({ env: ENV, api: denied.api, log: quiet().log, error: err2.log, sleep: noSleep })).toBe(1);
    expect(err2.lines.join('\n')).toContain('::error::чистка не доведена до конца');
  });

  it('нет окружения, маркер не читается или называет чужой workflow — 1, и ни одного запроса', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'purge-marker-'));
    const broken = join(dir, 'broken.json'); writeFileSync(broken, '{не json');
    const foreign = join(dir, 'foreign.json'); writeFileSync(foreign, JSON.stringify({ mode: 'apply', workflow: 'ci.yml' }));
    for (const [env, said] of [
      [{}, 'нужны GITHUB_REPOSITORY'],
      [{ ...ENV, GH_TOKEN: '' }, 'нужны GITHUB_REPOSITORY'],
      [{ ...ENV, MARKER: join(dir, 'нет.json') }, 'не прочитан'],
      [{ ...ENV, MARKER: broken }, 'не прочитан'],
      [{ ...ENV, MARKER: foreign }, 'нет в списке разрешённых'],
    ] as const) {
      const gh = fakeGithub(usualRuns());
      const err = quiet();
      expect(await main({ env, api: gh.api, log: quiet().log, error: err.log, sleep: noSleep }), said).toBe(1);
      expect(err.lines.join('\n'), said).toContain(said);
      expect(gh.calls, said).toEqual([]);
    }
  });

  it('файл, запущенный программой, работает и по ссылке на каталог: без окружения — код 1, а не тихий 0', () => {
    const direct = spawnSync(process.execPath, [SCRIPT], { env: {}, encoding: 'utf8' });
    expect(direct.status).toBe(1);
    expect(direct.stderr).toContain('::error::нужны GITHUB_REPOSITORY');

    const link = join(mkdtempSync(join(tmpdir(), 'purge-link-')), 'scripts');
    symlinkSync(join(process.cwd(), 'scripts'), link);
    const viaLink = spawnSync(process.execPath, [join(link, 'actions-logs-purge.mjs')], { env: {}, encoding: 'utf8' });
    expect(viaLink.status).toBe(1);
    expect(viaLink.stderr).toContain('::error::нужны GITHUB_REPOSITORY');
  });
});
