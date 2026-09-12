/**
 * Секция `config` объявлена — значит её кто-то читает.
 *
 * ── Откуда правило ─────────────────────────────────────────────────────────
 *
 * 11.09.2026, разбор дайджеста: DeepSeek выводит `deepseek-v4-pro` 14.09.
 * Живой путь это переживал — модель там берётся из `/v1/models`
 * (`lib/ai/model-resolver.ts`), id не прибит. А в `lib/config.ts` лежало:
 *
 *     deepseek: { model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro', ... }
 *
 * Дефолт — ровно та модель, которую выводят. Рядом `grok-4`,
 * `abab6.5s-chat`, `meta-llama/llama-3.1-70b-instruct` (лето 2024). И ни один
 * из четырёх блоков не читал НИКТО.
 *
 * Опасность не в том, что мёртвая строка сломается: мёртвое не ломается.
 * Опасность в том, что читающий ей верит. Блок с `apiKey`, `baseUrl`,
 * `model`, `timeout` выглядит как место, где у платформы настраиваются
 * модели, — и следующий, кому понадобится сменить модель, поменяет здесь и
 * будет ждать эффекта. Эффекта не будет, а искать причину он пойдёт не в
 * конфиг, а в провайдеров.
 *
 * Отдельной строкой то же самое было с бюджетом: `dailyBudget` в конфиге и
 * `process.env.AI_DAILY_BUDGET_USD` в `/api/cron/llm-budget-check`, который
 * читает env МИМО конфига. Два источника одного числа, и расходиться им
 * ничто не мешало.
 *
 * §4.0, «Объявленный исход без источника»: у объявленного обязан быть
 * производитель, потребитель и сторож, который держит связку. Конфиг — это
 * объявление; этот файл — сторож.
 *
 * ── Почему реестр, а не «почините всё» ─────────────────────────────────────
 *
 * Перепись того же дня: из четырнадцати секций конфига читаются пять.
 * Остальные девять — такие же обещания, но сносить их вслепую нельзя, и
 * причины у каждой РАЗНЫЕ: `security` описывает CORS и CSP, которые живут в
 * `middleware.ts` (§7 — не трогать), `payments` — денежный путь (§7 тоже),
 * `cache` и `monitoring` описывают инфраструктуру, которой в платформе нет
 * вовсе.
 *
 * Требовать разбора всех девяти от следующей правки — способ выключить
 * сторож в первую же неделю (урок `schema-coverage` и реестра провайдеров).
 * Поэтому список ЗАМОРОЖЕН и может только сокращаться: новая секция без
 * потребителя валит сборку сразу, а старая — записана с причиной.
 *
 * Реестр САМОУСТАРЕВАЮЩИЙ: как только у секции появляется потребитель, тест
 * требует убрать её отсюда. Запись, пережившая свою причину, — это ровно то
 * объявление без источника, от которого весь этот файл.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILE = 'lib/config.ts';
const ROOTS = ['app', 'lib', 'components', 'hooks', 'scripts', 'instrumentation.ts'];

/**
 * Секции без потребителя, оставленные осознанно. Причина обязательна и
 * должна называть, ГДЕ на самом деле живёт это решение, — иначе следующий
 * читающий не отличит «разобрано и оставлено» от «не дошли руки».
 */
const KNOWN_UNCONSUMED: Record<string, string> = {
  files: 'Загрузка файлов идёт через свои роуты со своими проверками; FILE_UPLOAD_PATH и CDN_URL не читает никто, кроме tests/setup.ts. Единой двери нет — заводить её надо сразу для всех, а не сносить эту вслепую.',
  payments: 'Денежный путь под §7 (app/api/payments не трогать). Вдобавок блок описывает ЮKassa и Stripe, а живых приёмника три и другие: CloudPayments (два) и СБП Точка.',
  notifications: 'SMTP, SMS и Telegram настраиваются в своих модулях (lib/notifications/*, lib/telegram/*) и читают process.env напрямую. Этот блок — копия, разошедшаяся с ними: sms.ts до 11.09 импортировал config и не обращался к нему ни разу.',
  cache: 'Redis в платформе не поднят: упоминания есть только в middleware.ts (§7) и lib/sales/bot-ceo.ts, и оба идут мимо конфига. Блок описывает инфраструктуру, которой нет.',
  monitoring: 'Prometheus не поднят вовсе — ни одного упоминания в коде вне этого блока. Чистое объявление без источника, снимается вместе с решением, нужен ли он.',
  security: 'CORS, rate-limit и CSP живут в middleware.ts и next.config, а middleware под §7. Снимать блок отсюда можно только вместе со сверкой с реальным Edge-слоем, иначе рискуем счесть мёртвым то, что просто объявлено в другом месте.',
  development: 'Флаги дублируют NODE_ENV, который весь код читает напрямую. Безвредно, но это второй источник одного факта.',
  production: 'Идентификаторы аналитики читаются компонентами из NEXT_PUBLIC_* напрямую (components/shared/YandexMetrika.tsx, lib/analytics/lead-tracking.ts). Здесь лежат их серверные тёзки без NEXT_PUBLIC_, то есть заведомо другие переменные.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    const p = join(process.cwd(), root);
    try {
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else out.push(p);
    } catch {
      // Корня нет — это факт о репозитории, а не отказ проверки: остальные
      // корни проверяются как обычно.
    }
  }
  return out;
}

/** Верхнеуровневые ключи литерала `export const config = {...}`. */
function configSections(src: string): string[] {
  const start = src.indexOf('export const config = {');
  expect(start, 'литерал config не найден — сторож не о том файле').toBeGreaterThan(-1);

  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  expect(end, 'литерал config не закрыт — разбор ненадёжен').toBeGreaterThan(start);

  const body = src.slice(start, end);
  const sections: string[] = [];
  let d = 0;
  for (const line of body.split('\n')) {
    // Ключи верхнего уровня — те, что встретились на глубине 1.
    const m = d === 1 ? line.match(/^\s{2}([a-zA-Z][a-zA-Z0-9_]*):\s/) : null;
    if (m) sections.push(m[1]);
    for (const ch of line) {
      if (ch === '{' || ch === '[') d++;
      else if (ch === '}' || ch === ']') d--;
    }
  }
  return sections;
}

/**
 * Файлы, которые импортируют именно `config` (не `getPublicBaseUrl` и не
 * `isTechnicalHost`). Спрашивать импорт обязательно: в репозитории полно
 * локальных переменных с именем `config`, и без этого фильтра чужая
 * `config.headers` зачла бы секцию как живую. Ложная зелёная проверка хуже
 * отсутствующей.
 */
function configConsumers(): string[] {
  const files = sourceFiles().filter((p) => !p.endsWith(CONFIG_FILE));
  return files.filter((p) => {
    const src = readFileSync(p, 'utf8');
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]@\/lib\/config['"]/);
    if (!m) return false;
    return m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).includes('config');
  });
}

describe('config: у объявленной секции есть потребитель', () => {
  const configSrc = readFileSync(join(process.cwd(), CONFIG_FILE), 'utf8');
  const sections = configSections(configSrc);

  // Читатели снаружи плюс сам lib/config.ts ПОСЛЕ литерала: validateConfig
  // живёт в том же файле и является полноценным потребителем — её зовёт
  // instrumentation.ts при старте.
  const afterLiteral = configSrc.slice(configSrc.indexOf('};', configSrc.indexOf('export const config = {')));
  const consumerSources = [
    afterLiteral,
    ...configConsumers().map((p) => readFileSync(p, 'utf8')),
  ];

  function isConsumed(section: string): boolean {
    const re = new RegExp(`config\\.${section}\\b`);
    return consumerSources.some((src) => re.test(src));
  }

  it('литерал разобран: секции найдены', () => {
    expect(sections.length).toBeGreaterThan(5);
    expect(sections).toContain('ai');
    expect(sections).toContain('database');
  });

  it('каждая секция либо читается, либо записана в реестр с причиной', () => {
    const orphans = sections.filter((s) => !isConsumed(s) && !(s in KNOWN_UNCONSUMED));
    expect(
      orphans,
      `Секции config без единого потребителя и без записи в KNOWN_UNCONSUMED: ${orphans.join(', ')}. ` +
      'Либо заведите потребителя в том же PR, либо удалите секцию, либо внесите её в реестр с причиной. ' +
      'Конфиг, который никто не читает, — это обещание механизма, которого нет (§4.0).',
    ).toEqual([]);
  });

  it('реестр самоустаревающий: у записи не появилось потребителя', () => {
    const revived = Object.keys(KNOWN_UNCONSUMED).filter((s) => sections.includes(s) && isConsumed(s));
    expect(
      revived,
      `Секции ${revived.join(', ')} теперь кто-то читает — уберите их из KNOWN_UNCONSUMED. ` +
      'Запись, пережившая свою причину, врёт следующему читающему ровно так же, как мёртвый конфиг.',
    ).toEqual([]);
  });

  it('реестр не помнит того, чего в конфиге уже нет', () => {
    const stale = Object.keys(KNOWN_UNCONSUMED).filter((s) => !sections.includes(s));
    expect(stale, `В KNOWN_UNCONSUMED записаны несуществующие секции: ${stale.join(', ')}`).toEqual([]);
  });

  it('у каждой записи реестра есть внятная причина', () => {
    for (const [section, reason] of Object.entries(KNOWN_UNCONSUMED)) {
      expect(reason.length, `Причина для «${section}» слишком короткая: она должна говорить, ГДЕ живёт решение`)
        .toBeGreaterThan(40);
    }
  });

  it('секция ai не воскрешает захардкоженные id моделей (§8)', () => {
    const aiStart = configSrc.indexOf('  ai: {');
    const aiBody = configSrc.slice(aiStart, configSrc.indexOf('\n  },', aiStart));
    // §8: модель берут из /v1/models, id в коде не прибивают. Конфиг — самое
    // соблазнительное место нарушить это правило: там id выглядит настройкой.
    expect(aiBody).not.toMatch(/deepseek-v4|grok-\d|abab|llama-3|claude-(opus|sonnet|haiku)-\d/);
  });
});
