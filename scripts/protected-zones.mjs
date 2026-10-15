#!/usr/bin/env node
/**
 * Зоны §7 CLAUDE.md («НЕ ТРОГАТЬ») и проверка PR, который их задевает.
 *
 * Находка аудита 15.10 AR-zones. До этого дня §7 был абзацем: ни один
 * workflow не смотрел, трогает ли PR приём оплаты, SOS, Edge-гвард или
 * контроль выхода. Исключения бывали — по слову владельца с датой (01.09,
 * 09.10, 14.10), — но узнать, что слово было, можно было только из текста
 * коммита, который писал тот же, кто правил. Владелец 15.10 на предложение по
 * статье Anthropic «Redesigning source control»: «по статье Anthropic тебе
 * карт-бланш». Из статьи взято одно: согласие по смыслу правки — правка
 * комментария и правка чувствительной логики требуют разного согласия.
 *
 * Что здесь:
 *  - PROTECTED_ZONES — ЕДИНСТВЕННЫЙ реестр зон: путь, причина, раздел
 *    CLAUDE.md. Его читают и workflow (.github/workflows/protected-zones.yml),
 *    и сторож (tests/unit/protected-zones-gate.test.ts). Реестр лежит в .mjs,
 *    а не в .json, намеренно: CI поднимается на .mjs, и правка реестра без
 *    прогона сторожа в main не въедет.
 *  - judgeZones — чистое решение по списку файлов и телу PR: четыре исхода
 *    (зон нет / слово есть / только комментарии — предупреждение / нет слова).
 *  - runZonesCheck — то же поверх API GitHub; «не смог получить список
 *    файлов» — красный, а не «зон нет» (§4.0: третий исход не равен первому).
 *
 * Тело PR — внешнее содержимое. Оно приходит строкой из env и только
 * читается: ни в shell, ни в разметку команд workflow оно не подставляется.
 * Код из PR не исполняется: workflow идёт по pull_request_target со своим
 * скриптом из main, а файлы PR читает через API как текст.
 *
 * CLI (так зовёт workflow): node scripts/protected-zones.mjs --run
 * env: GH_TOKEN, REPO, PR_NUMBER, BASE_SHA, HEAD_SHA, CHANGED_FILES, PR_BODY,
 *      TS_MODULE (путь к пакету typescript; без него правка комментариев
 *      судится как правка кода — громко, а не молча).
 */
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   paths: string[];
 *   reason: string;
 *   claude: string;
 * }} ProtectedZone
 */

/**
 * Реестр зон. Путь — точный файл либо каталог с `/**` (всё под ним).
 * Список зон меняет только владелец: зона `zones-gate` держит сам реестр.
 *
 * @type {ReadonlyArray<ProtectedZone>}
 */
export const PROTECTED_ZONES = Object.freeze([
  {
    id: 'middleware',
    title: 'Edge-гвард',
    paths: ['middleware.ts'],
    reason:
      'Edge JWT и rate-limit: всё, что прошло здесь, дальше не проверяется. Исключения были только по слову владельца — 01.09 (гейт /api/admin/*) и 09.10 (media-src для клипов из S3).',
    claude: '§7 НЕ ТРОГАТЬ: `middleware.ts`',
  },
  {
    id: 'public-api-routes',
    title: 'Реестр публичных API',
    paths: ['lib/auth/public-api-routes.ts'],
    reason:
      'Что Edge пускает без JWT. Строка здесь открывает роут анониму; третье исключение §7 (HEAD к /api/images) — по слову владельца 14.10 «ТРОГАЙ».',
    claude: '§7 НЕ ТРОГАТЬ: `middleware.ts`, третье исключение — `lib/auth/public-api-routes.ts`',
  },
  {
    id: 'lib-auth',
    title: 'JWT-логика',
    paths: ['lib/auth.ts'],
    reason: 'Выпуск и проверка JWT: ошибка здесь открывает чужие кабинеты.',
    claude: '§7 НЕ ТРОГАТЬ: `lib/auth.ts`',
  },
  {
    id: 'payments',
    title: 'Приём оплаты',
    paths: ['app/api/payments/**', 'app/api/hub/operator/payments/webhook/**'],
    reason:
      'Приёмники оплаты: комиссия только recordCommissionFromBooking, строка tour_payments только holdTourPayment. §7 называет три живых приёмника — третий, CloudPayments кабинета оператора, лежит вне app/api/payments.',
    claude: '§7 НЕ ТРОГАТЬ: `app/api/payments/`',
  },
  {
    id: 'sos',
    title: 'SOS',
    paths: ['app/api/safety/sos/**'],
    reason: 'SOS — только через staging: отказ здесь стоит жизни, а не денег.',
    claude: '§7 НЕ ТРОГАТЬ: `app/api/safety/sos`',
  },
  {
    id: 'trip-watch',
    title: 'Контроль выхода',
    paths: [
      // Правила слоя меняет только владелец (шапка манифеста).
      'docs/safety/WATCH_MANIFEST.md',
      // Таблица «Как это устроено сейчас» манифеста: файлы по имени.
      'lib/safety/trip-watch.ts',
      'lib/kuzmich/watch-flow.ts',
      'lib/safety/watch-status.ts',
      'lib/safety/checkin-escalation.ts',
      'app/api/cron/checkin-watchdog/**',
      // Та же таблица, адресами: POST /api/safety/register, трекер, страница контакта.
      'app/api/safety/register/**',
      'app/api/safety/tracker/**',
      'app/api/safety/watch-status/**',
      // Страницы, которые таблица называет: форма, отметки туриста, страница контакта.
      'app/register/**',
      'app/return/**',
      'app/checkin-ok/**',
      'app/watch/**',
      // Двери отметок за страницами /return и /checkin-ok: «вернулся» закрывает
      // контроль, «задерживаюсь» и «сообщил в МЧС» меняют ход лестницы.
      'app/api/safety/return/**',
      'app/api/safety/route-checkin/**',
      'app/api/safety/mchs-informed/**',
    ],
    reason:
      'Обещание человеку на маршруте: не вернётся к сроку — начнут искать вовремя и с правильного места. Правки сверяются с docs/safety/WATCH_MANIFEST.md, правила меняет только владелец (решение 30.09).',
    claude: '§7 НЕ ТРОГАТЬ: **Контроль выхода**',
  },
  {
    id: 'zones-gate',
    title: 'Проверка зон §7',
    paths: ['scripts/protected-zones.mjs', '.github/workflows/protected-zones.yml'],
    reason:
      'Сам реестр и проверка. Проверка идёт скриптом из main, поэтому PR, снявший зону из реестра, прошёл бы без слова, а ослабленный реестр действовал бы со следующего PR.',
    claude: '§7 НЕ ТРОГАТЬ, абзац «Проверка зон»: `scripts/protected-zones.mjs`',
  },
]);

/** Путь под шаблоном зоны: точный файл либо каталог с `/**`. */
export function matchesZonePath(file, pattern) {
  if (typeof file !== 'string' || file === '') return false;
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}

/** Зоны, в которые попадает файл (обычно одна, пусто — вне зон). */
export function zonesOfFile(file, zones = PROTECTED_ZONES) {
  return zones.filter((z) => z.paths.some((p) => matchesZonePath(file, p)));
}

// ── Слово владельца в теле PR ──────────────────────────────────────────────

/** Цитата в ёлочках, не пустая. */
const QUOTE = /«\s*[^»\s][^»]*»/u;
/** Дата ДД.ММ (год после неё допускается). */
const DATE = /(?<!\d)(?:0[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])(?!\d)/u;
const SECTION = /^(#{2,3})\s*Слово владельца\s*:?\s*$/iu;

/**
 * Строки раздела «## Слово владельца» или null, если раздела нет.
 * HTML-комментарии и блоки кода выбрасываются: пример формата в шаблоне PR
 * или в инструкции не должен засчитываться за само слово.
 *
 * @param {unknown} body
 * @returns {string[] | null}
 */
export function ownerWordSection(body) {
  if (typeof body !== 'string') return null;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '');
  const lines = text.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION.exec(lines[i].trim());
    if (m) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start < 0) return null;
  const out = [];
  for (let j = start + 1; j < lines.length; j++) {
    const h = /^(#{1,6})\s/.exec(lines[j].trim());
    if (h && h[1].length <= level) break;
    out.push(lines[j]);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Строка называет имя или путь целым словом: `middleware.ts` не находится
 * внутри `lib/auth/middleware.ts`, а `app/api/payments` находится в
 * `app/api/payments/webhook/route.ts`.
 */
export function namesToken(line, token) {
  if (!token) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_./-])${escapeRe(token)}(?![\\p{L}\\p{N}_-])`, 'iu');
  return re.test(line);
}

const stripGlob = (p) => (p.endsWith('/**') ? p.slice(0, -3) : p);

/**
 * @typedef {{
 *   path: string;
 *   previousPath?: string | null;
 *   commentOnly: boolean | null;
 *   note?: string;
 * }} TouchedFile
 *
 * commentOnly: true — по разбору меняются только комментарии; false — код;
 * null — не смог определить (судится как код, причина в note).
 */

/**
 * Решение по PR. Исходы:
 *  - clean — зон не задето;
 *  - ok — у каждой задетой зоны есть слово владельца;
 *  - warn — без слова только зоны, где меняются одни комментарии;
 *  - fail — хоть одна зона с правкой кода без слова.
 *
 * @param {{ files: TouchedFile[]; body: unknown; zones?: ReadonlyArray<ProtectedZone> }} input
 */
export function judgeZones({ files, body, zones = PROTECTED_ZONES }) {
  /** @type {Map<string, { zone: ProtectedZone; files: TouchedFile[] }>} */
  const touched = new Map();
  for (const f of files) {
    const hits = new Set([
      ...zonesOfFile(f.path, zones),
      ...(f.previousPath ? zonesOfFile(f.previousPath, zones) : []),
    ]);
    for (const z of hits) {
      const entry = touched.get(z.id) ?? { zone: z, files: [] };
      entry.files.push(f);
      touched.set(z.id, entry);
    }
  }

  const section = ownerWordSection(body);
  const wordLines = (section ?? []).filter((l) => QUOTE.test(l) && DATE.test(l));

  const results = [...touched.values()].map(({ zone, files: zf }) => {
    const commentOnly = zf.every((f) => f.commentOnly === true);
    const tokens = [
      zone.id,
      zone.title,
      ...zone.paths.map(stripGlob),
      ...zf.flatMap((f) => [f.path, f.previousPath].filter((p) => typeof p === 'string' && p !== '')),
    ];
    const hasWord = wordLines.some((l) => tokens.some((t) => namesToken(l, t)));
    /** @type {'word' | 'comment-only' | 'missing'} */
    const status = hasWord ? 'word' : commentOnly ? 'comment-only' : 'missing';
    return { zone, files: zf, commentOnly, hasWord, status };
  });

  /** @type {'clean' | 'ok' | 'warn' | 'fail'} */
  const outcome =
    results.length === 0
      ? 'clean'
      : results.some((r) => r.status === 'missing')
        ? 'fail'
        : results.some((r) => r.status === 'comment-only')
          ? 'warn'
          : 'ok';
  return { outcome, sectionFound: section !== null, zones: results };
}

// ── Только комментарии: сравнение по разбору, не по строкам диффа ──────────

/**
 * Комментарии, которые меняют сборку или рантайм: магия webpack/turbopack,
 * прагмы JSX, пометки чистоты для тряски дерева. Их правка — правка кода.
 */
const DIRECTIVE_COMMENT = /webpack[A-Za-z]*\s*:|turbopackIgnore|@vite-ignore|[#@]__PURE__|__NO_SIDE_EFFECTS__|@jsx\w*/g;

/**
 * Совпадают ли две версии файла, если выбросить комментарии.
 *
 * По строкам диффа это не решить надёжно: строка `// x` внутри шаблонной
 * строки — данные, строка `* x` в середине длинного блока — комментарий, а
 * начало блока лежит вне хунка. Поэтому обе версии разбираются парсером
 * TypeScript и печатаются без комментариев; совпало — меняются только
 * комментарии (и пробелы). Парсер споткнулся или файл не JS/TS — null:
 * «не смог определить» судится как правка кода.
 *
 * @param {any} ts модуль typescript или null
 * @param {string} baseText
 * @param {string} headText
 * @param {string} path
 * @returns {{ same: boolean | null; reason?: string }}
 */
export function sameCodeIgnoringComments(ts, baseText, headText, path) {
  if (!ts || typeof ts.createSourceFile !== 'function') {
    return { same: null, reason: 'парсер TypeScript не загрузился' };
  }
  const ext = /\.([cm]?[jt]sx?)$/.exec(path)?.[1];
  if (!ext) return { same: null, reason: 'не код JS/TS — комментарии в нём не отличить' };
  const kind = ext.endsWith('tsx')
    ? ts.ScriptKind.TSX
    : ext.endsWith('jsx')
      ? ts.ScriptKind.JSX
      : ext.endsWith('ts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  try {
    const a = ts.createSourceFile(path, baseText, ts.ScriptTarget.Latest, false, kind);
    const b = ts.createSourceFile(path, headText, ts.ScriptTarget.Latest, false, kind);
    const da = a.parseDiagnostics;
    const db = b.parseDiagnostics;
    if (!Array.isArray(da) || !Array.isArray(db)) {
      return { same: null, reason: 'парсер не сообщил об ошибках разбора — судить не по чему' };
    }
    if (da.length > 0 || db.length > 0) return { same: null, reason: 'файл не разбирается парсером' };
    const printer = ts.createPrinter({ removeComments: true });
    if (printer.printFile(a) !== printer.printFile(b)) return { same: false };
    const directives = (t) => (t.match(DIRECTIVE_COMMENT) ?? []).sort().join('\n');
    if (directives(baseText) !== directives(headText)) {
      return { same: false, reason: 'изменён управляющий комментарий (webpack, @jsx, __PURE__)' };
    }
    return { same: true };
  } catch (e) {
    return { same: null, reason: `парсер упал: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Вывод для GitHub Actions ───────────────────────────────────────────────

/** Экранирование данных в команде workflow: путь из PR не должен начать новую команду. */
export function escapeAnnotation(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

const zoneLabel = (z) => `${z.id} (${z.title})`;

/**
 * Строки для stdout (команды ::error:: / ::warning:: / ::notice::), сводка
 * markdown и код выхода по решению judgeZones.
 *
 * @param {ReturnType<typeof judgeZones>} verdict
 */
export function formatVerdict(verdict) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const summary = ['## Зоны §7 CLAUDE.md', ''];

  if (verdict.outcome === 'clean') {
    out.push('PR не трогает зон §7.');
    summary.push('PR не трогает зон §7.');
    return { out, summary: summary.join('\n'), exitCode: 0 };
  }

  for (const r of verdict.zones) {
    const files = r.files.map((f) => f.path).join(', ');
    if (r.status === 'missing') {
      out.push(
        `::error::${escapeAnnotation(
          `PR трогает зону §7 ${zoneLabel(r.zone)} без слова владельца — добавьте цитату с датой в раздел «Слово владельца». Файлы: ${files}`,
        )}`,
      );
    } else if (r.status === 'comment-only') {
      out.push(
        `::warning::${escapeAnnotation(
          `PR меняет в зоне §7 ${zoneLabel(r.zone)} только комментарии — слово владельца не требуется, правка видна. Файлы: ${files}`,
        )}`,
      );
    } else {
      out.push(`::notice::${escapeAnnotation(`Зона §7 ${zoneLabel(r.zone)}: слово владельца в теле PR есть.`)}`);
    }
    for (const f of r.files) {
      if (f.commentOnly === null && f.note) {
        out.push(
          `::warning::${escapeAnnotation(`${f.path}: не смог определить, только ли комментарии меняются (${f.note}) — судится как правка кода`)}`,
        );
      }
    }
  }

  const tick = (s) => `\`${String(s).replace(/`/g, '')}\``;
  const word = { word: 'слово есть', 'comment-only': 'только комментарии', missing: '**нет слова**' };
  summary.push('| Зона | Файлы | Итог |', '|---|---|---|');
  for (const r of verdict.zones) {
    summary.push(`| ${tick(r.zone.id)} ${r.zone.title} | ${r.files.map((f) => tick(f.path)).join('<br>')} | ${word[r.status]} |`);
  }
  if (verdict.outcome === 'fail') {
    summary.push(
      '',
      'Как оформить: в теле PR раздел `## Слово владельца`, по строке на зону — имя зоны или путь, цитата в ёлочках и дата ДД.ММ:',
      '',
      '    - payments — «цитата владельца» (15.10)',
      '',
      verdict.sectionFound ? 'Раздел найден, но строки для зон выше в нём нет.' : 'Раздела «Слово владельца» в теле PR нет.',
      'Реестр зон и причины — `scripts/protected-zones.mjs`, правило — CLAUDE.md §7.',
    );
  }
  return { out, summary: summary.join('\n'), exitCode: verdict.outcome === 'fail' ? 1 : 0 };
}

// ── Проход поверх API GitHub ───────────────────────────────────────────────

/** Потолок API: больше 3000 файлов список PR не отдаёт. */
const API_FILES_CAP = 3000;

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * Полный проход: список файлов PR, разбор правок в зонах, решение, вывод.
 * fetch и парсер внедряются, чтобы сторож гонял тот же путь без сети.
 *
 * @param {{ env: Record<string, string | undefined>; fetchImpl?: typeof fetch; ts?: any; zones?: ReadonlyArray<ProtectedZone> }} opts
 */
export async function runZonesCheck({ env, fetchImpl = globalThis.fetch, ts = null, zones = PROTECTED_ZONES }) {
  const fail = (msg) => ({
    out: [`::error::${escapeAnnotation(`Не смог проверить зоны §7: ${msg}`)}`],
    summary: `## Зоны §7 CLAUDE.md\n\nНе смог проверить: ${msg}. Непроверенный PR — не «зон нет».`,
    exitCode: 1,
  });

  const need = ['GH_TOKEN', 'REPO', 'PR_NUMBER', 'BASE_SHA', 'HEAD_SHA'];
  const absent = need.filter((k) => !env[k]);
  if (absent.length > 0) return fail(`нет переменных ${absent.join(', ')}`);

  const api = `https://api.github.com/repos/${env.REPO}`;
  const headers = (accept) => ({
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'vedar-protected-zones',
  });

  /** @type {Array<{ filename: string; status: string; previous_filename?: string }>} */
  const list = [];
  try {
    for (let page = 1; page <= API_FILES_CAP / 100; page++) {
      const res = await fetchImpl(`${api}/pulls/${env.PR_NUMBER}/files?per_page=100&page=${page}`, {
        headers: headers('application/vnd.github+json'),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} на странице ${page}`);
      const chunk = await res.json();
      if (!Array.isArray(chunk)) throw new Error(`ответ страницы ${page} — не список`);
      list.push(...chunk);
      if (chunk.length < 100) break;
    }
  } catch (e) {
    return fail(`список файлов PR не получен (${e instanceof Error ? e.message : String(e)})`);
  }
  if (list.length >= API_FILES_CAP) return fail(`в PR не меньше ${API_FILES_CAP} файлов — API отдаёт не все`);
  const expected = Number(env.CHANGED_FILES);
  if (env.CHANGED_FILES && Number.isFinite(expected) && expected !== list.length) {
    return fail(`список файлов неполон: получено ${list.length} из ${expected}`);
  }

  const inZones = list.filter(
    (f) => zonesOfFile(f.filename, zones).length > 0 || (f.previous_filename && zonesOfFile(f.previous_filename, zones).length > 0),
  );

  /** @type {{ sha: string | null; why: string } | undefined} */
  let mergeBase;
  const getMergeBase = async () => {
    if (mergeBase !== undefined) return mergeBase;
    try {
      const res = await fetchImpl(`${api}/compare/${env.BASE_SHA}...${env.HEAD_SHA}`, {
        headers: headers('application/vnd.github+json'),
      });
      const json = res.ok ? await res.json() : null;
      const sha = typeof json?.merge_base_commit?.sha === 'string' ? json.merge_base_commit.sha : null;
      mergeBase = { sha, why: res.ok ? 'в ответе сравнения нет merge_base_commit' : `сравнение ответило HTTP ${res.status}` };
    } catch (e) {
      // Отказ не глушится: причина уходит в аннотацию у каждого файла зоны.
      mergeBase = { sha: null, why: `сравнение не выполнилось: ${e instanceof Error ? e.message : String(e)}` };
    }
    return mergeBase;
  };
  const getText = async (path, ref) => {
    const res = await fetchImpl(`${api}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
      headers: headers('application/vnd.github.raw+json'),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${path}@${ref.slice(0, 7)}`);
    return res.text();
  };

  /** @type {TouchedFile[]} */
  const files = [];
  for (const f of inZones) {
    /** @type {TouchedFile} */
    const tf = { path: f.filename, previousPath: f.previous_filename ?? null, commentOnly: false };
    if (f.status === 'modified' || f.status === 'changed') {
      const base = await getMergeBase();
      if (!base.sha) {
        tf.commentOnly = null;
        tf.note = `основание сравнения (merge base) не получено: ${base.why}`;
      } else {
        try {
          const [before, after] = await Promise.all([getText(f.filename, base.sha), getText(f.filename, env.HEAD_SHA)]);
          const r = sameCodeIgnoringComments(ts, before, after, f.filename);
          tf.commentOnly = r.same;
          if (r.reason) tf.note = r.reason;
        } catch (e) {
          tf.commentOnly = null;
          tf.note = `содержимое не получено: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    files.push(tf);
  }

  return formatVerdict(judgeZones({ files, body: env.PR_BODY ?? '', zones }));
}

async function main() {
  let ts = null;
  try {
    ts = createRequire(import.meta.url)(process.env.TS_MODULE || 'typescript');
  } catch (e) {
    process.stdout.write(
      `::warning::${escapeAnnotation(`typescript не загрузился (${e instanceof Error ? e.message : String(e)}) — правка комментариев в зоне будет судиться как правка кода`)}\n`,
    );
  }
  const res = await runZonesCheck({ env: process.env, ts });
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
// ошибившись, молча не запустило бы проверку, и шаг вышел бы зелёным с нулём
// вывода. Сторож импортирует модуль без флага.
if (process.argv.includes('--run')) {
  main().catch((e) => {
    process.stdout.write(`::error::${escapeAnnotation(`Не смог проверить зоны §7: ${e instanceof Error ? e.message : String(e)}`)}\n`);
    process.exitCode = 1;
  });
}
