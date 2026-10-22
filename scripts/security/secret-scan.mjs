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
 * Род ключа и его форма. Формы — опубликованные провайдерами префиксы и
 * длины, а не «похоже на случайное»: энтропийный поиск на коде с хешами,
 * base64-снимками и UUID шумит так, что его перестают читать.
 *
 * @type {ReadonlyArray<{ name: string; re: RegExp; ignore?: (m: RegExpMatchArray) => boolean }>}
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
      const m = text.match(p.re);
      if (!m || (p.ignore && p.ignore(m))) continue;
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
