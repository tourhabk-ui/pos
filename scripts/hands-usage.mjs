/**
 * Расход «рук» — claude-code-action — в книги платформы `llm_usage_log`.
 *
 * Аудит 15.10, находка AC-1, решение «б» по карт-бланшу владельца.
 *
 * ── Что было ─────────────────────────────────────────────────────────────
 *
 * Четыре руки — claude.yml, issue-triage.yml, ci-sweeper.yml,
 * weekly-chronicle.yml — считают на раннере GitHub ключом Anthropic из
 * секретов репозитория. Их расход не попадал в книги НИКАК: модель зовёт сам
 * экшен, мимо `logLLMUsage`, а БД Timeweb с раннера закрыта файрволом.
 * `/api/cron/llm-budget-check` суммирует `llm_usage_log` — значит по тратам
 * рук дневной бюджет не мог сработать ни при каком `AI_DAILY_BUDGET_USD`. Тот
 * же провал, что у судьи эволюции 19.09 (CLAUDE.md §8, «Расход, потраченный на
 * раннере…»), только без всякого стока вовсе.
 *
 * ── Как устроено ─────────────────────────────────────────────────────────
 *
 * Экшен оставляет файл выполнения (выход `execution_file`; на нашем пине —
 * `$RUNNER_TEMP/claude-execution-output.json`, base-action/src/execution-file.ts):
 * JSON-массив сообщений SDK. Последнее сообщение `type: "result"` несёт
 * `modelUsage` — по моделям: `inputTokens`, `outputTokens`,
 * `cacheCreationInputTokens`, `cacheReadInputTokens` — и `total_cost_usd`.
 * Прогон, оборванный до итога (таймаут, ошибка SDK), итога не имеет; тогда
 * расход собирается из ответов модели (`type: "assistant"`, `message.usage`),
 * по одному на `message.id`: при потоковой выдаче один ответ приходит
 * несколькими сообщениями с одной и той же usage, и сумма по сообщениям
 * считала бы его дважды. Иной формы — предупреждение «не разобран», а не
 * молчание и не ноль.
 *
 * До учёта файл выполнения целиком НЕ доезжает (поправка ревью AC-1): это
 * транскрипт агента со всеми выводами инструментов, а артефакт публичного
 * репозитория скачивает любой, и маски секретов в файле артефакта нет — она
 * есть только в логе. Работа руки выжимает из него белым списком только то,
 * что читает разбор ниже: `type`, `total_cost_usd`, `modelUsage` с четырьмя
 * счётчиками, у ответа модели — `message.id`, `message.model` и четыре
 * счётчика `message.usage` (шаг «Выжимка расхода руки» в каждом из четырёх
 * workflow). Форма та же, что у файла выполнения, и разбор их не различает.
 * Не прочёл jq файл — выжимка несёт метку `{"hands_usage":"unreadable"}`, и
 * разбор называет расход неразобранным, а не потерянным.
 *
 * Строки уходят на прод (`POST /api/admin/llm-usage/report`) с `CRON_SECRET`.
 * ЦЕНУ СЧИТАЕТ СЕРВЕР, включая кэш. `total_cost_usd` экшена в книги не
 * пишется — это заявление звонящего о своих расходах, а книги для того и
 * нужны, чтобы такие заявления проверять. Оно печатается в сводку прогона
 * рядом с ценой книг, и расхождение называется вслух.
 *
 * ── Почему отдельная работа, а не шаг в работе руки ──────────────────────
 *
 * У агента руки есть Bash на том же раннере, а триаж читает тексты ЧУЖИХ
 * issues. Секрет в следующем шаге той же работы досягаем для агента: шаг
 * исполняет файл, который агент мог переписать, а процесс, оставленный
 * агентом, переживает его шаг. `CRON_SECRET` открывает `/api/admin/*` на проде
 * (§7), и подсказка в теле issue не должна до него дотягиваться. Поэтому
 * выжимка уезжает артефактом, а учёт идёт отдельной работой на чистом
 * раннере, со скриптом из `main`. Агент может подделать ЧИСЛА в своём файле —
 * это данные, сервер их проверяет схемой; секрета он не видит.
 *
 * Адрес прода ЗАШИТ, как в `lib/ai/usage-sink.ts`: секрет ходит на один
 * известный адрес (урок 08.08 — правило, зависящее от конфига, не защита).
 *
 * Запуск — `node scripts/hands-usage.mjs --run`; только Node, без
 * зависимостей: в работе учёта нет ни `npm ci`, ни tsx. Сторож —
 * tests/unit/llm-usage-reaches-books.test.ts (разбор и отправка — исполнением).
 */

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';

const PROD_BASE = 'https://vedarai.ru';
const REPORT_PATH = '/api/admin/llm-usage/report';

/** Файл выполнения больше этого — не читаем: память раннера дороже разбора. */
export const MAX_EXECUTION_BYTES = 256 * 1024 * 1024;

/** Книги и заявление экшена разошлись больше чем на долю — говорим вслух. */
export const DRIFT_WARN_SHARE = 0.25;

/**
 * Руки зовут Anthropic напрямую (`anthropic_api_key` в каждом из четырёх
 * workflow; держит tests/unit/issue-hand-model-pinned.test.ts). Ключ журнала —
 * `anthropic:<модель>`, как у прямых вызовов в `logLLMUsage`: по нему сервер
 * находит цену и узнаёт вендора для множителей кэша.
 */
export const VENDOR_PREFIX = 'anthropic:';

/** @param {unknown} v */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Целое неотрицательное — или null («не сообщено», не ноль). @param {unknown} v */
function tokenCount(v) {
  return Number.isInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : null;
}

/** Экранирование данных в команде workflow: строка не должна начать новую команду. */
export function escapeAnnotation(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * @typedef {{
 *   model: string,
 *   prompt_tokens: number,
 *   completion_tokens: number,
 *   cache_creation_tokens: number | null,
 *   cache_read_tokens: number | null,
 * }} UsageRow
 * @typedef {{
 *   form: 'result' | 'assistant' | 'unknown',
 *   rows: UsageRow[],
 *   reportedCostUsd: number | null,
 *   reason: string | null,
 * }} Parsed
 */

/** @param {string} reason @param {number | null} reportedCostUsd @returns {Parsed} */
function unknownForm(reason, reportedCostUsd = null) {
  return { form: 'unknown', rows: [], reportedCostUsd, reason };
}

/** null + null = null; иначе сумма известного. @param {number | null} a @param {number | null} b */
function addMaybe(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/**
 * Разбор файла выполнения (или его выжимки той же формы): строки расхода по
 * моделям.
 *
 * @param {unknown} messages — содержимое файла, уже разобранное как JSON
 * @returns {Parsed}
 */
export function parseExecution(messages) {
  // Метка выжимки: файл выполнения был, но jq в работе руки его не прочёл.
  // Причина — постоянная строка здесь, а не текст из артефакта.
  if (isObj(messages) && messages.hands_usage === 'unreadable') {
    return unknownForm('выжимка в работе руки не собралась: jq не прочёл файл выполнения (подробности в логе работы руки)');
  }
  if (!Array.isArray(messages)) {
    return unknownForm('файл выполнения — не массив сообщений');
  }

  let result = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (isObj(m) && m.type === 'result') { result = m; break; }
  }
  const reportedCostUsd = result && typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd)
    ? result.total_cost_usd
    : null;

  // 1. Итог прогона: modelUsage по моделям — включая служебные вызовы, которых
  //    нет среди ответов в файле.
  if (result && isObj(result.modelUsage) && Object.keys(result.modelUsage).length > 0) {
    /** @type {UsageRow[]} */
    const rows = [];
    for (const [model, u] of Object.entries(result.modelUsage)) {
      const input = isObj(u) ? tokenCount(u.inputTokens) : null;
      const output = isObj(u) ? tokenCount(u.outputTokens) : null;
      if (!model || input === null || output === null) {
        return unknownForm(`modelUsage «${model}»: нет целых inputTokens/outputTokens`, reportedCostUsd);
      }
      rows.push({
        model: `${VENDOR_PREFIX}${model}`,
        prompt_tokens: input,
        completion_tokens: output,
        cache_creation_tokens: tokenCount(u.cacheCreationInputTokens),
        cache_read_tokens: tokenCount(u.cacheReadInputTokens),
      });
    }
    return { form: 'result', rows, reportedCostUsd, reason: null };
  }

  // 2. Итога нет (обрыв) — ответы модели, по одному на message.id: последнее
  //    сообщение ответа несёт его окончательную usage.
  /** @type {Map<string, { model: string, usage: Record<string, unknown> }>} */
  const byResponse = new Map();
  let anonymous = 0;
  for (const m of messages) {
    if (!isObj(m) || m.type !== 'assistant' || !isObj(m.message)) continue;
    const msg = m.message;
    if (typeof msg.model !== 'string' || !msg.model || !isObj(msg.usage)) continue;
    const id = typeof msg.id === 'string' && msg.id ? msg.id : `#${anonymous++}`;
    byResponse.set(id, { model: msg.model, usage: msg.usage });
  }
  if (byResponse.size === 0) {
    return unknownForm(
      result
        ? 'итог прогона без modelUsage, и ни одного ответа модели с usage'
        : 'нет ни итога прогона, ни ответов модели с usage',
      reportedCostUsd,
    );
  }

  /** @type {Map<string, UsageRow>} */
  const perModel = new Map();
  for (const { model, usage } of byResponse.values()) {
    const input = tokenCount(usage.input_tokens);
    const output = tokenCount(usage.output_tokens);
    if (input === null || output === null) {
      return unknownForm(`ответ модели «${model}»: нет целых input_tokens/output_tokens`, reportedCostUsd);
    }
    const key = `${VENDOR_PREFIX}${model}`;
    const acc = perModel.get(key) ?? {
      model: key,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_creation_tokens: null,
      cache_read_tokens: null,
    };
    acc.prompt_tokens += input;
    acc.completion_tokens += output;
    acc.cache_creation_tokens = addMaybe(acc.cache_creation_tokens, tokenCount(usage.cache_creation_input_tokens));
    acc.cache_read_tokens = addMaybe(acc.cache_read_tokens, tokenCount(usage.cache_read_input_tokens));
    perModel.set(key, acc);
  }
  return { form: 'assistant', rows: [...perModel.values()], reportedCostUsd, reason: null };
}

/** @param {UsageRow} r */
function isEmptyRow(r) {
  return r.prompt_tokens === 0 && r.completion_tokens === 0
    && (r.cache_creation_tokens ?? 0) === 0 && (r.cache_read_tokens ?? 0) === 0;
}

/** @param {number | null} n */
function fmt(n) {
  return n === null ? 'не сообщено' : String(n);
}

/** @param {number | null} usd */
function fmtUsd(usd) {
  return usd === null ? 'не названа' : `$${usd.toFixed(4)}`;
}

/**
 * Учёт одного прогона руки. Возвращает строки для stdout (команды
 * ::error:: / ::warning:: / ::notice::), сводку markdown и код выхода.
 *
 * Исходы:
 *   - файла нет, а экшен о нём и не сообщал — рука не дошла до модели или не
 *     оставила следа: «расход неизвестен», предупреждение, выход 0;
 *   - экшен сообщил файл, а до учёта он не доехал — потеря: ошибка, выход 1;
 *   - файл не разобран — предупреждение «не разобран», выход 0: о расходе мы
 *     не знаем, и это сказано, а не выдано за ноль;
 *   - прод не принял (не 200, в том числе 207) — ошибка, выход 1.
 *
 * @param {{
 *   env: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ out: string[], summary: string, exitCode: number }>}
 */
export async function runHandsUsage({ env, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const summary = ['### Расход руки — в книги'];
  const agentId = env.AGENT_ID ?? '';
  const file = env.EXECUTION_FILE ?? '';
  const reportedByAction = Boolean(env.HAND_EXECUTION_FILE);

  const finish = (exitCode) => ({ out, summary: summary.join('\n'), exitCode });
  const warn = (msg) => { out.push(`::warning::${escapeAnnotation(msg)}`); summary.push(`- ${msg}`); };
  const fail = (msg) => { out.push(`::error::${escapeAnnotation(msg)}`); summary.push(`- **${msg}**`); };

  if (!agentId) {
    fail('AGENT_ID не задан — не знаю, чей это расход; шаг учёта настроен неверно');
    return finish(1);
  }

  if (!file || !existsSync(file)) {
    if (reportedByAction) {
      fail(`${agentId}: экшен оставил файл выполнения, а до учёта он не доехал — расход прогона в книги не попал`);
      return finish(1);
    }
    warn(`${agentId}: файла выполнения нет — экшен о нём не сообщил. Расход прогона неизвестен (рука не дошла до модели или не оставила следа)`);
    return finish(0);
  }

  let parsed;
  try {
    const size = statSync(file).size;
    if (size > MAX_EXECUTION_BYTES) {
      warn(`${agentId}: расход руки не разобран — файл выполнения ${size} байт, больше предела ${MAX_EXECUTION_BYTES}`);
      return finish(0);
    }
    parsed = parseExecution(JSON.parse(readFileSync(file, 'utf-8')));
  } catch (e) {
    warn(`${agentId}: расход руки не разобран — файл выполнения не читается как JSON (${e instanceof Error ? e.message : String(e)})`);
    return finish(0);
  }

  summary.push(`- Экшен заявил (total_cost_usd, в книги не пишется): ${fmtUsd(parsed.reportedCostUsd)}`);
  if (parsed.form === 'unknown') {
    warn(`${agentId}: расход руки не разобран — ${parsed.reason}. Форма файла выполнения не та, что знает разбор; расход прогона неизвестен`);
    return finish(0);
  }
  if (parsed.form === 'assistant') {
    warn(`${agentId}: итога прогона нет (обрыв?) — расход собран из ответов модели; служебные вызовы экшена сюда не попали, это нижняя граница`);
  }

  summary.push('', '| Модель | Вход | Выход | Запись в кэш | Чтение кэша |', '|---|---|---|---|---|');
  for (const r of parsed.rows) {
    summary.push(`| ${r.model} | ${r.prompt_tokens} | ${r.completion_tokens} | ${fmt(r.cache_creation_tokens)} | ${fmt(r.cache_read_tokens)} |`);
  }

  const rows = parsed.rows.filter((r) => !isEmptyRow(r)).map((r) => ({ ...r, agent_id: agentId }));
  if (rows.length === 0) {
    out.push(`::notice::${escapeAnnotation(`${agentId}: все счётчики расхода нулевые — писать в книги нечего`)}`);
    summary.push('- Все счётчики нулевые — писать нечего.');
    return finish(0);
  }

  const secret = env.CRON_SECRET;
  if (!secret) {
    fail(`${agentId}: CRON_SECRET не задан — расход руки в книги не попадёт`);
    return finish(1);
  }

  let res;
  try {
    res = await fetchImpl(`${PROD_BASE}${REPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ rows }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    fail(`${agentId}: расход руки не отправлен — ${e instanceof Error ? e.message : String(e)}`);
    return finish(1);
  }

  const text = await res.text().catch(() => '');
  // 207 — прод записал не всё и сам называет обе цифры: это не успех.
  if (res.status !== 200) {
    fail(`${agentId}: прод не принял расход руки — HTTP ${res.status} ${text.slice(0, 200)}`);
    return finish(1);
  }

  /** @type {Record<string, unknown>} */
  let body = {};
  try {
    const j = JSON.parse(text);
    if (isObj(j)) body = j;
  } catch {
    warn(`${agentId}: прод ответил 200, но не JSON — сверку с заявлением экшена провести нечем`);
  }
  const written = typeof body.written === 'number' ? body.written : null;
  const unknownCost = typeof body.unknown_cost === 'number' ? body.unknown_cost : null;
  const booksUsd = typeof body.cost_usd_known === 'number' ? body.cost_usd_known : null;

  out.push(`::notice::${escapeAnnotation(`${agentId}: в книги записано строк: ${written ?? 'не названо'}, цена по книгам ${fmtUsd(booksUsd)}, экшен заявил ${fmtUsd(parsed.reportedCostUsd)}`)}`);
  summary.push(`- Записано строк: ${written ?? 'не названо'}; цена по книгам: ${fmtUsd(booksUsd)}.`);

  if (unknownCost !== null && unknownCost > 0) {
    warn(`${agentId}: цену ${unknownCost} строк книги не знают (модели нет ни в каталоге, ни в запасной таблице) — дневной бюджет их не сложит`);
  }
  if (booksUsd !== null && parsed.reportedCostUsd !== null && parsed.reportedCostUsd > 0 && (unknownCost ?? 0) === 0) {
    const drift = Math.abs(booksUsd - parsed.reportedCostUsd) / parsed.reportedCostUsd;
    if (drift > DRIFT_WARN_SHARE) {
      warn(`${agentId}: книги (${fmtUsd(booksUsd)}) и экшен (${fmtUsd(parsed.reportedCostUsd)}) расходятся на ${Math.round(drift * 100)}% — проверить цены каталога и множители кэша (lib/ai/cache-pricing.ts)`);
    }
  }
  return finish(0);
}

async function main() {
  const res = await runHandsUsage({ env: process.env });
  for (const line of res.out) process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${res.summary}\n`);
    } catch (e) {
      process.stdout.write(`::warning::${escapeAnnotation(`сводка не записана: ${e instanceof Error ? e.message : String(e)}`)}\n`);
    }
  }
  process.exitCode = res.exitCode;
}

// Запуск — явным флагом, а не угадыванием «меня ли позвали»: угадывание,
// ошибившись, молча не запустило бы учёт, и шаг вышел бы зелёным с нулём
// вывода. Сторож импортирует модуль без флага.
if (process.argv.includes('--run')) {
  main().catch((e) => {
    process.stdout.write(`::error::${escapeAnnotation(`Учёт расхода руки упал: ${e instanceof Error ? e.message : String(e)}`)}\n`);
    process.exitCode = 1;
  });
}
