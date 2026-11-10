#!/usr/bin/env node
/**
 * Удаление логов прогонов GitHub Actions, в которые попало лишнее.
 *
 * Повод (10.11, разбор #3110): шаг «живые вопросы» в cron-kuzmich-eval.yml
 * до #3203 печатал ответ роута целиком — сообщения туристов в открытом логе
 * публичного репозитория. #3203 закрыл новые прогоны, прежние остались.
 * Слово владельца 10.11: «удаляй».
 *
 * У интеграции агента права `actions: write` нет (DELETE …/logs — 403),
 * поэтому удаляет workflow actions-logs-purge.yml своим токеном, по маркеру.
 *
 * Правила:
 *  - что можно чистить, записано ЗДЕСЬ (PURGEABLE): файл workflow и граница по
 *    времени. Маркер выбирает из списка и режим; границу он не двигает;
 *  - «логов нет» — исход, которому верят только при живой контрольной пробе:
 *    тот же запрос к свежему чужому прогону обязан ответить «лог есть». Иначе
 *    сломанная проба читалась бы как «всё удалено» (CLAUDE.md §4.0);
 *  - удалено — это когда лог перестал отдаваться и у прогона, и у каждого его
 *    задания, а не когда DELETE ответил 204;
 *  - в вывод идут номер, id, дата и исход. Содержимое логов не скачивается:
 *    запросы не идут за переадресацией на архив.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Что разрешено чистить: прогоны этого workflow, созданные раньше границы. */
export const PURGEABLE = Object.freeze({
  'cron-kuzmich-eval.yml': Object.freeze({
    // Влитие #3203 (24b6695ed): с него шаг печатает только числа.
    before: '2026-11-10T14:44:45Z',
    why: 'до #3203 шаг «живые вопросы» печатал ответ роута целиком — сообщения туристов',
  }),
});

const GONE = new Set([404, 410]);
const VERIFY_TRIES = 4;
const VERIFY_PAUSE_MS = 2000;
// Три прогона подряд, где DELETE отвергнут по праву или по лимиту, — отказ не
// случайный: дальше стучать в API незачем, остальное названо «не обработано».
const SYSTEMIC = new Set([401, 403, 429]);
const ABORT_AFTER_SYSTEMIC = 3;
const PAGE = 100;
const MAX_PAGES = 20;

/** Разбор маркера: режим и workflow из списка. Умолчание режима — dry. */
export function readOrder(marker) {
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) {
    return { ok: false, error: 'маркер — не объект' };
  }
  const mode = marker.mode === undefined ? 'dry' : marker.mode;
  if (mode !== 'dry' && mode !== 'apply') {
    return { ok: false, error: `mode: ждём dry или apply, пришло ${JSON.stringify(mode)}` };
  }
  const workflow = marker.workflow;
  if (typeof workflow !== 'string' || !Object.hasOwn(PURGEABLE, workflow)) {
    return { ok: false, error: `workflow ${JSON.stringify(workflow)} нет в списке разрешённых к чистке` };
  }
  return { ok: true, mode, workflow, before: PURGEABLE[workflow].before };
}

/** 302 — лог отдаётся (ссылка на архив); 404 и 410 — лога нет; прочее — не знаем. */
function logsState(status) {
  if (status === 302 || status === 200) return 'present';
  return GONE.has(status) ? 'gone' : 'unknown';
}

/** Код ответа с причиной отказа от GitHub, если он её назвал: «403: Resource not accessible…». */
const said = (r) => (r.message ? `${r.status}: ${r.message}` : `${r.status}`);

async function probe(api, path) {
  const r = await api('GET', path);
  return { state: logsState(r.status), status: r.status, message: r.message };
}

/** Проба с повтором: удаление у GitHub доходит до чтения не мгновенно. */
async function probeUntilGone(api, path, sleep) {
  let last = await probe(api, path);
  for (let i = 1; i < VERIFY_TRIES && last.state === 'present'; i++) {
    await sleep(VERIFY_PAUSE_MS);
    last = await probe(api, path);
  }
  return last;
}

/** Свежий прогон ДРУГОГО workflow обязан отдавать лог — иначе пробе не верим. */
async function controlProbe(api, repo, workflow) {
  const r = await api('GET', `/repos/${repo}/actions/runs?status=completed&per_page=30`);
  if (r.status !== 200 || !Array.isArray(r.json?.workflow_runs)) {
    return { ok: false, detail: `перечень свежих прогонов: HTTP ${said(r)}` };
  }
  const others = r.json.workflow_runs
    .filter((run) => !String(run.path ?? '').endsWith(`/${workflow}`))
    .slice(0, 5);
  for (const run of others) {
    const p = await probe(api, `/repos/${repo}/actions/runs/${run.id}/logs`);
    if (p.state === 'present') return { ok: true, detail: `прогон ${run.id}` };
  }
  return {
    ok: false,
    detail: others.length === 0 ? 'свежих чужих прогонов нет' : 'ни у одного свежего чужого прогона лог не отдаётся',
  };
}

async function listTargets(api, repo, workflow, before) {
  const limit = Date.parse(before);
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await api('GET', `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=${PAGE}&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.json?.workflow_runs)) {
      return { ok: false, detail: `перечень прогонов, страница ${page}: HTTP ${said(r)}` };
    }
    all.push(...r.json.workflow_runs);
    if (r.json.workflow_runs.length < PAGE) {
      const undated = all.filter((run) => Number.isNaN(Date.parse(run.created_at)));
      if (undated.length > 0) return { ok: false, detail: `у ${undated.length} прогонов не читается дата` };
      return { ok: true, total: all.length, runs: all.filter((run) => Date.parse(run.created_at) < limit) };
    }
  }
  return { ok: false, detail: `перечень не дочитан за ${MAX_PAGES} страниц` };
}

async function purgeRun(api, repo, run, apply, sleep) {
  const base = `/repos/${repo}/actions/runs/${run.id}`;
  const row = { number: run.run_number, id: run.id, date: String(run.created_at).slice(0, 10), event: run.event };
  if (run.status !== 'completed') return { ...row, ok: false, outcome: `прогон не завершён (${run.status})` };

  const had = await probe(api, `${base}/logs`);
  if (!apply) {
    if (had.state === 'present') return { ...row, ok: true, outcome: 'лог есть' };
    if (had.state === 'gone') return { ...row, ok: true, outcome: 'лога уже нет' };
    return { ...row, ok: false, outcome: `не смог проверить (HTTP ${said(had)})` };
  }

  // DELETE уходит всегда: проба «лога нет» могла ошибиться, а лишний запрос
  // на удаление уже удалённого ничего не портит. Судит не его код, а чтение.
  const del = await api('DELETE', `${base}/logs`);
  const systemic = SYSTEMIC.has(del.status);
  const after = await probeUntilGone(api, `${base}/logs`, sleep);
  if (after.state === 'present') {
    return { ...row, ok: false, systemic, outcome: `НЕ удалено: лог ещё отдаётся (DELETE ${said(del)})` };
  }
  if (after.state === 'unknown') {
    return {
      ...row, ok: false, systemic,
      outcome: `не смог проверить после запроса на удаление (HTTP ${said(after)}, DELETE ${said(del)})`,
    };
  }

  const jobs = await api('GET', `${base}/jobs?filter=all&per_page=${PAGE}`);
  if (jobs.status !== 200 || !Array.isArray(jobs.json?.jobs)) {
    return { ...row, ok: false, outcome: `не смог проверить задания прогона (HTTP ${said(jobs)})` };
  }
  for (const job of jobs.json.jobs) {
    const j = await probeUntilGone(api, `/repos/${repo}/actions/jobs/${job.id}/logs`, sleep);
    if (j.state === 'present') return { ...row, ok: false, outcome: `НЕ удалено: лог задания ${job.id} ещё отдаётся` };
    if (j.state === 'unknown') return { ...row, ok: false, outcome: `не смог проверить лог задания ${job.id} (HTTP ${said(j)})` };
  }

  if (had.state === 'present') return { ...row, ok: true, outcome: `удалено (DELETE ${del.status})` };
  if (had.state === 'gone') return { ...row, ok: true, outcome: 'лога уже не было' };
  return { ...row, ok: true, outcome: `лога нет (до удаления проба не ответила: HTTP ${had.status})` };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Прогон чистки. api(method, path) → { status, json }: сеть не дошла — status 0.
 * Возвращает { ok, stage, rows }; ok — всё, что под границей, без лога и это
 * прочитано обратно (apply), либо план составлен без «не смог» (dry).
 */
export async function purge({ api, repo, order, log = () => {}, sleep = defaultSleep }) {
  const apply = order.mode === 'apply';
  log(`Режим: ${order.mode}. Workflow: ${order.workflow}. Под чистку — прогоны раньше ${order.before}.`);
  log(`Причина: ${PURGEABLE[order.workflow].why}.`);

  const control = await controlProbe(api, repo, order.workflow);
  if (!control.ok) {
    log(`ОТКАЗ: контрольная проба не прошла — ${control.detail}. Ответу «лога нет» верить нельзя; ничего не удалялось.`);
    return { ok: false, stage: 'control', rows: [] };
  }
  log(`Контрольная проба: лог свежего чужого прогона отдаётся (${control.detail}).`);

  const listed = await listTargets(api, repo, order.workflow, order.before);
  if (!listed.ok) {
    log(`ОТКАЗ: ${listed.detail}. Ничего не удалялось.`);
    return { ok: false, stage: 'list', rows: [] };
  }
  if (listed.runs.length === 0) {
    log(`ОТКАЗ: из ${listed.total} прогонов под границу не попал ни один — чистить нечего, а прогоны ждали.`);
    return { ok: false, stage: 'empty', rows: [] };
  }
  log(`Прогонов у workflow: ${listed.total}, под границей: ${listed.runs.length}.`);

  const rows = [];
  let systemicInRow = 0;
  for (const run of listed.runs) {
    const row = await purgeRun(api, repo, run, apply, sleep);
    rows.push(row);
    log(`#${row.number} ${row.id} ${row.date} ${row.event}: ${row.outcome}`);
    systemicInRow = row.systemic ? systemicInRow + 1 : 0;
    if (systemicInRow >= ABORT_AFTER_SYSTEMIC) break;
  }

  const failed = rows.filter((row) => !row.ok);
  const skipped = listed.runs.length - rows.length;
  if (skipped > 0) {
    log(`ОСТАНОВЛЕНО: ${ABORT_AFTER_SYSTEMIC} раза подряд DELETE отвергнут по праву или лимиту — отказ не случайный. Не обработано прогонов: ${skipped}.`);
  }
  const count = (re) => rows.filter((row) => re.test(row.outcome)).length;
  if (apply) {
    log(`Итог: удалено ${count(/^удалено/)}, лога уже не было ${count(/^лога (уже не было|нет)/)}, отказов ${failed.length}, не обработано ${skipped}.`);
  } else {
    log(`План: лог есть у ${count(/^лог есть/)}, лога уже нет у ${count(/^лога уже нет/)}, не смог проверить ${failed.length}. Ничего не удалялось.`);
  }
  return { ok: failed.length === 0 && skipped === 0, stage: 'runs', rows };
}

/** Доступ к API GitHub. За переадресацией не идёт: архив лога не скачивается. */
export function githubApi(token, fetchImpl = fetch) {
  return async (method, path) => {
    try {
      const res = await fetchImpl(`https://api.github.com${path}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'actions-logs-purge',
        },
      });
      if (res.status === 200) return { status: 200, json: JSON.parse(await res.text()) };
      if (res.status < 400) {
        // 302 — ссылка на архив лога: тело не читается.
        await res.body?.cancel();
        return { status: res.status, json: null };
      }
      // Отказ API называет причину полем message. Это слова GitHub, не лог:
      // без них «DELETE 403» не отличить «нет права» от «лимит запросов».
      const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(await res.text())?.[1]?.slice(0, 200);
      return { status: res.status, json: null, ...(message ? { message } : {}) };
    } catch (error) {
      // Сеть, таймаут или тело не JSON: «не дошли». Вызывающий читает это как
      // «не смог», а не как «лога нет».
      console.error(`запрос ${method} ${path} не выполнен: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 0, json: null };
    }
  };
}

/**
 * Запуск из workflow: окружение и маркер → код выхода. 0 — только когда чистка
 * доведена до конца и это прочитано обратно; всё прочее — 1.
 */
export async function main({
  env = process.env,
  api,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
  sleep,
} = {}) {
  const { GITHUB_REPOSITORY: repo, GH_TOKEN: token, MARKER: markerPath } = env;
  if (!repo || !token || !markerPath) {
    error('::error::нужны GITHUB_REPOSITORY, GH_TOKEN и MARKER');
    return 1;
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch (cause) {
    error(`::error::маркер ${markerPath} не прочитан: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  const order = readOrder(marker);
  if (!order.ok) {
    error(`::error::${order.error}`);
    return 1;
  }
  const result = await purge({ api: api ?? githubApi(token), repo, order, log, ...(sleep ? { sleep } : {}) });
  if (!result.ok) error('::error::чистка не доведена до конца — см. строки выше');
  return result.ok ? 0 : 1;
}

// Запущен ли файл как программа. Пути сравниваются развёрнутыми: запуск по
// ссылке на каталог иначе молча ничего бы не сделал и вышел с кодом 0.
const invokedAs = process.argv[1];
if (invokedAs && existsSync(invokedAs) && realpathSync(invokedAs) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
