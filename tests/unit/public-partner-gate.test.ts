/**
 * Карточка партнёра на витрине — одно условие (план готовности 23.11, этап 2).
 *
 * 23.11 в публичной выдаче нашлись три служебные карточки: «Тестовый оператор
 * Ведар», «Тестовый гид Ведар» и «Admin». Читатели витрины спрашивали один
 * `is_public`, а отметки «тестовый профиль» у карточек не было — CHECK базы
 * (1495) молчал. Данные поправила миграция 1505; правило теперь одно —
 * `publicPartnerSql` (lib/partners/test-profile.ts): опубликована И не
 * тестовая, и читатель спрашивает это сам.
 *
 * Сторож держит связку, а не половину:
 *   - условия говорят то, что обещают, и реестр гидов их зовёт;
 *   - условие по флагу `is_public`, набранное руками, — только из списка с
 *     причиной: другая таблица либо партнёр, но не витрина. Новая копия
 *     краснеет; список только сокращается;
 *   - у каждого читателя витрины из реестра число вызовов условия не убывает;
 *   - представление `v_route_marketplace` читается только через обёртку
 *     `routeMarketplaceSql`, в которой тестовый профиль уже отсечён.
 *
 * Три находки ревью безопасности PR #3780 записаны здесь делом:
 *   - перепись шла только по `app/` и `lib/`, а серверные компоненты с SQL
 *     лежат и в `components/` — теперь три каталога;
 *   - регулярка знала одно написание (`is_public = TRUE`), а условие пишут и
 *     `COALESCE(is_public, false)`, и голым `WHERE p.is_public`, и через
 *     отрицание (`<> FALSE`, `IS DISTINCT FROM FALSE`) — теперь правило
 *     перевёрнуто: условием витрины считается любое вхождение флага в
 *     условие, кроме явно отбирающих НЕ опубликованное;
 *   - «читатель зовёт условие» судилось по файлу: второй запрос к
 *     представлению в том же файле прошёл бы без отсечки — теперь отсечка
 *     стоит в единственной обёртке, а имя представления вне неё — красный.
 *
 * Сам отбор на настоящей базе, при снятом CHECK, —
 * tests/integration/operators-list.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { publicPartnerSql, testPartnerIdSql, testPartnerTourSql } from '@/lib/partners/test-profile';
import { publicGuideWhere } from '@/lib/guides/visibility';
import { routeMarketplaceSql } from '@/lib/routes/marketplace-view';

const ROOT = process.cwd();

/** Каталоги с кодом, который исполняется на сервере сайта и может нести SQL. */
const SCAN_DIRS = ['app', 'lib', 'components'] as const;

describe('publicPartnerSql: опубликована и не тестовая', () => {
  it('с алиасом и без', () => {
    expect(publicPartnerSql('p')).toBe('(p.is_public = TRUE AND p.is_test IS NOT TRUE)');
    expect(publicPartnerSql('')).toBe('(is_public = TRUE AND is_test IS NOT TRUE)');
  });

  it('алиас — только имя: строка из запроса в SQL не попадёт', () => {
    for (const bad of ['p; DROP TABLE partners', 'p.x', 'p x', "p'", '1p']) {
      expect(() => publicPartnerSql(bad), bad).toThrow(/недопустимый алиас/);
    }
  });

  it('реестр гидов зовёт то же условие', () => {
    expect(publicGuideWhere('g')).toContain(publicPartnerSql('g'));
  });
});

describe('testPartnerIdSql: партнёр по id — тестовый профиль', () => {
  it('подставляет колонку с алиасом и без', () => {
    expect(testPartnerIdSql('v.operator_id')).toBe(
      'EXISTS (SELECT 1 FROM partners test_gate WHERE test_gate.id = v.operator_id AND test_gate.is_test IS TRUE)',
    );
    expect(testPartnerIdSql('operator_id')).toContain('test_gate.id = operator_id ');
  });

  it('колонка — только имя: строка из запроса в SQL не попадёт', () => {
    for (const bad of ['v.operator_id; DROP TABLE partners', 'a.b.c', 'v.operator id', "v.'x'", '1v.id', 'v.', '']) {
      expect(() => testPartnerIdSql(bad), bad).toThrow(/недопустимая колонка/);
    }
  });

  it('шлюз туров спрашивает ту же отметку', () => {
    expect(testPartnerTourSql('ot')).toBe(testPartnerIdSql('ot.operator_id'));
    expect(testPartnerTourSql('')).toBe(testPartnerIdSql('operator_tours.operator_id'));
  });
});

/** Без комментариев: упоминание в тексте не равно условию в запросе. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.') || entry === '__tests__') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split('\\').join('/');

/**
 * Условие по флагу витрины, набранное руками.
 *
 * Правило перевёрнуто (третья находка ревью #3780): перечислять написания
 * «опубликовано» бесполезно — `= TRUE`, `IS NOT FALSE`, `<> FALSE`,
 * `IS DISTINCT FROM FALSE`, `= $1`, двойное отрицание, — каждое следующее
 * проходило бы молча. Поэтому условием витрины считается ЛЮБОЕ вхождение
 * флага в условие, кроме тех, что явно отбирают НЕ опубликованное: `= FALSE`,
 * `IS FALSE`, `IS NOT TRUE`, `<> TRUE`, `IS DISTINCT FROM TRUE`, `NOT флаг`,
 * проверка на NULL. Новое написание по умолчанию — красное.
 */
const FLAG = String.raw`(?:[a-z_][a-z0-9_]*\.)?is_public\b`;

/** Хвост после флага, отбирающий НЕ опубликованное (или не про публикацию вовсе). */
const NON_PUBLIC_TAIL = /^\s*(?:=\s*(?:FALSE\b|'f(?:alse)?')|IS\s+FALSE\b|IS\s+NOT\s+TRUE\b|(?:<>|!=)\s*(?:TRUE\b|'t(?:rue)?')|IS\s+DISTINCT\s+FROM\s+TRUE\b|IS\s+(?:NOT\s+)?NULL\b)/i;
/** Хвост — оператор или проверка: флаг не «голый». */
const HAS_OPERATOR = /^\s*(?:=|<>|!=|<|>|::|IS\b|IN\b|BETWEEN\b|NOT\s+IN\b)/i;
/** Сравнение из кода, а не из SQL: `===`, `==`, `!==`, стрелка. */
const JS_TAIL = /^\s*(?:===?|!==|=>)/;

/** 1. Флаг сразу после слова условия: WHERE · AND · OR · ON · WHEN · HAVING · NOT, со скобками или без. */
const LEADING = new RegExp(String.raw`\b(WHERE|AND|OR|ON|WHEN|HAVING|NOT)\s*\(*\s*${FLAG}([^\n]{0,48})`, 'gi');
/** 2. Флаг в сравнении где угодно: `(p.is_public = TRUE …`, `p.is_public <> FALSE`. */
const COMPARED = new RegExp(String.raw`${FLAG}([^\n]{0,48})`, 'gi');
/** 3. Флаг справа от сравнения: TRUE = is_public, $1 = p.is_public, FALSE <> is_public. */
const REVERSED = new RegExp(String.raw`(\bTRUE|\bFALSE|'t(?:rue)?'|'f(?:alse)?'|\$\d+)\s*(=|<>|!=|IS\s+(?:NOT\s+)?DISTINCT\s+FROM)\s*${FLAG}`, 'gi');
/** 4. Флаг внутри функции SQL: COALESCE(is_public, …); `… ) AS имя` — колонка выдачи, не условие. */
const WRAPPED = new RegExp(String.raw`(?<![.\w])(?:COALESCE|NULLIF|BOOL_OR|BOOL_AND|EVERY|CAST|MAX|MIN|GREATEST|LEAST)\(\s*${FLAG}[^()]*\)(?!\s+AS\b)`, 'gi');

/** Слева от флага — присваивание или список колонок (`SET x =`, `a, b`), а не условие. */
function assignedOrListed(before: string): boolean {
  return /(?:\bSET|,)\s*(?:\$\{[^}]*\})?\s*$/i.test(before);
}

/** Позиции флага, стоящего в условии «опубликовано», набранном руками. */
function rawPublicHits(src: string): Set<number> {
  const text = code(src);
  const hits = new Set<number>();
  const flagPos = (m: RegExpMatchArray) => (m.index ?? 0) + m[0].toLowerCase().indexOf('is_public');

  for (const m of text.matchAll(LEADING)) {
    const negated = m[1].toUpperCase() === 'NOT';
    const tail = m[2];
    if (JS_TAIL.test(tail)) continue;
    const nonPublic = NON_PUBLIC_TAIL.test(tail);
    // NOT флаг — «не опубликовано»; NOT (флаг = FALSE) — двойное отрицание, то есть «опубликовано».
    if (negated ? (nonPublic || HAS_OPERATOR.test(tail)) : !nonPublic) hits.add(flagPos(m));
  }
  for (const m of text.matchAll(COMPARED)) {
    const tail = m[1];
    if (!HAS_OPERATOR.test(tail) || NON_PUBLIC_TAIL.test(tail) || JS_TAIL.test(tail)) continue;
    if (assignedOrListed(text.slice(Math.max(0, (m.index ?? 0) - 80), m.index ?? 0))) continue;
    hits.add(flagPos(m));
  }
  for (const m of text.matchAll(REVERSED)) {
    const lhs = m[1].toUpperCase();
    const op = m[2].toUpperCase().replace(/\s+/g, ' ');
    const lhsTrue = lhs === 'TRUE' || lhs.startsWith("'T");
    const lhsFalse = lhs === 'FALSE' || lhs.startsWith("'F");
    const nonPublic = (lhsFalse && (op === '=' || op === 'IS NOT DISTINCT FROM'))
      || (lhsTrue && (op === '<>' || op === '!=' || op === 'IS DISTINCT FROM'));
    if (!nonPublic) hits.add(flagPos(m));
  }
  for (const m of text.matchAll(WRAPPED)) hits.add(flagPos(m));
  return hits;
}

function rawPublicCount(src: string): number {
  return rawPublicHits(src).size;
}

describe('условие по флагу витрины: какие написания видит сторож', () => {
  it.each([
    ['WHERE p.is_public = TRUE'],
    ['WHERE is_public = true'],
    ['AND p.is_public IS TRUE'],
    ['AND p.is_public IS NOT FALSE'],
    ["WHERE p.is_public = 'true'"],
    ['WHERE TRUE = p.is_public'],
    ['WHERE COALESCE(p.is_public, false)'],
    ['AND COALESCE(is_public, FALSE) = TRUE'],
    ['WHERE p.is_public AND p.slug IS NOT NULL'],
    ['JOIN partners p ON p.id = t.operator_id AND p.is_public'],
    ['WHERE (is_public)'],
    // третья находка ревью #3780: равнозначные «опубликовано» через отрицание
    ['WHERE p.is_public <> FALSE'],
    ['WHERE p.is_public != FALSE'],
    ['WHERE p.is_public IS DISTINCT FROM FALSE'],
    ['WHERE NOT (p.is_public = FALSE)'],
    ['WHERE NOT (p.is_public IS NOT TRUE)'],
    ['WHERE (p.slug = $1) AND (p.is_public <> FALSE)'],
    ['WHERE x IN (SELECT id FROM partners WHERE (is_public IS DISTINCT FROM FALSE))'],
    ['WHERE FALSE <> p.is_public'],
    // значение приходит параметром — на витрине это тоже «опубликовано»
    ['WHERE p.is_public = $1'],
    ['WHERE $2 = p.is_public'],
    ['WHERE p.is_public IN (TRUE)'],
    ['WHERE p.is_public::int = 1'],
    ['HAVING bool_or(p.is_public)'],
    ['COUNT(*) FILTER (WHERE p.is_public)'],
  ])('ловит: %s', (sql) => {
    expect(rawPublicCount(`const q = \`SELECT 1 FROM partners p ${sql}\`;`)).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['SELECT p.is_public, p.name FROM partners p'],
    ['SELECT p.is_public AS operator_public FROM partners p'],
    ['SELECT COALESCE(p.is_public, false)   AS is_public FROM partners p'],
    ['UPDATE partners SET is_public = $1 WHERE id = $2'],
    ['UPDATE partners SET name = $1, is_public = TRUE WHERE id = $2'],
    ['UPDATE partners SET is_public = CASE WHEN $2 THEN FALSE ELSE is_public END'],
    ['INSERT INTO partners (name, is_public) VALUES ($1, $2)'],
    // отбирают НЕ опубликованное
    ['WHERE p.is_public = FALSE'],
    ['WHERE p.is_public IS FALSE'],
    ['WHERE p.is_public IS NOT TRUE'],
    ['WHERE p.is_public <> TRUE'],
    ['WHERE p.is_public IS DISTINCT FROM TRUE'],
    ['WHERE NOT p.is_public'],
    ['WHERE NOT (p.is_public)'],
    ['WHERE FALSE = p.is_public'],
    ['WHERE p.is_public IS NULL'],
  ])('не считает условием витрины: %s', (sql) => {
    expect(rawPublicCount(`const q = \`${sql}\`;`)).toBe(0);
  });

  it('не считает условием код вне SQL и комментарии', () => {
    expect(rawPublicCount('const shown = rows[0]?.is_public === true;')).toBe(0);
    expect(rawPublicCount('if (row.is_public && row.slug) run();')).toBe(0);
    expect(rawPublicCount('const x = { is_public: true, name };')).toBe(0);
    expect(rawPublicCount('const [published, setPublished] = useState(trip.is_public === true);')).toBe(0);
    expect(rawPublicCount('const shown = Boolean(row.is_public) && Math.max(a, b);')).toBe(0);
    expect(rawPublicCount('// WHERE p.is_public = TRUE\n/* AND is_public IS TRUE */')).toBe(0);
  });

  it('само условие публикации — одно сравнение', () => {
    expect(rawPublicCount(`const q = \`${publicPartnerSql('p')}\`;`)).toBe(1);
  });
});

const OTHER_TABLE = 'другая таблица';
const NOT_STOREFRONT = 'партнёр, не витрина';

/**
 * Файл → сколько раз условие по `is_public` набрано руками и почему это не
 * витрина партнёров. Только сокращается: убрал условие — уменьши число, убрал
 * все — удали запись. Витрины партнёров здесь нет и быть не может.
 */
const KNOWN_RAW: Record<string, { n: number; why: string }> = {
  'lib/partners/test-profile.ts': { n: 1, why: `${NOT_STOREFRONT}: само условие publicPartnerSql` },
  'app/api/leads/route.ts': { n: 1, why: `${NOT_STOREFRONT}: адресат заявки по слагу — включён виджет или карточка опубликована; заявка идёт партнёру, а не на общую витрину` },
  'lib/account/erase.ts': { n: 1, why: `${NOT_STOREFRONT}: проверка перед удалением аккаунта — есть ли у человека опубликованная карточка` },
  'app/api/admin/operators/[id]/route.ts': { n: 1, why: `${NOT_STOREFRONT}: дверь одобрения администратора ПИШЕТ флаг (SET в несколько строк), а не отбирает по нему` },
  'app/api/admin/content/partners/[id]/route.ts': { n: 1, why: `${NOT_STOREFRONT}: дверь правки карточки администратором ПИШЕТ флаг (SET собирается по частям), а не отбирает по нему` },
  'app/api/collections/[slug]/route.ts': { n: 1, why: `${OTHER_TABLE}: collections` },
  'lib/collections/list.ts': { n: 1, why: `${OTHER_TABLE}: collections` },
  'lib/seo/sitemap-entries.ts': { n: 1, why: `${OTHER_TABLE}: collections` },
  'app/api/guide/reviews/route.ts': { n: 3, why: `${OTHER_TABLE}: guide_reviews` },
  'app/api/cron/guide-readiness/route.ts': { n: 1, why: `${OTHER_TABLE}: guide_reviews` },
  'lib/auth/guide-helpers.ts': { n: 2, why: `${OTHER_TABLE}: guide_reviews` },
  'lib/guides/chat-role/store.ts': { n: 2, why: `${OTHER_TABLE}: guide_reviews` },
  'lib/trips/shared-plan.ts': { n: 1, why: `${OTHER_TABLE}: trips — ссылка на план поездки` },
};

/**
 * Читатели витрины партнёров: файл, чью витрину он кормит и сколько раз зовёт
 * условие (`publicPartnerSql`, у гидов — `publicGuideWhere`). Число вызовов не
 * убывает: убрал отбор — убери запись и объясни в PR, чем он заменён.
 */
const STOREFRONT_READERS: Record<string, { n: number; what: string }> = {
  'app/api/partners/route.ts': { n: 1, what: 'публичный список партнёров /api/partners' },
  'app/operators/[slug]/page.tsx': { n: 1, what: 'страница компании и короткий адрес' },
  'app/api/operators/[slug]/route.ts': { n: 1, what: 'карточка компании по слагу' },
  'lib/operators/list-query.ts': { n: 1, what: 'список /operators, /api/operators, ссылки в Telegram' },
  'lib/seo/partner-sitemap.ts': { n: 1, what: 'sitemap страниц компаний и гидов' },
  'lib/seo/sitemap-entries.ts': { n: 3, what: 'sitemap перевозчиков, прокатчиков и счёт гидов' },
  'lib/guides/visibility.ts': { n: 1, what: 'реестр гидов /guides и профиль /guides/[id]' },
  'lib/transfers/charter.ts': { n: 2, what: 'список перевозчиков и страница /transfers/[slug]' },
  'lib/transfers/carrier-reviews.ts': { n: 1, what: 'отзывы перевозчика' },
  'lib/rental/rental.ts': { n: 2, what: 'список прокатчиков и страница /car-rental/[slug]' },
  'app/llms.txt/route.ts': { n: 1, what: 'llms.txt — перевозчики' },
  'app/api/tours-feed/route.ts': { n: 1, what: 'фид туров для площадок' },
  'app/api/planner/partners/route.ts': { n: 1, what: 'планер — операторы под интересы' },
  'lib/planner/data.ts': { n: 3, what: 'планер — туры операторов' },
  'lib/planner/day-options-query.ts': { n: 1, what: 'планер — варианты дня' },
  'lib/partner-sites/load.ts': { n: 1, what: 'сайт партнёра' },
  'lib/octo/service.ts': { n: 2, what: 'OCTO — поставщики для площадок' },
  'lib/notifications/telegram-channel.ts': { n: 1, what: 'пост о компании в канал' },
  'lib/eco/compensation.ts': { n: 1, what: 'эко — активные операторы' },
  'app/api/cron/leads-followup/route.ts': { n: 3, what: 'добивка лидов — кому уходит заявка без адресата' },
  'app/api/home/metrics/route.ts': { n: 1, what: 'счётчик проверенных партнёров в публичном API' },
};

describe('условие по is_public мимо общего условия', () => {
  const found = new Map<string, number>();
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const n = rawPublicCount(readFileSync(file, 'utf-8'));
      if (n > 0) found.set(rel(file), n);
    }
  }

  it('перепись не пуста: сторож видит известные условия', () => {
    expect(found.get('lib/partners/test-profile.ts')).toBe(1);
    expect(found.size).toBeGreaterThan(5);
  });

  it('каждое условие — в списке с причиной; новой копии быть не может', () => {
    const unknown = [...found.keys()].filter((f) => !(f in KNOWN_RAW));
    expect(
      unknown,
      'Условие по is_public набрано руками. Карточка партнёра для туриста — позовите '
      + 'publicPartnerSql (lib/partners/test-profile.ts); другая таблица или не витрина — '
      + 'внесите файл в KNOWN_RAW с причиной.',
    ).toEqual([]);
  });

  it('число условий в файле не растёт, а запись без условий — удаляется', () => {
    for (const [file, { n }] of Object.entries(KNOWN_RAW)) {
      expect(found.get(file) ?? 0, file).toBe(n);
    }
  });

  it('причина — одна из двух: другая таблица либо партнёр, но не витрина', () => {
    for (const [file, { why }] of Object.entries(KNOWN_RAW)) {
      expect(why.startsWith(`${OTHER_TABLE}: `) || why.startsWith(`${NOT_STOREFRONT}: `), file).toBe(true);
    }
  });
});

describe('читатели витрины партнёров зовут условие', () => {
  it.each(Object.entries(STOREFRONT_READERS))('%s', (file, { n, what }) => {
    const calls = (code(readFileSync(join(ROOT, file), 'utf-8')).match(/\b(?:publicPartnerSql|publicGuideWhere)\(/g) ?? []).length;
    // Определение условия в его собственном файле вызовом не считается.
    const own = file === 'lib/guides/visibility.ts' ? 1 : 0;
    expect(calls - own, `${file} — ${what}: отбор без условия витрины`).toBeGreaterThanOrEqual(n);
  });

  it('читатель не числится и витриной, и исключением', () => {
    const both = Object.keys(STOREFRONT_READERS).filter((f) => f in KNOWN_RAW && !KNOWN_RAW[f].why.startsWith(OTHER_TABLE));
    expect(both).toEqual([]);
  });
});

/**
 * Представление `v_route_marketplace` держит свою копию флагов в SQL
 * (миграция 056) и отметки тестового профиля не знает. Читать его можно
 * только через обёртку — в ней тестовый профиль отсечён, и отсечка
 * принадлежит каждому запросу по построению, а не памяти автора.
 */
describe('v_route_marketplace читается только через обёртку', () => {
  const WRAPPER = 'lib/routes/marketplace-view.ts';

  it('обёртка — подзапрос, в котором тестовый профиль отсечён', () => {
    const sql = routeMarketplaceSql('v');
    expect(sql).toMatch(/^\(SELECT gated_view\.\* FROM v_route_marketplace gated_view/);
    expect(sql).toContain(`WHERE NOT ${testPartnerIdSql('gated_view.operator_id')}`);
    expect(sql).toMatch(/\) v$/);
  });

  it('алиас — только имя', () => {
    for (const bad of ['v; DROP VIEW v_route_marketplace', 'v.x', 'v x', '']) {
      expect(() => routeMarketplaceSql(bad), bad).toThrow(/недопустимый алиас/);
    }
  });

  it('имя представления в коде встречается только в обёртке', () => {
    const readers: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        if (/\bv_route_marketplace\b/.test(code(readFileSync(file, 'utf-8')))) readers.push(rel(file));
      }
    }
    expect(
      readers,
      'Прямое чтение v_route_marketplace: представление не знает отметки тестового профиля. '
      + 'Читайте через routeMarketplaceSql (lib/routes/marketplace-view.ts).',
    ).toEqual([WRAPPER]);
  });

  it('читатели представления зовут обёртку', () => {
    for (const file of ['lib/routes/route-detail.ts', 'lib/routes/route-tour-price.ts', 'app/api/operators/[slug]/routes/route.ts']) {
      expect(code(readFileSync(join(ROOT, file), 'utf-8')), file).toMatch(/routeMarketplaceSql\(/);
    }
  });
});
