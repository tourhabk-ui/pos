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
 *   - условие говорит то, что обещает, и реестр гидов его зовёт;
 *   - сравнение `is_public = TRUE` руками в `app/` и `lib/` — только из
 *     списка с причиной: другая таблица либо партнёр, но не витрина. Новая
 *     копия краснеет; список только сокращается;
 *   - каждый читатель витрины из реестра зовёт условие;
 *   - представление `v_route_marketplace` держит свою копию флагов в SQL и
 *     отметки тестового профиля не знает (ревью безопасности #3780): каждый,
 *     кто его читает, спрашивает отметку сам.
 * Сам отбор на настоящей базе, при снятом CHECK, —
 * tests/integration/operators-list.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { publicPartnerSql, testPartnerIdSql, testPartnerTourSql } from '@/lib/partners/test-profile';
import { publicGuideWhere } from '@/lib/guides/visibility';

const ROOT = process.cwd();

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

/** Без комментариев: упоминание в тексте не равно сравнению в запросе. */
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

/** Сравнение флага витрины с «да», набранное руками. */
const RAW_PUBLIC = /\bis_public\s*(?:=|IS)\s*TRUE\b/gi;

const OTHER_TABLE = 'другая таблица';
const NOT_STOREFRONT = 'партнёр, не витрина';

/**
 * Файл → сколько раз `is_public = TRUE` набрано руками и почему это не
 * витрина партнёров. Только сокращается: убрал сравнение — уменьши число,
 * убрал все — удали запись. Витрины партнёров здесь нет и быть не может.
 */
const KNOWN_RAW: Record<string, { n: number; why: string }> = {
  'lib/partners/test-profile.ts': { n: 1, why: `${NOT_STOREFRONT}: само условие publicPartnerSql` },
  'app/api/leads/route.ts': { n: 1, why: `${NOT_STOREFRONT}: адресат заявки по слагу — включён виджет или карточка опубликована; заявка идёт партнёру, а не на общую витрину` },
  'lib/account/erase.ts': { n: 1, why: `${NOT_STOREFRONT}: проверка перед удалением аккаунта — есть ли у человека опубликованная карточка` },
  'app/api/collections/[slug]/route.ts': { n: 1, why: `${OTHER_TABLE}: collections` },
  'lib/collections/list.ts': { n: 1, why: `${OTHER_TABLE}: collections` },
  'lib/seo/sitemap-entries.ts': { n: 1, why: `${OTHER_TABLE}: collections` },
  'app/api/guide/reviews/route.ts': { n: 3, why: `${OTHER_TABLE}: guide_reviews` },
  'app/api/cron/guide-readiness/route.ts': { n: 1, why: `${OTHER_TABLE}: guide_reviews` },
  'lib/auth/guide-helpers.ts': { n: 2, why: `${OTHER_TABLE}: guide_reviews` },
  'lib/guides/chat-role/store.ts': { n: 2, why: `${OTHER_TABLE}: guide_reviews` },
  'app/api/trips/[id]/share/route.ts': { n: 1, why: `${OTHER_TABLE}: trips — ссылка на план поездки` },
  'lib/trips/shared-plan.ts': { n: 1, why: `${OTHER_TABLE}: trips — ссылка на план поездки` },
};

/**
 * Читатели витрины партнёров: файл и чью витрину он кормит. Каждый обязан
 * звать `publicPartnerSql` (реестр гидов — через `publicGuideWhere`).
 */
const STOREFRONT_READERS: Record<string, string> = {
  'app/api/partners/route.ts': 'публичный список партнёров /api/partners',
  'app/operators/[slug]/page.tsx': 'страница компании и короткий адрес',
  'app/api/operators/[slug]/route.ts': 'карточка компании по слагу',
  'lib/operators/list-query.ts': 'список /operators, /api/operators, ссылки в Telegram',
  'lib/seo/partner-sitemap.ts': 'sitemap страниц компаний и гидов',
  'lib/seo/sitemap-entries.ts': 'sitemap перевозчиков и прокатчиков',
  'lib/guides/visibility.ts': 'реестр гидов /guides и профиль /guides/[id]',
  'lib/transfers/charter.ts': 'список перевозчиков и страница /transfers/[slug]',
  'lib/transfers/carrier-reviews.ts': 'отзывы перевозчика',
  'lib/rental/rental.ts': 'список прокатчиков и страница /car-rental/[slug]',
  'app/llms.txt/route.ts': 'llms.txt — перевозчики',
  'app/api/tours-feed/route.ts': 'фид туров для площадок',
  'app/api/planner/partners/route.ts': 'планер — операторы под интересы',
  'lib/planner/data.ts': 'планер — туры операторов',
  'lib/planner/day-options-query.ts': 'планер — варианты дня',
  'lib/partner-sites/load.ts': 'сайт партнёра',
  'lib/octo/service.ts': 'OCTO — поставщики для площадок',
  'lib/notifications/telegram-channel.ts': 'пост о компании в канал',
  'lib/eco/compensation.ts': 'эко — активные операторы',
  'app/api/cron/leads-followup/route.ts': 'добивка лидов — кому уходит заявка без адресата',
  'app/api/home/metrics/route.ts': 'счётчик проверенных партнёров в публичном API',
};

describe('сравнение is_public мимо условия', () => {
  const found = new Map<string, number>();
  for (const dir of ['app', 'lib']) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const n = (code(readFileSync(file, 'utf-8')).match(RAW_PUBLIC) ?? []).length;
      if (n > 0) found.set(relative(ROOT, file).split('\\').join('/'), n);
    }
  }

  it('перепись не пуста: сторож видит известные сравнения', () => {
    expect(found.get('lib/partners/test-profile.ts')).toBe(1);
    expect(found.size).toBeGreaterThan(5);
  });

  it('каждое сравнение — в списке с причиной; новой копии быть не может', () => {
    const unknown = [...found.keys()].filter((f) => !(f in KNOWN_RAW));
    expect(
      unknown,
      'Сравнение is_public = TRUE набрано руками. Карточка партнёра для туриста — позовите '
      + 'publicPartnerSql (lib/partners/test-profile.ts); другая таблица или не витрина — '
      + 'внесите файл в KNOWN_RAW с причиной.',
    ).toEqual([]);
  });

  it('число сравнений в файле не растёт, а запись без сравнений — удаляется', () => {
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

/**
 * Читатели представления `v_route_marketplace`. Его WHERE записан в SQL
 * (миграция 056: три флага тура и `p.is_public = true`) и ни шлюза туров, ни
 * условия витрины позвать не может — отметку тестового профиля спрашивает
 * читатель. Новый читатель представления без неё краснеет.
 */
const VIEW_READERS: Record<string, string> = {
  'lib/routes/route-detail.ts': 'туры на карточке маршрута',
  'lib/routes/route-tour-price.ts': 'цена маршрута «от» в каталоге',
  'app/api/operators/[slug]/routes/route.ts': 'маршруты на странице компании',
};

describe('читатели v_route_marketplace спрашивают отметку тестового профиля', () => {
  const readers: string[] = [];
  for (const dir of ['app', 'lib']) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      if (/\bv_route_marketplace\b/.test(code(readFileSync(file, 'utf-8')))) {
        readers.push(relative(ROOT, file).split('\\').join('/'));
      }
    }
  }

  it('перепись читателей совпадает с реестром: нового читателя без записи нет', () => {
    expect(readers.sort()).toEqual(Object.keys(VIEW_READERS).sort());
  });

  it.each(Object.entries(VIEW_READERS))('%s — %s', (file) => {
    const src = code(readFileSync(join(ROOT, file), 'utf-8'));
    expect(src).toMatch(/testPartnerIdSql\(|publicPartnerSql\(/);
  });
});

describe('читатели витрины партнёров зовут условие', () => {
  it.each(Object.entries(STOREFRONT_READERS))('%s — %s', (file) => {
    const src = code(readFileSync(join(ROOT, file), 'utf-8'));
    expect(src).toMatch(/publicPartnerSql\(/);
    expect(src).toMatch(/from '@\/lib\/partners\/test-profile'/);
  });

  it('читатель не числится и витриной, и исключением', () => {
    const both = Object.keys(STOREFRONT_READERS).filter((f) => f in KNOWN_RAW && !KNOWN_RAW[f].why.startsWith(OTHER_TABLE));
    expect(both).toEqual([]);
  });
});
