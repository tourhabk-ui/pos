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
 *  - runPushCheck — прямой пуш в main (находка аудита 15.10 ZONES, решение
 *    S-2): маркеры и пробы уходят в main мимо PR, и до этого дня такой пуш,
 *    задевший зону, не проверял никто. Каждый коммит пуша судится тем же
 *    правилом по своему сообщению; коммит, влитый PR, у которого проверка
 *    зон прошла, повторно не судится. Нарушение — красный прогон и одна
 *    issue на коммит. Только чтение: ни отката, ни правки main.
 *
 * Тело PR — внешнее содержимое. Оно приходит строкой из env и только
 * читается: ни в shell, ни в разметку команд workflow оно не подставляется.
 * Код из PR не исполняется: workflow идёт по pull_request_target со своим
 * скриптом из main, а файлы PR читает через API как текст.
 *
 * Сообщение коммита — тоже внешнее содержимое: режим --push берёт его через
 * API по sha из env, в разметку workflow оно не попадает вовсе.
 *
 * CLI (так зовут workflow):
 *   node scripts/protected-zones.mjs --run   — PR (protected-zones.yml);
 *     env: GH_TOKEN, REPO, PR_NUMBER, BASE_SHA, HEAD_SHA, CHANGED_FILES, PR_BODY;
 *   node scripts/protected-zones.mjs --push  — прямой пуш (protected-zones-push.yml);
 *     env: GH_TOKEN, REPO, BEFORE_SHA, AFTER_SHA, RUN_URL.
 * Обоим: TS_MODULE (путь к пакету typescript; без него правка комментариев
 * судится как правка кода — громко, а не молча).
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
    paths: [
      'app/api/payments/**',
      'app/api/hub/operator/payments/webhook/**',
      // Выключатель приёма оплаты (решение владельца 05.10 «пока уберём
      // оплату»): константа в коде, чтобы включение было видимым коммитом.
      // Видимым — но до аудита 15.10 (ZONES, S-3) не судимым: файл лежал вне
      // реестра, и `true` здесь проходил без слова владельца.
      'lib/payments/accepting.ts',
    ],
    reason:
      'Приёмники оплаты: комиссия только recordCommissionFromBooking, строка tour_payments только holdTourPayment. §7 называет три живых приёмника — третий, CloudPayments кабинета оператора, лежит вне app/api/payments. Выключатель PLATFORM_ACCEPTS_PAYMENTS открывает приём денег для всех трёх разом.',
    claude: '§7 НЕ ТРОГАТЬ: `app/api/payments/`, выключатель — `lib/payments/accepting.ts`',
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
      // Правило доступа к этим трём дверям — одно, вынесенное из них (аудит
      // 15.10 ZONES, S-3): кто вправе поставить отметку на чужой регистрации
      // и по какому второму ключу. Ослабь его — и «вернулся» закроет контроль
      // по ссылке постороннего, хотя каждая дверь зоны осталась нетронутой.
      'lib/safety/registration-gate.ts',
      'lib/safety/registration-mark.ts',
      // Правило ЧТЕНИЯ регистрации целиком (ФИО и телефоны группы, экстренный
      // контакт, заявление в МЧС) за GET /api/safety/register/[id]: ослабь его —
      // и номера всей группы уходят любому, кто знает UUID (#2073). Внесено при
      // сведении волны 8 по замечанию ревью ZONES.
      'lib/safety/registration-read.ts',
    ],
    reason:
      'Обещание человеку на маршруте: не вернётся к сроку — начнут искать вовремя и с правильного места. Правки сверяются с docs/safety/WATCH_MANIFEST.md, правила меняет только владелец (решение 30.09).',
    claude: '§7 НЕ ТРОГАТЬ: **Контроль выхода**',
  },
  {
    id: 'messenger-login',
    title: 'Вход через мессенджеры',
    paths: ['lib/max/webhook-url.ts'],
    reason:
      'Секрет в адресе подписки MAX — единственное, что отличает настоящий вызов MAX от подделанного bot_started с чужим max_user_id, а по нему выдаётся вход в аккаунт (security-ревью #961). Тот же класс, что lib/auth.ts: ослабленная сверка или подменённый адрес вебхука уводят вход в чужой кабинет. Внесён аудитом 15.10 (ZONES, S-3).',
    claude: '§7 НЕ ТРОГАТЬ, абзац «Проверка зон»: `lib/max/webhook-url.ts`',
  },
  {
    id: 'pd-route',
    title: 'Маршрут ПД',
    paths: ['lib/notifications/pd-alert.ts'],
    reason:
      'Единственная дверь служебных уведомлений с ПД туриста (лиды, тревоги контроля выхода): имя и телефон уходят только в MAX, в Telegram — заглушка без ПД (решение владельца 23.08). Правка получателя или запасного пути — трансграничная передача ПД каждого лида, 152-ФЗ. Внесён аудитом 15.10 (ZONES, S-3).',
    claude: '§7 НЕ ТРОГАТЬ, абзац «Проверка зон»: `lib/notifications/pd-alert.ts`',
  },
  {
    id: 'zones-gate',
    title: 'Проверка зон §7',
    paths: [
      'scripts/protected-zones.mjs',
      '.github/workflows/protected-zones.yml',
      // Проверка прямого пуша (аудит 15.10 ZONES, S-2): снятый с неё триггер
      // или право — тот же отключённый сторож, что снятая зона.
      '.github/workflows/protected-zones-push.yml',
    ],
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

/**
 * Экранирование значения свойства команды (`file=…`): кроме перевода строки
 * свойство обрывают `:` и `,` — путь с ними не должен дописать своё свойство.
 */
export function escapeProperty(s) {
  return escapeAnnotation(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
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

/** Потолок API: больше 3000 файлов список PR (и коммита) не отдаёт. */
const API_FILES_CAP = 3000;

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const errText = (e) => (e instanceof Error ? e.message : String(e));

/** Клиент API GitHub поверх внедрённого fetch — один для PR и для пуша. */
function githubClient(env, fetchImpl) {
  const root = 'https://api.github.com';
  const api = `${root}/repos/${env.REPO}`;
  const headers = (accept) => ({
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'vedar-protected-zones',
  });
  const get = (url) => fetchImpl(url, { headers: headers('application/vnd.github+json') });
  const post = (url, payload) =>
    fetchImpl(url, {
      method: 'POST',
      headers: { ...headers('application/vnd.github+json'), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const getText = async (path, ref) => {
    const res = await fetchImpl(`${api}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
      headers: headers('application/vnd.github.raw+json'),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${path}@${ref.slice(0, 7)}`);
    return res.text();
  };
  return { root, api, get, post, getText };
}

/** Файл из списка API (PR или коммита) лежит в зоне сам или лежал до переименования. */
const touchesZone = (f, zones) =>
  zonesOfFile(f.filename, zones).length > 0 || (f.previous_filename && zonesOfFile(f.previous_filename, zones).length > 0);

/**
 * Файлы зон → TouchedFile: правка кода или одни комментарии. Версия «до» —
 * merge base у PR, родитель у коммита пуша; не получена — «не смог
 * определить», и файл судится как код.
 *
 * @param {{
 *   inZones: Array<{ filename: string; status: string; previous_filename?: string }>;
 *   resolveBase: () => Promise<{ sha: string | null; why: string }>;
 *   baseLabel: string;
 *   headSha: string;
 *   getText: (path: string, ref: string) => Promise<string>;
 *   ts: any;
 * }} input
 * @returns {Promise<TouchedFile[]>}
 */
async function classifyZoneFiles({ inZones, resolveBase, baseLabel, headSha, getText, ts }) {
  /** @type {TouchedFile[]} */
  const files = [];
  for (const f of inZones) {
    /** @type {TouchedFile} */
    const tf = { path: f.filename, previousPath: f.previous_filename ?? null, commentOnly: false };
    if (f.status === 'modified' || f.status === 'changed') {
      const base = await resolveBase();
      if (!base.sha) {
        tf.commentOnly = null;
        tf.note = `${baseLabel} не получено: ${base.why}`;
      } else {
        try {
          const [before, after] = await Promise.all([getText(f.filename, base.sha), getText(f.filename, headSha)]);
          const r = sameCodeIgnoringComments(ts, before, after, f.filename);
          tf.commentOnly = r.same;
          if (r.reason) tf.note = r.reason;
        } catch (e) {
          tf.commentOnly = null;
          tf.note = `содержимое не получено: ${errText(e)}`;
        }
      }
    }
    files.push(tf);
  }
  return files;
}

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

  const gh = githubClient(env, fetchImpl);

  /** @type {Array<{ filename: string; status: string; previous_filename?: string }>} */
  const list = [];
  try {
    for (let page = 1; page <= API_FILES_CAP / 100; page++) {
      const res = await gh.get(`${gh.api}/pulls/${env.PR_NUMBER}/files?per_page=100&page=${page}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} на странице ${page}`);
      const chunk = await res.json();
      if (!Array.isArray(chunk)) throw new Error(`ответ страницы ${page} — не список`);
      list.push(...chunk);
      if (chunk.length < 100) break;
    }
  } catch (e) {
    return fail(`список файлов PR не получен (${errText(e)})`);
  }
  if (list.length >= API_FILES_CAP) return fail(`в PR не меньше ${API_FILES_CAP} файлов — API отдаёт не все`);
  const expected = Number(env.CHANGED_FILES);
  if (env.CHANGED_FILES && Number.isFinite(expected) && expected !== list.length) {
    return fail(`список файлов неполон: получено ${list.length} из ${expected}`);
  }

  /** @type {{ sha: string | null; why: string } | undefined} */
  let mergeBase;
  const getMergeBase = async () => {
    if (mergeBase !== undefined) return mergeBase;
    try {
      const res = await gh.get(`${gh.api}/compare/${env.BASE_SHA}...${env.HEAD_SHA}`);
      const json = res.ok ? await res.json() : null;
      const sha = typeof json?.merge_base_commit?.sha === 'string' ? json.merge_base_commit.sha : null;
      mergeBase = { sha, why: res.ok ? 'в ответе сравнения нет merge_base_commit' : `сравнение ответило HTTP ${res.status}` };
    } catch (e) {
      // Отказ не глушится: причина уходит в аннотацию у каждого файла зоны.
      mergeBase = { sha: null, why: `сравнение не выполнилось: ${errText(e)}` };
    }
    return mergeBase;
  };

  const files = await classifyZoneFiles({
    inZones: list.filter((f) => touchesZone(f, zones)),
    resolveBase: getMergeBase,
    baseLabel: 'основание сравнения (merge base)',
    headSha: env.HEAD_SHA,
    getText: gh.getText,
    ts,
  });

  return formatVerdict(judgeZones({ files, body: env.PR_BODY ?? '', zones }));
}

// ── Прямой пуш в main ──────────────────────────────────────────────────────
//
// Находка аудита 15.10 ZONES (решение S-2): проверка выше идёт только на PR,
// а маркеры и пробы уходят в main прямым пушем — и такой пуш, задевший зону,
// не судил никто. Здесь каждый коммит пуша судится тем же правилом, только
// раздел «Слово владельца» ищется в сообщении коммита. Коммит, влитый PR, на
// голове которого проверка зон прошла, повторно не судится: суд уже был.
// Проверка только читает и сообщает (красный прогон + issue на коммит):
// откатывать main она не вправе, и обязательной в защите ветки не стоит.

/** Workflow проверки PR: его прогон на голове PR решает, судить ли влитый коммит повторно. */
export const PR_CHECK_WORKFLOW = 'protected-zones.yml';

/** Заголовок issue о нарушении; за ним — начало sha коммита, по нему ищется дубль. */
export const PUSH_ISSUE_TITLE = 'Прямой пуш задел зону §7';

/**
 * Метка issue этой проверки. Дубль ищется списком issue репозитория по метке,
 * а не поиском: поисковый индекс отстаёт, и перезапуск через минуту открыл бы
 * вторую issue на тот же коммит.
 */
export const PUSH_ISSUE_LABEL = 'zones-push';

/** Потолок issue с меткой, которые просматриваются в поисках дубля. */
const PUSH_ISSUES_SCAN_CAP = 1000;

/** Потолок коммитов одного пуша: больше — «не смог», а не выборка. */
const PUSH_COMMITS_CAP = 1000;

/**
 * Номера PR из заголовка коммита: squash «… (#2523)» и merge-коммит
 * «Merge pull request #2523 from …». Номер — только кандидат: заголовок пишет
 * автор коммита, поэтому влитие сверяется через API (merge_commit_sha).
 *
 * @param {unknown} message
 * @returns {number[]}
 */
export function prNumbersFromMessage(message) {
  if (typeof message !== 'string') return [];
  const subject = message.split(/\r?\n/, 1)[0] ?? '';
  const out = new Set();
  const squash = /\(#(\d+)\)\s*$/u.exec(subject);
  if (squash) out.add(Number(squash[1]));
  const merge = /^Merge pull request #(\d+)\b/u.exec(subject);
  if (merge) out.add(Number(merge[1]));
  return [...out];
}

/**
 * @typedef {{
 *   state: 'passed' | 'not-passed' | 'none' | 'unknown';
 *   number?: number;
 *   why: string;
 * }} PrCheck
 *
 * passed — коммит внёс влитый PR, и последняя проверка зон на его голове
 *          успешна: правка уже прошла суд;
 * not-passed — внёс влитый PR, но проверка зон на нём красная, отменена или
 *          её не было: судится сообщение коммита;
 * none — PR, внёсшего коммит, нет: прямой пуш, судится сообщение;
 * unknown — API не ответил: «не смог», а не «прямой пуш» и не «влит».
 */

/**
 * Решение по одному коммиту пуша. Исходы:
 *  - clean — зон не задел;
 *  - pr — внесён PR с прошедшей проверкой зон, повторно не судится;
 *  - ok / warn — как у PR, по сообщению коммита;
 *  - violation — зона с правкой кода без слова, и известно, что суда PR не было;
 *  - unknown — то же, но был ли суд PR, узнать не удалось: красный без issue.
 *
 * @param {{ files: TouchedFile[]; message: unknown; pr: PrCheck; zones?: ReadonlyArray<ProtectedZone> }} input
 */
export function judgePushCommit({ files, message, pr, zones = PROTECTED_ZONES }) {
  const verdict = judgeZones({ files, body: message, zones });
  /** @type {'clean' | 'pr' | 'ok' | 'warn' | 'violation' | 'unknown'} */
  const outcome =
    verdict.outcome === 'clean'
      ? 'clean'
      : pr.state === 'passed'
        ? 'pr'
        : verdict.outcome !== 'fail'
          ? verdict.outcome
          : pr.state === 'unknown'
            ? 'unknown'
            : 'violation';
  return { outcome, verdict, pr };
}

/**
 * @typedef {{
 *   sha: string;
 *   subject?: string;
 *   outcome: 'clean' | 'pr' | 'ok' | 'warn' | 'violation' | 'unknown';
 *   verdict?: ReturnType<typeof judgeZones>;
 *   pr?: PrCheck;
 *   why?: string;
 * }} PushCommitResult
 *
 * @typedef {{ state: 'opened' | 'exists' | 'failed'; number?: number; why?: string }} IssueNote
 */

const tickMd = (s) => `\`${String(s).replace(/[`\r\n]/g, ' ')}\``;

/**
 * Тело issue о нарушении. Заголовок коммита — внешний текст: только в
 * код-спане (без упоминаний и разметки), без переводов строки.
 *
 * @param {PushCommitResult} r
 * @param {{ repo?: string; runUrl?: string }} ctx
 */
export function pushIssueBody(r, { repo, runUrl } = {}) {
  const missing = (r.verdict?.zones ?? []).filter((z) => z.status === 'missing');
  const commitRef = repo ? `[${r.sha.slice(0, 7)}](https://github.com/${repo}/commit/${r.sha})` : tickMd(r.sha.slice(0, 7));
  return [
    `Коммит ${commitRef} пришёл в main и задел зону §7 CLAUDE.md без слова владельца в сообщении коммита.`,
    '',
    `Заголовок коммита: ${tickMd(r.subject ?? '')}`,
    `Почему судится сам коммит: ${r.pr?.why ?? 'не установлено'}.`,
    '',
    '| Зона | Файлы |',
    '|---|---|',
    ...missing.map((z) => `| ${tickMd(z.zone.id)} ${z.zone.title} | ${z.files.map((f) => tickMd(f.path)).join('<br>')} |`),
    '',
    'Что делать: правка согласована — допишите сюда слово владельца (зона или путь, цитата «…», дата ДД.ММ) и закройте issue; не согласована — откатите коммит.',
    'Впредь зона правится через PR с разделом «## Слово владельца» в теле либо коммитом, в сообщении которого этот раздел есть (`git commit -F файл`: при правке в редакторе git выбрасывает строки, начатые с `#`).',
    '',
    `Реестр зон и причины — \`scripts/protected-zones.mjs\`, правило — CLAUDE.md §7.${runUrl ? ` Прогон проверки: ${runUrl}` : ''}`,
    '',
    `<!-- zones-push-commit: ${r.sha} -->`,
  ].join('\n');
}

/**
 * Вывод проверки пуша: команды для stdout, сводка и код выхода.
 * Красный — нарушение или «не смог»; влитый PR с прошедшей проверкой — notice.
 *
 * @param {{ results: PushCommitResult[]; issues?: Map<string, IssueNote> }} input
 */
export function formatPushReport({ results, issues = new Map() }) {
  /** @type {string[]} */
  const out = [];
  const summary = ['## Зоны §7 CLAUDE.md — прямой пуш в main', ''];
  const short = (sha) => sha.slice(0, 7);
  const touched = results.filter((r) => r.outcome !== 'clean');

  out.push(`Коммитов в пуше: ${results.length}; задели зоны или не прочитаны: ${touched.length}.`);
  summary.push(`Коммитов в пуше: ${results.length}; задели зоны или не прочитаны: ${touched.length}.`);

  for (const r of touched) {
    if (!r.verdict) {
      out.push(`::error::${escapeAnnotation(`Не смог проверить коммит ${short(r.sha)}: ${r.why ?? 'причина не названа'}`)}`);
      continue;
    }
    for (const z of r.verdict.zones) {
      const files = z.files.map((f) => f.path).join(', ');
      const at = `file=${escapeProperty(z.files[0]?.path ?? '')}`;
      if (r.outcome === 'pr') {
        out.push(`::notice::${escapeAnnotation(`Коммит ${short(r.sha)}: ${r.pr?.why} — зона ${zoneLabel(z.zone)} повторно не судится. Файлы: ${files}`)}`);
      } else if (z.status === 'missing') {
        out.push(
          r.outcome === 'violation'
            ? `::error ${at}::${escapeAnnotation(
                `Коммит ${short(r.sha)} в main задел зону §7 ${zoneLabel(z.zone)} без слова владельца в сообщении коммита (${r.pr?.why}). Файлы: ${files}`,
              )}`
            : `::error ${at}::${escapeAnnotation(
                `Не смог проверить коммит ${short(r.sha)}: зона §7 ${zoneLabel(z.zone)} задета без слова владельца в сообщении, а прошёл ли он суд PR — неизвестно (${r.pr?.why}). Файлы: ${files}`,
              )}`,
        );
      } else if (z.status === 'comment-only') {
        out.push(
          `::warning ${at}::${escapeAnnotation(`Коммит ${short(r.sha)} меняет в зоне §7 ${zoneLabel(z.zone)} только комментарии — слово владельца не требуется, правка видна. Файлы: ${files}`)}`,
        );
      } else {
        out.push(`::notice::${escapeAnnotation(`Коммит ${short(r.sha)}, зона §7 ${zoneLabel(z.zone)}: слово владельца в сообщении коммита есть.`)}`);
      }
      if (r.outcome === 'pr') continue;
      for (const f of z.files) {
        if (f.commentOnly === null && f.note) {
          out.push(
            `::warning::${escapeAnnotation(`${short(r.sha)} ${f.path}: не смог определить, только ли комментарии меняются (${f.note}) — судится как правка кода`)}`,
          );
        }
      }
    }
    const note = issues.get(r.sha);
    if (note?.state === 'opened') out.push(`::notice::${escapeAnnotation(`Коммит ${short(r.sha)}: открыта issue #${note.number}.`)}`);
    if (note?.state === 'exists') out.push(`::notice::${escapeAnnotation(`Коммит ${short(r.sha)}: issue уже есть — #${note.number}, вторая не открывается.`)}`);
    if (note?.state === 'failed') out.push(`::error::${escapeAnnotation(`Коммит ${short(r.sha)}: ${note.why}`)}`);
  }

  const word = {
    pr: 'суд PR прошёл',
    ok: 'слово есть',
    warn: 'только комментарии',
    violation: '**нет слова**',
    unknown: '**не смог проверить**',
  };
  if (touched.length > 0) {
    summary.push('| Коммит | Зоны | Итог |', '|---|---|---|');
    for (const r of touched) {
      const zonesCell = r.verdict ? r.verdict.zones.map((z) => tickMd(z.zone.id)).join(', ') : '—';
      summary.push(`| ${tickMd(short(r.sha))} | ${zonesCell} | ${word[r.outcome] ?? r.outcome} |`);
    }
  }
  const red = touched.some((r) => r.outcome === 'violation' || r.outcome === 'unknown');
  if (touched.some((r) => r.outcome === 'violation')) {
    summary.push(
      '',
      'Как оформить: в сообщении коммита раздел `## Слово владельца`, по строке на зону — имя зоны или путь, цитата в ёлочках и дата ДД.ММ (`git commit -F файл`: редактор git строки с `#` выбрасывает). Либо правка через PR.',
      'Реестр зон и причины — `scripts/protected-zones.mjs`, правило — CLAUDE.md §7.',
    );
  }
  return { out, summary: summary.join('\n'), exitCode: red ? 1 : 0 };
}

/**
 * Полный проход по пушу: коммиты диапазона before...after, у каждого — файлы
 * и сообщение через API, суд PR для влитых, решение, issue на нарушение.
 * fetch и парсер внедряются, как у runZonesCheck.
 *
 * @param {{ env: Record<string, string | undefined>; fetchImpl?: typeof fetch; ts?: any; zones?: ReadonlyArray<ProtectedZone> }} opts
 */
export async function runPushCheck({ env, fetchImpl = globalThis.fetch, ts = null, zones = PROTECTED_ZONES }) {
  const fail = (msg) => ({
    out: [`::error::${escapeAnnotation(`Не смог проверить зоны §7 в пуше: ${msg}`)}`],
    summary: `## Зоны §7 CLAUDE.md — прямой пуш в main\n\nНе смог проверить: ${msg}. Непроверенный пуш — не «зон нет».`,
    exitCode: 1,
  });

  const need = ['GH_TOKEN', 'REPO', 'BEFORE_SHA', 'AFTER_SHA'];
  const absent = need.filter((k) => !env[k]);
  if (absent.length > 0) return fail(`нет переменных ${absent.join(', ')}`);
  if (/^0+$/.test(String(env.BEFORE_SHA))) {
    return fail('у пуша нет прежней головы (before из нулей) — диапазон коммитов не определить');
  }

  const gh = githubClient(env, fetchImpl);

  // 1. Коммиты пуша — по API сравнения, а не из события: в событии их не
  // больше двадцати, и сообщения пришли бы в workflow строкой.
  /** @type {Array<{ sha?: unknown }>} */
  const commits = [];
  let total = -1;
  try {
    for (let page = 1; ; page++) {
      if (page > PUSH_COMMITS_CAP / 100) throw new Error(`в пуше больше ${PUSH_COMMITS_CAP} коммитов`);
      const res = await gh.get(`${gh.api}/compare/${env.BEFORE_SHA}...${env.AFTER_SHA}?per_page=100&page=${page}`);
      if (!res.ok) throw new Error(`сравнение ответило HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json?.commits) || typeof json?.total_commits !== 'number') {
        throw new Error('в ответе сравнения нет списка коммитов');
      }
      total = json.total_commits;
      commits.push(...json.commits);
      if (json.commits.length < 100 || commits.length >= total) break;
    }
  } catch (e) {
    return fail(`коммиты пуша не получены (${errText(e)})`);
  }
  if (total === 0) {
    return fail('пуш не принёс новых коммитов (голову откатили?) — судить нечего, а файлы зон могли измениться');
  }
  if (commits.length !== total) return fail(`список коммитов неполон: получено ${commits.length} из ${total}`);

  /**
   * Внёс ли коммит влитый PR и прошла ли на голове PR проверка зон.
   * @returns {Promise<PrCheck>}
   */
  const lookupMergedPr = async (sha, message) => {
    /** @type {any} */
    let pr = null;
    try {
      for (const n of prNumbersFromMessage(message)) {
        const res = await gh.get(`${gh.api}/pulls/${n}`);
        if (res.status === 404) continue;
        if (!res.ok) throw new Error(`PR #${n} ответил HTTP ${res.status}`);
        const p = await res.json();
        // Номер в заголовке пишет автор коммита: засчитывается только PR,
        // чьё влитие и есть этот коммит.
        if (p?.merged_at && p?.merge_commit_sha === sha && p?.base?.ref === 'main') {
          pr = p;
          break;
        }
      }
      if (!pr) {
        // Merge-коммит и rebase: коммит внёс PR, но его sha — не merge_commit_sha.
        const res = await gh.get(`${gh.api}/commits/${sha}/pulls`);
        if (!res.ok) throw new Error(`список PR коммита ответил HTTP ${res.status}`);
        const list = await res.json();
        if (!Array.isArray(list)) throw new Error('список PR коммита — не список');
        pr = list.find((p) => p?.merged_at && p?.base?.ref === 'main') ?? null;
      }
    } catch (e) {
      return { state: 'unknown', why: `не смог узнать, влит ли коммит PR: ${errText(e)}` };
    }
    if (!pr) return { state: 'none', why: 'коммит не пришёл влитием PR' };
    const n = Number(pr.number);
    const head = pr?.head?.sha;
    if (typeof head !== 'string' || head === '') return { state: 'unknown', number: n, why: `у влитого PR #${n} нет sha головы` };
    try {
      const res = await gh.get(
        `${gh.api}/actions/workflows/${PR_CHECK_WORKFLOW}/runs?event=pull_request_target&head_sha=${encodeURIComponent(head)}&per_page=20`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json?.workflow_runs)) throw new Error('в ответе нет списка прогонов');
      const runs = [...json.workflow_runs].sort((a, b) => String(b?.created_at ?? '').localeCompare(String(a?.created_at ?? '')));
      const last = runs[0];
      if (!last) return { state: 'not-passed', number: n, why: `влит PR #${n}, но проверки зон на его голове ${head.slice(0, 7)} не было` };
      if (last.status !== 'completed') {
        return { state: 'unknown', number: n, why: `влит PR #${n}, а проверка зон на нём ещё не закончилась (${last.status})` };
      }
      if (last.conclusion === 'success') return { state: 'passed', number: n, why: `влит PR #${n}, проверка зон на нём прошла` };
      return { state: 'not-passed', number: n, why: `влит PR #${n}, но последняя проверка зон на нём — ${last.conclusion ?? 'без итога'}` };
    } catch (e) {
      return { state: 'unknown', number: n, why: `влит PR #${n}, а итог проверки зон на нём не получен: ${errText(e)}` };
    }
  };

  /** @returns {Promise<PushCommitResult>} */
  const judgeCommit = async (sha) => {
    /** @type {string} */
    let message = '';
    /** @type {string | null} */
    let parent = null;
    /** @type {Array<{ filename: string; status: string; previous_filename?: string }>} */
    const list = [];
    try {
      for (let page = 1; page <= API_FILES_CAP / 100; page++) {
        const res = await gh.get(`${gh.api}/commits/${sha}?per_page=100&page=${page}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} на странице ${page}`);
        const json = await res.json();
        if (!Array.isArray(json?.files) || typeof json?.commit?.message !== 'string') {
          throw new Error(`в ответе страницы ${page} нет файлов или сообщения`);
        }
        message = json.commit.message;
        parent = Array.isArray(json.parents) && typeof json.parents[0]?.sha === 'string' ? json.parents[0].sha : null;
        list.push(...json.files);
        if (json.files.length < 100) break;
      }
    } catch (e) {
      return { sha, outcome: 'unknown', why: `коммит не прочитан (${errText(e)})` };
    }
    if (list.length >= API_FILES_CAP) {
      return { sha, outcome: 'unknown', why: `в коммите не меньше ${API_FILES_CAP} файлов — API отдаёт не все` };
    }
    const subject = message.split(/\r?\n/, 1)[0] ?? '';
    const inZones = list.filter((f) => touchesZone(f, zones));
    if (inZones.length === 0) return { sha, subject, outcome: 'clean' };

    const pr = await lookupMergedPr(sha, message);
    // Суд PR прошёл — содержимое файлов не нужно: повторно коммит не судится.
    const files =
      pr.state === 'passed'
        ? inZones.map((f) => ({ path: f.filename, previousPath: f.previous_filename ?? null, commentOnly: false }))
        : await classifyZoneFiles({
            inZones,
            resolveBase: async () => (parent ? { sha: parent, why: '' } : { sha: null, why: 'у коммита нет родителя' }),
            baseLabel: 'родитель коммита',
            headSha: sha,
            getText: gh.getText,
            ts,
          });
    return { sha, subject, ...judgePushCommit({ files, message, pr, zones }) };
  };

  /** @type {PushCommitResult[]} */
  const results = [];
  for (const c of commits) {
    const sha = typeof c?.sha === 'string' && c.sha !== '' ? c.sha : null;
    results.push(sha ? await judgeCommit(sha) : { sha: '(без sha)', outcome: 'unknown', why: 'в ответе сравнения коммит без sha' });
  }

  // 2. Issue на нарушение — одна на коммит. Дубль — issue с меткой проверки
  // и началом sha в заголовке (открытая или закрытая): повторный прогон того
  // же пуша второй issue не открывает.
  /** @returns {Promise<IssueNote>} */
  const openIssueOnce = async (r) => {
    const tag = r.sha.slice(0, 12);
    try {
      for (let page = 1; ; page++) {
        if (page > PUSH_ISSUES_SCAN_CAP / 100) throw new Error(`issue с меткой ${PUSH_ISSUE_LABEL} больше ${PUSH_ISSUES_SCAN_CAP} — дубль не исключить`);
        const res = await gh.get(`${gh.api}/issues?labels=${PUSH_ISSUE_LABEL}&state=all&per_page=100&page=${page}`);
        if (!res.ok) throw new Error(`список issue проверки ответил HTTP ${res.status}`);
        const list = await res.json();
        if (!Array.isArray(list)) throw new Error('список issue проверки — не список');
        const dup = list.find((i) => typeof i?.title === 'string' && i.title.includes(tag));
        if (dup) return { state: 'exists', number: dup.number };
        if (list.length < 100) break;
      }
      // Метка — условие поиска дубля: без неё следующая issue была бы невидима
      // этому списку. 422 — метка уже заведена.
      const label = await gh.post(`${gh.api}/labels`, {
        name: PUSH_ISSUE_LABEL,
        color: 'b60205',
        description: 'Коммит в main задел зону §7 без слова владельца',
      });
      if (!label.ok && label.status !== 422) throw new Error(`метка ${PUSH_ISSUE_LABEL} не заведена: HTTP ${label.status}`);
    } catch (e) {
      // Без проверки дублей issue не открывается: красный прогон с этой
      // строкой остаётся, а дубль на каждом перезапуске — шум, который учит не читать.
      return { state: 'failed', why: `issue не открыта — ${errText(e)}; нарушение видно в этом прогоне` };
    }
    try {
      const res = await gh.post(`${gh.api}/issues`, {
        title: `${PUSH_ISSUE_TITLE}: ${tag}`,
        body: pushIssueBody(r, { repo: env.REPO, runUrl: env.RUN_URL }),
        labels: [PUSH_ISSUE_LABEL],
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return { state: 'opened', number: json?.number };
    } catch (e) {
      return { state: 'failed', why: `issue не открыта: ${errText(e)}` };
    }
  };

  /** @type {Map<string, IssueNote>} */
  const issues = new Map();
  for (const r of results) if (r.outcome === 'violation') issues.set(r.sha, await openIssueOnce(r));

  return formatPushReport({ results, issues });
}

// ── CLI ────────────────────────────────────────────────────────────────────

/** @param {'pr' | 'push'} mode */
async function main(mode) {
  let ts = null;
  try {
    ts = createRequire(import.meta.url)(process.env.TS_MODULE || 'typescript');
  } catch (e) {
    process.stdout.write(
      `::warning::${escapeAnnotation(`typescript не загрузился (${errText(e)}) — правка комментариев в зоне будет судиться как правка кода`)}\n`,
    );
  }
  const res = mode === 'push' ? await runPushCheck({ env: process.env, ts }) : await runZonesCheck({ env: process.env, ts });
  for (const line of res.out) process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${res.summary}\n`);
    } catch (e) {
      process.stdout.write(`::warning::${escapeAnnotation(`сводка не записана: ${errText(e)}`)}\n`);
    }
  }
  process.exitCode = res.exitCode;
}

// Запуск — явным флагом, а не угадыванием «меня ли позвали»: угадывание,
// ошибившись, молча не запустило бы проверку, и шаг вышел бы зелёным с нулём
// вывода. Сторож импортирует модуль без флага. --run — PR, --push — прямой пуш.
const CLI_MODE = process.argv.includes('--push') ? 'push' : process.argv.includes('--run') ? 'pr' : null;
if (CLI_MODE) {
  main(CLI_MODE).catch((e) => {
    process.stdout.write(`::error::${escapeAnnotation(`Не смог проверить зоны §7: ${errText(e)}`)}\n`);
    process.exitCode = 1;
  });
}
