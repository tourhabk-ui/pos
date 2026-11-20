#!/usr/bin/env node
/**
 * scripts/security/secret-scan.mjs — секреты на ДОБАВЛЕННЫХ строках.
 *
 * Аудит перед запуском (22.10) нашёл ключи провайдеров в публичной истории
 * репозитория, а рядом — сканер `detect-secrets.sh`, который не звал никто:
 * ни CI, ни хук. Хук pre-commit проверял шаблоны сам, но хук обходится
 * (`--no-verify`, `core.hooksPath=/dev/null` у коммитов маркеров), а пуш в
 * main и чужой PR не проверял никто.
 *
 * Теперь один список шаблонов и два вызова: хук (`--staged`) и workflow
 * `secret-scan.yml` на каждом PR и пуше в main (`--range BASE HEAD`). Смотрятся
 * только добавленные строки: старое уже лежит в истории, и лечит его отзыв
 * ключа у провайдера, а не правка файла.
 *
 * Значение не печатается НИКОГДА — ни целиком, ни частью: только файл,
 * строка и род ключа. Лог CI публичен так же, как репозиторий.
 *
 * Исходов три (§4.0): 0 — новых секретов нет, 1 — найдены, 2 — проверить не
 * смог (git не отдал разницу). Третий — не «чисто».
 *
 * Осознанное исключение — пометка `allow-secret:` с причиной на той же строке.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Пустое дерево git: база для первого коммита без родителя. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Пароль-заглушка в строке подключения — не секрет: так пишут примеры
 * (`postgres://user:password@host`, `:${DB_PASSWORD}@`, `your_password_here`).
 * Пароль тестовой базы CI в сервисном контейнере сюда не входит и судится:
 * его правят редко, и пометка allow-secret: с причиной честнее широкого
 * исключения.
 */
const PLACEHOLDER_PASSWORD =
  /^(?:password|passwd|pass|secret|changeme|test|example|postgres|\*+|x+|\.{3}|<[^>]*>|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_]+%)$|your|here|change_?me|placeholder/i;

/**
 * Слово в имени переменной, по которому в значении ждут секрет: `JWT_SECRET`,
 * `CRON_SECRET`, `S3_SECRET_KEY`, `SMTP_PASS`, `ENCRYPTION_KEY`, `x-api-key`,
 * `password`, `apiKey`. Голое `pass` — только последним слогом (`PGPASS`), не
 * `passenger` и не `passport`.
 */
const SECRET_WORD = [
  'secret', 'token', 'passw(?:or)?d', 'passphrase', 'pass(?![a-z])', 'pwd', 'credentials?',
  'api[_-]?key', 'access[_-]?key', 'private[_-]?key', 'auth[_-]?key', 'signing[_-]?key',
  'encryption[_-]?key', 'session[_-]?key', 'master[_-]?key', 'hmac[_-]?key', 'jwt[_-]?key',
].join('|');

/** Имя целиком: слово-секрет внутри идентификатора, ключа YAML или заголовка. */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*?(?:${SECRET_WORD})[A-Za-z0-9_-]*`;

/**
 * Значение по имени. Группа 3 — в кавычках: `JWT_SECRET = "…"`,
 * `password: '<значение>'`, `$env:CRON_SECRET = "…"`, `const CRON_SECRET: string = "…"`,
 * `process.env.JWT_SECRET || "…"`, `cfg.jwtSecret = "…"`.
 * Группа 5 — без кавычек, строкой конфига: `S3_SECRET_KEY=…`, `export …=…`,
 * `ENV JWT_SECRET=…` (Dockerfile), `- JWT_SECRET=…` (compose),
 * `POSTGRES_PASSWORD: …` (YAML), `spring.datasource.password=…`, с
 * комментарием `# …` в конце или без.
 *
 * Флаг `g`: на строке судится каждое присваивание, а не только первое —
 * заглушка слева не прячет настоящий ключ справа.
 */
const NAMED_SECRET = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(${SECRET_NAME})["']?\s*(?::\s*[A-Za-z_][\w<>\[\]|.]*\s*)?(?::=|=>|\|\||\?\?|:|=)\s*(["'\x60])([^"'\x60\s]{12,})\2`
    + String.raw`|^\s*(?:export\s+|readonly\s+|local\s+|\$env:|ENV\s+|-\s+|Environment=)?["']?(${SECRET_NAME})["']?\s*[=:]\s*([^\s"'\x60#]{12,})\s*(?:#.*)?$`,
  'gi',
);

/** Энтропия Шеннона значения, бит на знак. */
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** Слово-заглушка целиком: `test`, но не `latest`; `demo`, но не `ProdDemo`. */
const PLACEHOLDER_WORD =
  /(?:^|[^a-z])(?:tests?|demos?|dummy|fakes?|mocks?|samples?|here|todo|redacted|replace|changeme|change_me)(?:[^a-z]|$)/i;

/**
 * Значение по секретному имени, которое секретом не является: ссылка на
 * окружение или переменную (`process.env.X`, `${{ secrets.X }}`, `$X`,
 * `config.jwtSecret`), заглушка (`your_jwt_secret_here`, `xxxx`, `<токен>`,
 * `test-cron-secret`), имя константы (`VEDAR_SESSION_TOKEN`), слово, адрес.
 * Остальное с энтропией от 3 бит на знак — секрет.
 *
 * Значение с кириллицей или с классом знаков регулярного выражения
 * (`[а-яё]`, `(?:`) — исходник шаблона, а не ключ.
 *
 * Чего правило не видит, сказано прямо: значение с пробелами
 * («Correct Horse Battery»), значение из одних букв (`correcthorsebatterystaple`
 * не отличить от имени переменной `hashedPasswordValue`), значение короче 12
 * знаков, ключ без префикса провайдера под несекретным именем.
 *
 * Замер 20.11 на истории репозитория: до этого правила сканер пропускал 54
 * значения, которые лежали открытым текстом (JWT_SECRET, CRON_SECRET, ключи
 * S3, пароли площадок, токены). На месяце main (311 тыс. добавленных строк) правило
 * сработало бы 4 раза, все в тестах.
 *
 * @param {string} v
 */
export function isPlaceholderValue(v) {
  if (/your|exampl|placeholder|xxxx|\*\*\*|\.\.\.|[<>]|\$\{|\$\(|process\.env|import\.meta|secrets\.|vars\.|1234567|abcdef|qwerty/i.test(v)) return true;
  if (PLACEHOLDER_WORD.test(v)) return true;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v)) return true;
  if (/[а-яё]/i.test(v) || /\[[^\]]+\]|\(\?/.test(v)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[,;)]*$/.test(v)) return true;
  if (/[,;)]$/.test(v)) return true;
  if (/^\{.*\}$/.test(v)) return true;
  if (/^[\p{L}_-]+$/u.test(v)) return true;
  if (/^[A-Z]+[0-9]{0,4}(?:_(?:[A-Z]+[0-9]{0,4}|[0-9]{1,4}))+$/.test(v)) return true;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(v) || v.startsWith('/') || v.startsWith('./')) return true;
  if (/^[0-9.:-]+$/.test(v)) return true;
  return entropy(v) < 3;
}

/** Значения по секретному имени на строке — все, а не первое. */
function namedSecretValues(text) {
  const out = [];
  for (const m of text.matchAll(NAMED_SECRET)) out.push(m[3] ?? m[5] ?? '');
  return out;
}

/** Токен в заголовке `Authorization: Bearer …` без имени переменной. */
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/gi;

/**
 * Род ключа и его форма. Формы — опубликованные провайдерами префиксы и
 * длины, а не «похоже на случайное»: энтропийный поиск на коде с хешами,
 * base64-снимками и UUID шумит так, что его перестают читать. Единственное
 * место, где энтропия судит, — значение под секретным ИМЕНЕМ: там случайная
 * строка и есть секрет (`isPlaceholderValue`).
 *
 * @type {ReadonlyArray<{ name: string; re: RegExp; ignore?: (m: RegExpMatchArray) => boolean; found?: (text: string) => boolean }>}
 */
export const SECRET_PATTERNS = [
  { name: 'Telegram: токен бота', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { name: 'Anthropic: ключ API', re: /\bsk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{30,}/ },
  { name: 'OpenRouter: ключ API', re: /\bsk-or-v1-[A-Za-z0-9_-]{30,}/ },
  { name: 'OpenAI: ключ проекта', re: /\bsk-proj-[A-Za-z0-9_-]{30,}/ },
  { name: 'DeepSeek / DashScope: ключ API', re: /\bsk-[a-f0-9]{32}\b/ },
  { name: 'xAI: ключ API', re: /\bxai-[A-Za-z0-9]{40,}/ },
  { name: 'GitHub: токен', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { name: 'AWS / S3: ключ доступа', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google: ключ API', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Яндекс Облако: API-ключ', re: /\bAQVN[A-Za-z0-9_-]{35,}/ },
  { name: 'Яндекс: OAuth-токен', re: /\by0_[A-Za-z0-9_-]{50,}/ },
  { name: 'CloudPayments: секрет', re: /\bcp-[a-f0-9]{32}\b/ },
  { name: 'JWT', re: /\beyJhbGci[A-Za-z0-9._-]{100,}/ },
  { name: 'Закрытый ключ', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  {
    name: 'Строка подключения с паролем',
    re: /\b(?:postgres(?:ql)?|mysql|redis|rediss|mongodb(?:\+srv)?|amqps?):\/\/[^\s:/@'"`]+:([^\s@'"`]{6,})@/,
    ignore: (m) => PLACEHOLDER_PASSWORD.test(m[1] ?? ''),
  },
  {
    name: 'Секрет по имени переменной',
    re: NAMED_SECRET,
    found: (text) => namedSecretValues(text).some((v) => !isPlaceholderValue(v)),
  },
  {
    name: 'Токен Bearer',
    re: BEARER,
    found: (text) => [...text.matchAll(BEARER)].some((m) => !isPlaceholderValue(m[1] ?? '')),
  },
];

/**
 * Добавленные строки из unified diff (`git diff -U0`): файл, номер в новой
 * версии, текст. Заголовок файла разбирается только до первого `@@`: строка
 * кода `++i` в диффе выглядит как `+++i` и заголовком не является.
 *
 * @param {string} diff
 * @returns {Array<{ file: string; line: number; text: string }>}
 */
export function addedLines(diff) {
  const out = [];
  let file = null;
  let line = 0;
  let inHeader = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHeader = true;
      file = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHeader = false;
      line = Number(hunk[1]);
      continue;
    }
    if (inHeader) {
      if (raw.startsWith('+++ ')) {
        const p = raw.slice(4).trim();
        file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      }
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith('+')) {
      out.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (raw.startsWith(' ')) {
      line += 1;
    }
  }
  return out;
}

/**
 * Находки на добавленных строках — без значения ключа.
 *
 * @param {string} diff
 * @returns {Array<{ file: string; line: number; name: string }>}
 */
export function scanDiff(diff) {
  const findings = [];
  for (const { file, line, text } of addedLines(diff)) {
    if (text.includes('allow-secret:')) continue;
    for (const p of SECRET_PATTERNS) {
      if (p.found) {
        if (!p.found(text)) continue;
      } else {
        const m = text.match(p.re);
        if (!m || (p.ignore && p.ignore(m))) continue;
      }
      findings.push({ file, line, name: p.name });
    }
  }
  return findings;
}

/** @param {string[]} args */
function gitDiff(args) {
  return execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U0', ...args],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  );
}

/** Есть ли у коммита родитель (первый коммит его не имеет). */
function hasParent(sha) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Разница для проверки. PR — от точки ветвления (`BASE...HEAD`), пуш — между
 * состояниями ветки (`BASE..HEAD`); нулевая база у пуша — первый пуш ветки,
 * проверяется сам коммит.
 *
 * @param {{ staged: boolean; base?: string; head?: string; mergeBase: boolean }} opts
 */
function readDiff(opts) {
  if (opts.staged) return gitDiff(['--cached']);
  const head = opts.head ?? 'HEAD';
  const base = opts.base ?? '';
  if (/^0*$/.test(base)) {
    return gitDiff([hasParent(head) ? `${head}^` : EMPTY_TREE, head]);
  }
  return gitDiff([opts.mergeBase ? `${base}...${head}` : `${base}..${head}`]);
}

/** Экранирование значения для аннотации GitHub. */
function escapeProperty(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function main(argv) {
  const staged = argv.includes('--staged');
  const github = argv.includes('--format=github');
  const mergeBase = argv.includes('--merge-base');
  const at = argv.indexOf('--range');
  const base = at >= 0 ? argv[at + 1] : undefined;
  const head = at >= 0 ? argv[at + 2] : undefined;

  let diff;
  try {
    diff = readDiff({ staged, base, head, mergeBase });
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
    const msg = `Проверка секретов не выполнена: git не отдал разницу (${why}). Это не «секретов нет».`;
    process.stdout.write(github ? `::error::${msg}\n` : `${msg}\n`);
    return 2;
  }

  const findings = scanDiff(diff);
  if (findings.length === 0) {
    process.stdout.write(`Секретов в новых строках нет (строк проверено: ${addedLines(diff).length}).\n`);
    return 0;
  }

  const advice = 'Значение не выводится. Уберите строку и отзовите ключ у провайдера: '
    + 'попавший в публичную историю ключ считается утёкшим. Храните ключи только в переменных окружения. '
    + 'Осознанное исключение — пометка allow-secret: с причиной на той же строке.';
  process.stdout.write(`СЕКРЕТ В КОДЕ: ${findings.length} находок в новых строках.\n`);
  for (const f of findings) {
    process.stdout.write(github
      ? `::error file=${escapeProperty(f.file)},line=${f.line}::Похоже на секрет — ${f.name}. ${advice}\n`
      : `  ${f.file}:${f.line} — ${f.name}\n`);
  }
  if (!github) process.stdout.write(`${advice}\n`);
  return 1;
}

const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) process.exit(main(process.argv.slice(2)));
