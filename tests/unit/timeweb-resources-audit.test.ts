// @vitest-environment node
/**
 * Перепись Timeweb и резервные копии базы (аудит 15.10, A01 / Д3-1, Д3-4).
 *
 * Прогон 3 переписи (02.10) спросил список копий базы только по
 * /api/v2/databases/{id}/backups и напечатал «пусто». По документации Timeweb
 * (OpenAPI timeweb.cloud/api-docs-data/bundle.json, прочитано 15.10) это
 * список S3-копий — «отдельный от /api/v1/dbs/{db_id}/backups механизм»;
 * список v1, где по схеме лежат и автокопии, не спрашивался вовсе. Вдобавок
 * разбор списка баз стоял под `except Exception: pass` (битый ответ = «баз
 * нет», и раздел копий пропадал молча), а итог аннотацией резался на 3500
 * знаках раньше раздела копий.
 *
 * Сторож судит ПОВЕДЕНИЕ (CLAUDE.md §4, 13.10): шаг workflow исполняется
 * настоящим bash с подложенным curl, который отвечает заготовленным JSON по
 * адресу и пишет журнал вызовов. Исходы:
 *  - настройки включены, список v1 пуст → «НЕ ПОДТВЕРЖДЕНЫ» и прямо сказано,
 *    что пустой список отсутствия копий не доказывает; S3-пустота — не про
 *    автокопии;
 *  - в списке есть готовая копия → «ПОДТВЕРЖДЕНЫ», дата последней ГОТОВОЙ
 *    (неудавшаяся новее не в счёт), возраст и «моложе суток»;
 *  - 401 / 500 / сеть / битый ответ → «НЕ ПРОВЕРЕНЫ», прогон красный, и
 *    нигде не написано «пусто» или «копий нет» (§4.0: «не смог» ≠ «нет»);
 *  - список баз не разобран → причина названа в итоге и аннотацией;
 *  - прежний /api/v1/dbs молчит → id берутся из документированного
 *    /api/v1/databases;
 *  - перепись только читает: в журнале curl одни GET к api.timeweb.cloud;
 *    запрет методов записи в тексте шага — регуляркой (запрет, §4);
 *  - полный итог — в сводке задачи; общая аннотация называет обрезку, раздел
 *    копий идёт своей аннотацией целиком;
 *  - запуск — кнопкой и правкой маркера в main.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow, githubTriggersOn, type PathFilter } from '../helpers/workflow-semantics';

const WF_PATH = '.github/workflows/timeweb-resources-audit.yml';
const MARKER = '.github/triggers/timeweb-resources-audit.json';
const wf = loadWorkflow(WF_PATH);
const job = wf.jobs['audit'];
const STEP = (job.steps ?? []).find((s) => s.name === 'Спросить API Timeweb (только GET)');
if (!STEP?.run) throw new Error('шаг переписи не найден');
const RUN = STEP.run;

const DB = '4129607';
const API = 'https://api.timeweb.cloud';

// curl: метод — из -X/--request, а при теле запроса — POST, как у настоящего
// curl. Ответ — по первому подходящему шаблону routes.tsv (glob bash),
// иначе 404 {}. Код neterr — «сеть не дошла»: выход 7 и 000 от -w.
const CURL_STUB = `#!/usr/bin/env bash
out=""; wfmt=""; method=""; url=""; body_sent=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w) wfmt="$2"; shift 2;;
    -X|--request) method="$2"; shift 2;;
    -d|--data|--data-raw|--data-binary|--json|-F|--form|-T|--upload-file) body_sent=1; shift 2;;
    -H|--max-time) shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
if [ -z "$method" ]; then if [ "$body_sent" = 1 ]; then method=POST; else method=GET; fi; fi
printf '%s\\t%s\\n' "$method" "$url" >> "$FAKE_DIR/curl.log"
code=404; body='{}'
while IFS=$'\\t' read -r pat c f; do
  [ -n "$pat" ] || continue
  if [[ "$url" == $pat ]]; then code="$c"; body=$(cat "$FAKE_DIR/$f"); break; fi
done < "$FAKE_DIR/routes.tsv"
if [ "$code" = neterr ]; then echo "curl: (7) Failed to connect" >&2; [ -z "$wfmt" ] || printf '000'; exit 7; fi
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
[ -z "$wfmt" ] || printf '%s' "$code"
exit 0
`;

let work: string;
let bin: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'tw-audit-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), CURL_STUB);
  chmodSync(join(bin, 'curl'), 0o755);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** [шаблон адреса, код, тело]; тело — строка как есть (битый JSON тоже). */
type Route = [string, string, string];

interface Annotation { kind: string; title: string; text: string }
interface Run {
  code: number;
  out: string;
  summary: string;
  calls: Array<{ method: string; url: string }>;
  annotations: Annotation[];
}

function runAudit(routes: Route[], opts: { token?: boolean } = {}): Run {
  const fake = mkdtempSync(join(work, 'fake-'));
  writeFileSync(
    join(fake, 'routes.tsv'),
    routes.map(([pat, code], i) => `${pat}\t${code}\tb${i}.json`).join('\n') + '\n',
  );
  routes.forEach(([, , body], i) => writeFileSync(join(fake, `b${i}.json`), body));
  const summaryFile = join(fake, 'step-summary.md');
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', ['-e', '-c', RUN], {
      cwd: fake,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? work,
        FAKE_DIR: fake,
        TW_DIR: join(fake, 'tw'),
        GITHUB_STEP_SUMMARY: summaryFile,
        TIMEWEB_TOKEN: opts.token === false ? '' : 'tw-token',
      },
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf-8') : '');
  const calls = read(join(fake, 'curl.log')).split('\n').filter(Boolean).map((l) => {
    const [method, url] = l.split('\t');
    return { method, url };
  });
  const annotations = out.split('\n').flatMap((l) => {
    const m = /^::(notice|warning|error) title=([^:]+)::(.*)$/.exec(l);
    if (!m) return [];
    const text = m[3].replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%25/g, '%');
    return [{ kind: m[1], title: m[2], text }];
  });
  return { code, out, summary: read(summaryFile), calls, annotations };
}

const json = (v: unknown) => JSON.stringify(v);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const DBS_LIST: Route = [`${API}/api/v1/dbs`, '200', json({ meta: { total: 1 }, dbs: [{ id: Number(DB), name: 'Reasonable Erinome', type: 'postgres18' }] })];
const CLUSTERS: Route = [`${API}/api/v1/databases`, '200', json({ meta: { total: 1 }, dbs: [{ id: Number(DB), is_autobackups_enabled: true, is_backup_schedule_enabled: false }] })];
const AUTO_ON: Route = [`${API}/api/v1/dbs/${DB}/auto-backups`, '200', json({ auto_backups_settings: { is_enabled: true, interval: 'day', copy_count: 1, creation_start_at: '2026-02-03T00:00:00.000Z' }, response_id: 'r' })];
const v1 = (code: string, body: string): Route => [`${API}/api/v1/dbs/${DB}/backups*`, code, body];
const V1_EMPTY = v1('200', json({ meta: { total: 0 }, backups: [], response_id: 'r' }));
const S3_EMPTY: Route = [`${API}/api/v2/databases/${DB}/backups`, '200', json({ meta: { total: 0 }, backups: [], response_id: 'r' })];

const backupsNotice = (r: Run) => r.annotations.filter((a) => a.title === 'timeweb-db-backups' && a.kind === 'notice');
const errors = (r: Run) => r.annotations.filter((a) => a.kind === 'error');

function expectOnlyGet(r: Run) {
  expect(r.calls.length, 'перепись не спросила ничего').toBeGreaterThan(0);
  const writes = r.calls.filter((c) => c.method !== 'GET');
  expect(writes, 'перепись шлёт запрос записи').toEqual([]);
  const foreign = r.calls.filter((c) => !c.url.startsWith(`${API}/api/`));
  expect(foreign, 'перепись ходит не к API Timeweb').toEqual([]);
}

describe('запуск переписи', () => {
  it('кнопкой и правкой маркера в main; маркер на месте и читается', () => {
    expect(Object.keys(wf.on)).toContain('workflow_dispatch');
    const push = wf.on['push'] as PathFilter;
    expect(push.branches).toEqual(['main']);
    expect(githubTriggersOn(push, MARKER)).toBe(true);
    expect(githubTriggersOn(push, 'lib/auth.ts')).toBe(false);
    expect(() => JSON.parse(readFileSync(join(process.cwd(), MARKER), 'utf-8'))).not.toThrow();
  });

  it('без токена — красный и ничего не спрошено', () => {
    const r = runAudit([], { token: false });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/::error::TIMEWEB_TOKEN не задан/);
    expect(r.calls).toEqual([]);
  });
});

describe('только чтение', () => {
  it('в тексте шага нет методов и тел записи (запрет)', () => {
    const code = RUN.replace(/^[ \t]*#.*$/gm, '').replace(/\\\n/g, ' ');
    const curls = code.split('\n').filter((l) => /\bcurl\b/.test(l));
    expect(curls.length, 'curl в шаге не найден — запрет судил бы пустоту').toBeGreaterThan(0);
    for (const l of curls) {
      expect(l).not.toMatch(/\s(?:-X|--request|-d|--data(?:-raw|-binary|-urlencode)?|--json|-F|--form|-T|--upload-file)(?=[\s=]|$)/);
    }
    expect(code).not.toMatch(/\s(?:-X|--request)(?=[\s=]|$)/);
    expect(code).not.toMatch(/\b(?:wget|urllib|requests\.|http\.client|gh api)\b/);
  });
});

describe('резервные копии базы', () => {
  it('настройки включены, список v1 пуст → НЕ ПОДТВЕРЖДЕНЫ, и пустота не выдаётся за «копий нет»', () => {
    const r = runAudit([DBS_LIST, CLUSTERS, AUTO_ON, V1_EMPTY, S3_EMPTY]);
    expectOnlyGet(r);
    expect(r.code).toBe(0);
    // Спрошены ОБА списка копий: v1 (там автокопии) и v2 (S3).
    expect(r.calls.map((c) => c.url)).toContain(`${API}/api/v1/dbs/${DB}/backups?limit=100`);
    expect(r.calls.map((c) => c.url)).toContain(`${API}/api/v2/databases/${DB}/backups`);
    expect(r.calls.map((c) => c.url)).toContain(`${API}/api/v1/dbs/${DB}/auto-backups`);
    expect(r.summary).toMatch(/- автокопии: включены, интервал 'day', хранится копий 1/);
    expect(r.summary).toMatch(/ИТОГ базы 4129607: НЕ ПОДТВЕРЖДЕНЫ/);
    expect(r.summary).toMatch(/Пустой список ещё не доказывает отсутствия копий/);
    expect(r.summary).toMatch(/S3-копии \(v2\): 0 — это копии в объектном хранилище; об автокопиях пустота здесь не говорит/);
    expect(r.summary).not.toMatch(/ИТОГ базы 4129607: ПОДТВЕРЖДЕНЫ/);
    expect(r.summary).not.toMatch(/копий нет[^»]/);
    expect(r.annotations.some((a) => a.kind === 'warning' && /НЕ ПОДТВЕРЖДЕНЫ/.test(a.text))).toBe(true);
    expect(errors(r)).toEqual([]);
  });

  it('в списке есть готовая копия → ПОДТВЕРЖДЕНЫ по последней ГОТОВОЙ, с возрастом', () => {
    const fresh = hoursAgo(5);
    const r = runAudit([DBS_LIST, CLUSTERS, AUTO_ON, S3_EMPTY, v1('200', json({
      meta: { total: 3 },
      backups: [
        { id: 3, name: 'b3', type: 'auto', status: 'fail', size: 0, created_at: hoursAgo(1), comment: null, progress: 0 },
        { id: 2, name: 'b2', type: 'auto', status: 'done', size: 612, created_at: fresh, comment: null, progress: 0 },
        { id: 1, name: 'b1', type: 'manual', status: 'done', size: 600, created_at: hoursAgo(72), comment: null, progress: 0 },
      ],
    }))]);
    expectOnlyGet(r);
    expect(r.code).toBe(0);
    expect(r.summary).toContain(`ИТОГ базы 4129607: ПОДТВЕРЖДЕНЫ — автокопии включены, интервал 'day', хранится копий 1; последняя готовая ${fresh}`);
    expect(r.summary).toMatch(/type='auto', 612 МБ\), возраст 5\.\d ч, моложе суток: да; копий в списке v1: 3; S3-копий: 0/);
    expect(r.summary).toMatch(/- копии \(v1\): в ответе 3, meta\.total=3/);
    expect(r.summary).toMatch(/is_autobackups_enabled=True · is_backup_schedule_enabled=False/);
    expect(errors(r)).toEqual([]);
    expect(backupsNotice(r)[0]?.text).toContain('ИТОГ базы 4129607: ПОДТВЕРЖДЕНЫ');
  });

  it('готовая копия старше суток → ПОДТВЕРЖДЕНЫ, но «моложе суток: нет» и предупреждение', () => {
    const r = runAudit([DBS_LIST, CLUSTERS, AUTO_ON, S3_EMPTY, v1('200', json({
      meta: { total: 1 },
      backups: [{ id: 1, name: 'b1', type: 'auto', status: 'done', size: 612, created_at: hoursAgo(30) }],
    }))]);
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/моложе суток: нет/);
    expect(r.annotations.some((a) => a.kind === 'warning' && /старше суток/.test(a.text))).toBe(true);
  });

  it.each([
    ['401 на списке копий', [AUTO_ON, v1('401', json({ status_code: 401, error_code: 'unauthorized' }))], /НЕ ПРОВЕРЕНЫ — список копий: HTTP 401/],
    ['500 на списке копий', [AUTO_ON, v1('500', json({ status_code: 500 }))], /НЕ ПРОВЕРЕНЫ — список копий: HTTP 500/],
    ['500 на настройках автокопий', [[`${API}/api/v1/dbs/${DB}/auto-backups`, '500', '{}'] as Route, V1_EMPTY], /НЕ ПРОВЕРЕНЫ — настройки автокопий: HTTP 500/],
    ['сеть не дошла до списка', [AUTO_ON, v1('neterr', '')], /НЕ ПРОВЕРЕНЫ — список копий: HTTP 000\./],
    ['битый ответ списка при 200', [AUTO_ON, v1('200', '<html>шлюз</html>')], /НЕ ПРОВЕРЕНЫ — список копий: ответ HTTP 200 не разобран/],
  ])('%s → НЕ ПРОВЕРЕНЫ, прогон красный, «пусто» не сказано', (_name, extra, verdict) => {
    const r = runAudit([DBS_LIST, CLUSTERS, S3_EMPTY, ...(extra as Route[])]);
    expectOnlyGet(r);
    expect(r.code).not.toBe(0);
    expect(r.summary).toMatch(verdict);
    expect(r.summary).toMatch(/Это «не смог прочитать», а не «копий нет»/);
    expect(r.summary).not.toMatch(/НЕ ПОДТВЕРЖДЕНЫ|Пустой список|ИТОГ базы 4129607: ПОДТВЕРЖДЕНЫ/);
    expect(r.summary).not.toMatch(/HTTP 000000/);
    expect(errors(r).some((a) => a.title === 'timeweb-db-backups' && verdict.test(a.text))).toBe(true);
  });

  it('список баз не разобран → причина названа, копии «НЕ ПРОВЕРЕНЫ», прогон красный', () => {
    const r = runAudit([
      [`${API}/api/v1/dbs`, '200', '{"dbs": [ обрыв'],
      [`${API}/api/v1/databases`, '200', '{"dbs": [ обрыв'],
    ]);
    expectOnlyGet(r);
    expect(r.code).not.toBe(0);
    expect(r.summary).toMatch(/НЕ ПРОВЕРЕНЫ: ни одной базы не прочитано \(dbs: ответ не разобран: JSONDecodeError/);
    expect(r.summary).toMatch(/## Отказы разбора списков\n- databases: ответ не разобран: JSONDecodeError[^\n]*\n- dbs: ответ не разобран/);
    expect(r.annotations.some((a) => a.kind === 'warning' && /^dbs: ответ не разобран/.test(a.text))).toBe(true);
    expect(r.calls.some((c) => /\/backups/.test(c.url)), 'копии спрошены у базы, которой не прочитали').toBe(false);
  });

  it('прежний /api/v1/dbs молчит (404) → id из документированного /api/v1/databases', () => {
    const r = runAudit([CLUSTERS, AUTO_ON, V1_EMPTY, S3_EMPTY]);
    expectOnlyGet(r);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.url)).toContain(`${API}/api/v1/dbs/${DB}/backups?limit=100`);
    expect(r.summary).toMatch(/### База 4129607/);
    expect(r.summary).toMatch(/- dbs: HTTP 404/);
  });

  it('автокопии выключены → так и сказано, с предупреждением', () => {
    const r = runAudit([DBS_LIST, CLUSTERS, S3_EMPTY, V1_EMPTY,
      [`${API}/api/v1/dbs/${DB}/auto-backups`, '200', json({ auto_backups_settings: { is_enabled: false } })]]);
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/- автокопии: ВЫКЛЮЧЕНЫ \(is_enabled=False\)/);
    expect(r.annotations.some((a) => a.kind === 'warning' && /автокопии выключены/.test(a.text))).toBe(true);
  });
});

describe('итог доходит целиком', () => {
  it('раздел копий длиннее 3500 знаков — аннотация называет обрезку и сохраняет итог по базе', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: i, type: `manual-${'x'.repeat(180)}`, status: 'done', size: 10, created_at: hoursAgo(30 + i) }));
    const r = runAudit([DBS_LIST, CLUSTERS, AUTO_ON, v1('200', json({ meta: { total: 25 }, backups: many, response_id: 'r' })), S3_EMPTY]);
    expect(r.code).toBe(0);
    const backups = backupsNotice(r);
    expect(backups).toHaveLength(1);
    expect(backups[0].text.length).toBeLessThanOrEqual(3500);
    expect(backups[0].text).toMatch(/… обрезано: раздел \d+ знаков, полный — сводка задачи \(Summary\) и лог шага/);
    expect(backups[0].text).toMatch(/ИТОГ базы 4129607: ПОДТВЕРЖДЕНЫ[^\n]*S3-копий: 0$/);
    expect(r.summary).toMatch(/и ещё 5/);
  });


  it('сводка задачи — полный итог; общая аннотация называет обрезку; раздел копий — своей аннотацией', () => {
    const servers = Array.from({ length: 120 }, (_, i) => ({ id: i, name: `server-${i}`, status: 'on', os: { name: 'ubuntu' }, preset_id: 1, location: 'ru-1' }));
    const r = runAudit([DBS_LIST, CLUSTERS, AUTO_ON, V1_EMPTY, S3_EMPTY, [`${API}/api/v1/servers`, '200', json({ servers })]]);
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/## Перепись ресурсов Timeweb/);
    expect(r.summary).toMatch(/server-119/);
    expect(r.summary).toMatch(/ИТОГ базы 4129607: НЕ ПОДТВЕРЖДЕНЫ/);
    expect(r.summary).toMatch(/## Коды ответов по разделам/);
    const general = r.annotations.find((a) => a.title === 'timeweb-resources-audit' && a.kind === 'notice');
    expect(general?.text).toMatch(/… обрезано: показано 3500 из \d+ знаков\. Полный итог — сводка задачи \(Summary\) и лог шага/);
    expect(general?.text).not.toMatch(/ИТОГ базы/);
    const backups = backupsNotice(r);
    expect(backups).toHaveLength(1);
    expect(backups[0].text).toMatch(/^## Резервные копии базы/);
    expect(backups[0].text).toMatch(/ИТОГ базы 4129607: НЕ ПОДТВЕРЖДЕНЫ[^\n]*S3-копий: 0$/);
  });
});
