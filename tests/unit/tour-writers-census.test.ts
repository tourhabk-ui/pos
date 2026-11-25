/**
 * Перепись писателей таблицы туров (слово владельца 23.11): «Автоматы (кроны
 * описаний и фото, импортёры) пишут в туры только через очередь проверки,
 * своих обходных путей у них нет».
 *
 * До этого дня единого перечня не было: сторож этапа 4 смотрел только на
 * кабинеты владельца, а кроны, исполнители и импортёры под него не попадали.
 * Здесь назван каждый файл, в котором есть запись в `operator_tours`, и род
 * этой записи. Новый писатель — красный, пока не назван; исчезнувший —
 * красный, пока не вычеркнут.
 *
 * Регулярка по исходнику здесь законна: это запрет («своей записи содержания
 * быть не должно»), а не проверка поведения. Поведение дверей судят
 * tests/integration/tour-moderation.pg.test.ts и tour-automaton.pg.test.ts.
 *
 * Усилено 25.11 по ревью безопасности PR #3804. Перепись молчала там, где
 * PostgreSQL запись принимает:
 *  - имя таблицы в кавычках, со схемой, с `ONLY`, ключевые слова в другом
 *    регистре, `MERGE`, `COPY`, `DELETE` — теперь всё это запись;
 *  - код вне `app`, `lib` и `scripts` — теперь обходится весь репозиторий
 *    (tests/helpers/repo-code.ts называет, что пропущено и почему);
 *  - колонка после подзапроса со своим `WHERE` («SET review_count = (SELECT …
 *    WHERE …), description = $1») — список SET разбирается по скобкам;
 *  - вставка (`INSERT`, `ON CONFLICT … DO UPDATE SET`) — проверяется тоже.
 *
 * Чего перепись не видит и что названо: имя таблицы из переменной
 * (`UPDATE ${table}`), SQL в файлах `.sql` / `.sh` / `.yml`. Список SET,
 * который разобрать не удалось, — отказ, а не «содержания нет» (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MODERATED_TOUR_COLUMNS } from '@/lib/tours/moderation';
import { REPO_CODE_SKIPPED, repoCodeFiles } from '../helpers/repo-code';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

/** Имя таблицы так, как его принимает PostgreSQL: `ONLY`, схема, кавычки. */
const TABLE = String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?operator_tours"?(?![\w"])`;
const sql = (head: string, flags = 'i') => new RegExp(String.raw`\b${head}\s+${TABLE}`, flags);

const INSERT = String.raw`insert\s+into`;
const NOT_UPDATE = String.raw`(?:${INSERT}|merge\s+into|copy|delete\s+from|truncate(?:\s+table)?)`;
/** Любая запись в таблицу туров, в любом регистре. */
const WRITES = sql(String.raw`(?:update|${NOT_UPDATE})`);

type Kind =
  /** Общая запись тура: её зовут только дверь правки и одобрение. */
  | 'door'
  /** Заводит новый тур: на сайт он выйдет только после одобрения публикации. */
  | 'creates'
  /** Дверь администратора: он и есть проверка. */
  | 'admin'
  /** Пишет только колонки вне списка содержания — сторож это проверяет. */
  | 'not_content'
  /** Служебное: тестовый тур оплаты, разбор запроса без выполнения. */
  | 'service'
  /** Перенос связи при слиянии мест: место то же, адрес записи другой. */
  | 'place_merge'
  /** Автомат, который ещё пишет содержание мимо очереди. Список может только сокращаться. */
  | 'bypass_known';

const WRITERS: Record<string, { kind: Kind; why: string }> = {
  'lib/tours/tour-write.ts': { kind: 'door', why: 'writeTourPatch — единственная общая запись правки тура' },

  'lib/api/operator-tours.ts': { kind: 'creates', why: 'createTour: новый тур оператора; удаление — отметка deleted_at' },
  'lib/guides/own-tour-create.ts': { kind: 'creates', why: 'новый тур гида, is_published = FALSE' },
  'lib/agents/agencies/operator-agency.ts': { kind: 'creates', why: 'ИИ-чат оператора заводит тур неопубликованным' },
  'lib/services/tours/tours-visitkamchatka.ts': { kind: 'creates', why: 'импорт заводит тур неопубликованным; существующие не трогает' },

  'app/api/admin/content/tours/[id]/route.ts': { kind: 'admin', why: 'правка администратора' },
  'app/api/admin/operator-tours/[id]/route.ts': { kind: 'admin', why: 'правка администратора' },

  'app/api/admin/tour-reviews/[id]/route.ts': { kind: 'not_content', why: 'рейтинг и число отзывов после модерации отзыва' },
  'app/api/reviews/tour/[tourId]/route.ts': { kind: 'not_content', why: 'рейтинг и число отзывов' },
  'app/api/cron/routes-dedup/route.ts': { kind: 'not_content', why: 'перевешивает route_id при слиянии дублей маршрутов' },
  'lib/services/data-repair.ts': { kind: 'not_content', why: 'починка route_id' },
  'app/api/operator/tours/[id]/deactivate/route.ts': { kind: 'not_content', why: 'скрыть тур — сразу, это не содержание' },
  'app/api/operator/tours/[id]/generate-tags/route.ts': { kind: 'not_content', why: 'ai_tags — служебные метки поиска' },
  'app/api/operator/tours/auto-fill-ai/route.ts': { kind: 'not_content', why: 'заметки заполнения; содержание уходит дверью владельца' },
  'lib/guides/own-tour-publish.ts': { kind: 'not_content', why: 'скрыть, показать и снять с публикации — сразу' },

  'app/api/cron/payment-test-setup/route.ts': { kind: 'service', why: 'служебный тур проверки оплаты у тестового партнёра' },
  'app/api/cron/sql-shape-check/route.ts': { kind: 'service', why: 'PREPARE: запрос разбирается, но не выполняется' },

  'lib/places/merge-carry.ts': { kind: 'place_merge', why: 'слияние мест переносит main_place_id на оставшуюся запись' },

  'lib/agents/execution/handlers/ab-scale-executor.ts': { kind: 'bypass_known', why: 'скидка победившей группы: base_price и price_old прямым UPDATE' },
  'lib/agents/execution/initiative-executor.ts': { kind: 'bypass_known', why: 'описание, переписанное моделью, прямым UPDATE' },
  'lib/services/operators/operator-tour-scraper.ts': { kind: 'bypass_known', why: 'импорт с сайта оператора правит цену и состав существующего тура' },
  'lib/services/tours/tour.service.ts': { kind: 'bypass_known', why: 'старый сервис туров: вызывающих не найдено, разобрать и удалить' },
  'scripts/scrape-operator-tours.js': { kind: 'bypass_known', why: 'скрипт импорта: пишет туры своим запросом' },
};

const CODE = repoCodeFiles(ROOT);
const FOUND = CODE.filter((f) => WRITES.test(read(f)));

// ─── Разбор запроса ───────────────────────────────────────────────────────────

/**
 * Идёт по тексту SQL и зовёт `at` только на ВЕРХНЕМ уровне: содержимое скобок,
 * строк в одинарных кавычках, комментариев `--` и вставок `${…}` пропускается.
 * Возвращает место остановки: `at` сказал «стоп», встретилась лишняя «)» либо
 * кончился текст.
 */
function scanTop(src: string, from: number, at: (i: number, ch: string) => boolean): number {
  let depth = 0;
  let i = from;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return src.length;
      i = end;
    } else if (ch === '-' && src[i + 1] === '-') {
      const end = src.indexOf('\n', i);
      if (end === -1) return src.length;
      i = end;
    } else if (ch === '$' && src[i + 1] === '{') {
      let braces = 0;
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === '{') braces += 1;
        else if (src[i] === '}' && (braces -= 1) === 0) break;
      }
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && at(i, ch)) {
      return i;
    }
  }
  return i;
}

/** Кусок от `from` до конца оператора либо до слова из `stop` на верхнем уровне. */
function clause(src: string, from: number, stop: RegExp | null): string {
  const end = scanTop(src, from, (i, ch) => {
    if (ch === '`' || ch === ';') return true;
    return stop !== null && /[A-Za-z]/.test(ch) && !/[\w.]/.test(src[i - 1] ?? ' ') && stop.test(src.slice(i, i + 16));
  });
  return src.slice(from, end);
}

/** Делит список по запятым верхнего уровня. */
function splitTop(list: string): string[] {
  const cuts: number[] = [];
  scanTop(list, 0, (i, ch) => {
    if (ch === ',') cuts.push(i);
    return false;
  });
  const parts: string[] = [];
  let start = 0;
  for (const cut of [...cuts, list.length]) {
    parts.push(list.slice(start, cut).trim());
    start = cut + 1;
  }
  return parts.filter((p) => p !== '');
}

const name = (raw: string) => raw.trim().replace(/^"|"$/g, '').toLowerCase();

interface Assignment { column: string; value: string }

/** Список SET по присваиваниям. Чего разобрать не удалось — колонка «?». */
function assignments(list: string): Assignment[] {
  const out: Assignment[] = [];
  for (const part of splitTop(list.replace(/--[^\n]*/g, ''))) {
    const one = /^("?[A-Za-z_]\w*"?)\s*=(?!=)([\s\S]*)$/.exec(part);
    const many = /^\(([^)]*)\)\s*=([\s\S]*)$/.exec(part);
    if (one) out.push({ column: name(one[1]), value: one[2].trim() });
    else if (many) for (const col of many[1].split(',')) out.push({ column: name(col), value: many[2].trim() });
    else out.push({ column: '?', value: part });
  }
  return out;
}

/**
 * Все присваивания, которыми код меняет СУЩЕСТВУЮЩУЮ строку тура: `UPDATE … SET`
 * и `INSERT … ON CONFLICT … DO UPDATE SET`.
 */
function rowUpdates(src: string): Assignment[] {
  const out: Assignment[] = [];
  for (const m of src.matchAll(sql('update', 'gi'))) {
    const after = m.index + m[0].length;
    // Между именем таблицы и SET может стоять только псевдоним.
    const setAt = after + clause(src, after, /^set\b/i).length;
    if (!/^set\b/i.test(src.slice(setAt, setAt + 4))) out.push({ column: '?', value: 'нет SET' });
    else out.push(...assignments(clause(src, setAt + 3, /^(?:where|returning|from)\b/i)));
  }
  for (const m of src.matchAll(sql(INSERT, 'gi'))) {
    const stmt = clause(src, m.index + m[0].length, null);
    const upsert = /\bdo\s+update\s+set\b/i.exec(stmt);
    if (upsert) out.push(...assignments(clause(stmt, upsert.index + upsert[0].length, /^(?:where|returning)\b/i)));
  }
  return out;
}

/** Колонки содержания, которые код пишет в существующую строку своим запросом. */
function contentColumnsWritten(src: string): string[] {
  const written = new Set(rowUpdates(src).map((a) => a.column));
  return MODERATED_TOUR_COLUMNS.filter((col) => written.has(col));
}

/** Присваивания, которые перепись разобрать не смогла: колонка из переменной и подобное. */
const unparsed = (src: string) => rowUpdates(src).filter((a) => a.column === '?').map((a) => a.value.slice(0, 60));

/** Всё, кроме FALSE, в `is_published` — публикация мимо одобрения. */
const publishes = (value: string) => !/^false$/i.test(value.trim());

/** Присваивания публикации в существующей строке, которые ставят не FALSE. */
const publicationSet = (src: string) => rowUpdates(src).filter((a) => a.column === 'is_published' && publishes(a.value)).map((a) => a.value);

/**
 * Что каждая вставка тура кладёт в `is_published`: 'absent' — колонки нет
 * (умолчание базы — FALSE, миграция 040), иначе выражение из VALUES / SELECT.
 * Вставка, которую разобрать не удалось, — «?».
 */
function insertedPublication(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(sql(INSERT, 'gi'))) {
    const stmt = clause(src, m.index + m[0].length, null);
    const open = stmt.search(/\S/);
    if (open === -1 || stmt[open] !== '(') { out.push('?'); continue; }
    const close = scanTop(stmt, open + 1, () => false);
    const columns = splitTop(stmt.slice(open + 1, close)).map(name);
    const at = columns.indexOf('is_published');
    if (at === -1) { out.push('absent'); continue; }
    const rest = stmt.slice(close + 1);
    const values = /^\s*values\s*\(/i.exec(rest);
    const select = /^\s*select\b/i.exec(rest);
    let row: string[] = [];
    if (values) row = splitTop(rest.slice(values[0].length, scanTop(rest, values[0].length, () => false)));
    else if (select) row = splitTop(clause(rest, select[0].length, /^from\b/i));
    out.push(row.length === columns.length ? row[at].trim().toLowerCase() : '?');
  }
  return out;
}

describe('обход репозитория: где перепись ищет запись', () => {
  it('пропущенные каталоги названы поимённо; остальные каталоги верхнего уровня обойдены', () => {
    // Новый пропуск — видимая правка этого списка, а не тихое сужение обхода.
    expect(Object.keys(REPO_CODE_SKIPPED).sort()).toEqual(['coverage', 'dist', 'node_modules', 'public', 'test', 'tests']);
    for (const why of Object.values(REPO_CODE_SKIPPED)) expect(why.length).toBeGreaterThan(10);
    const walked = new Set(CODE.map((f) => f.split('/')[0]));
    for (const dir of ['app', 'lib', 'scripts', 'components', 'hooks', 'integrations', 'infra']) {
      expect(statSync(join(ROOT, dir)).isDirectory(), dir).toBe(true);
      expect(walked.has(dir), `${dir}: каталог с кодом не обойдён`).toBe(true);
    }
    for (const skipped of Object.keys(REPO_CODE_SKIPPED)) expect(walked.has(skipped), skipped).toBe(false);
    expect(CODE.some((f) => f.startsWith('.') || f.includes('/node_modules/'))).toBe(false);
  });

  it('корневые файлы кода читаются — и .js тоже', () => {
    const rootCode = readdirSync(ROOT).filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && !f.startsWith('.')).sort();
    expect(rootCode).toEqual(expect.arrayContaining(['instrumentation.ts', 'middleware.ts', 'start.js']));
    expect(CODE.filter((f) => !f.includes('/'))).toEqual(rootCode);
  });
});

describe('разбор запроса: формы, на которых перепись раньше молчала', () => {
  it('запись находится в кавычках, со схемой, с ONLY, в любом регистре; MERGE, COPY и DELETE — тоже запись', () => {
    for (const q of [
      'UPDATE operator_tours SET title = $1',
      'update operator_tours set title = $1',
      'UPDATE "operator_tours" SET title = $1',
      'UPDATE public.operator_tours SET title = $1',
      'UPDATE "public"."operator_tours" SET title = $1',
      'UPDATE ONLY operator_tours SET title = $1',
      'Insert Into operator_tours (title) VALUES ($1)',
      'MERGE INTO operator_tours t USING src s ON t.id = s.id',
      'COPY operator_tours FROM STDIN',
      'DELETE FROM operator_tours WHERE id = $1',
      'TRUNCATE TABLE operator_tours',
    ]) expect(WRITES.test(q), q).toBe(true);
    for (const q of [
      'SELECT title FROM operator_tours WHERE id = $1',
      'UPDATE operator_tours_archive SET title = $1',
      'UPDATE operator_tour_edits SET status = $1',
      'JOIN operator_tours ot ON ot.id = b.tour_id',
    ]) expect(WRITES.test(q), q).toBe(false);
  });

  it('колонка после подзапроса со своим WHERE видна; колонка в кавычках — тоже', () => {
    const q = `UPDATE operator_tours SET
      -- счёт отзывов
      review_count = (SELECT COUNT(*) FROM operator_tour_reviews r WHERE r.tour_id = $1),
      "description" = $2
      WHERE id = $1`;
    expect(rowUpdates(q).map((a) => a.column)).toEqual(['review_count', 'description']);
    expect(contentColumnsWritten(q)).toEqual(['description']);
    expect(contentColumnsWritten('update public."operator_tours" ot set base_price = $1 from x where x.id = ot.id')).toEqual(['base_price']);
    // Колонка подзапроса — не запись в тур.
    expect(contentColumnsWritten('UPDATE operator_tours SET rating = (SELECT 1 FROM t WHERE description = $1) WHERE id = $2')).toEqual([]);
    expect(rowUpdates('UPDATE operator_tours SET (title, description) = ($1, $2) WHERE id = $3').map((a) => a.column)).toEqual(['title', 'description']);
  });

  it('ON CONFLICT … DO UPDATE SET — запись в существующую строку', () => {
    const q = 'INSERT INTO operator_tours (id, title) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, updated_at = NOW() RETURNING id';
    expect(rowUpdates(q).map((a) => a.column)).toEqual(['title', 'updated_at']);
    expect(contentColumnsWritten(q)).toEqual(['title']);
    expect(contentColumnsWritten('INSERT INTO operator_tours (id, title) VALUES ($1, $2) ON CONFLICT DO NOTHING')).toEqual([]);
  });

  it('список SET из переменной — «не разобрано», а не «содержания нет»', () => {
    expect(unparsed('UPDATE operator_tours SET ${sets.join(", ")} WHERE id = $1')).toHaveLength(1);
    expect(unparsed('UPDATE operator_tours ${tail}')).toEqual(['нет SET']);
    expect(unparsed('UPDATE operator_tours ot SET is_active = FALSE, updated_at = NOW() WHERE ot.id = $1')).toEqual([]);
  });

  it('публикация: в UPDATE — всё, кроме FALSE; во вставке — значение на месте колонки', () => {
    expect(publicationSet('UPDATE operator_tours SET is_published = TRUE WHERE id = $1')).toEqual(['TRUE']);
    expect(publicationSet('UPDATE operator_tours SET is_published = $2 WHERE id = $1')).toEqual(['$2']);
    expect(publicationSet('UPDATE operator_tours SET is_published = FALSE WHERE id = $1')).toEqual([]);
    expect(insertedPublication('INSERT INTO operator_tours (title, base_price) VALUES ($1, $2)')).toEqual(['absent']);
    expect(insertedPublication("INSERT INTO operator_tours (title, is_published, created_via) VALUES ($1, false, 'agent')")).toEqual(['false']);
    expect(insertedPublication('INSERT INTO operator_tours (title, is_published) VALUES ($1, TRUE)')).toEqual(['true']);
    expect(insertedPublication(`INSERT INTO operator_tours (operator_id, title, is_active, is_published)
      SELECT p.id, $2, TRUE, FALSE FROM partners p WHERE p.id = $1`)).toEqual(['false']);
    expect(insertedPublication('INSERT INTO operator_tours (operator_id, is_published) SELECT p.id, $2 FROM partners p')).toEqual(['$2']);
    // Вставка без списка колонок или с несовпавшим числом значений — не разобрана.
    expect(insertedPublication('INSERT INTO operator_tours SELECT * FROM staging')).toEqual(['?']);
    expect(insertedPublication('INSERT INTO operator_tours (title, is_published) VALUES ($1)')).toEqual(['?']);
  });
});

describe('перепись писателей таблицы туров', () => {
  it('каждый файл с записью в operator_tours назван, и названные всё ещё пишут', () => {
    expect(FOUND).toEqual(Object.keys(WRITERS).sort());
    for (const [file, w] of Object.entries(WRITERS)) expect(w.why.length, file).toBeGreaterThan(10);
  });

  it('кроны описаний, снимков и точки сбора своей записи в тур не имеют', () => {
    for (const cron of ['tour-describe', 'tour-photos', 'tour-pickup']) {
      const src = read(`app/api/cron/${cron}/route.ts`);
      expect(src, `${cron}: снова пишет тур своим запросом`).not.toMatch(WRITES);
      expect(src, `${cron}: зовёт запись мимо двери автомата`).not.toMatch(/writeTourPatch|saveTourChange|stageTourEdit/);
    }
    // И двери этих кронов сами тур не пишут: только вход автомата.
    for (const door of ['lib/tours/describe-door.ts', 'lib/tours/photos-door.ts']) {
      const src = read(door);
      expect(src, door).not.toMatch(WRITES);
      expect(src, door).not.toMatch(/writeTourPatch|saveTourChange|stageTourEdit/);
      expect(src, door).toMatch(/proposeTourChange/);
    }
  });

  it('«не содержание» — действительно не содержание: только UPDATE, ни одной колонки из списка проверки, публикации нет', () => {
    for (const [file, w] of Object.entries(WRITERS)) {
      if (w.kind !== 'not_content') continue;
      const src = read(file);
      expect(src, `${file}: вставка, слияние или удаление строк тура`).not.toMatch(sql(NOT_UPDATE));
      expect(unparsed(src), `${file}: запись, которую перепись не разобрала`).toEqual([]);
      expect(contentColumnsWritten(src), `${file}: пишет содержание мимо очереди`).toEqual([]);
      expect(publicationSet(src), `${file}: ставит публикацию`).toEqual([]);
    }
  });

  it('слияние мест переносит только связь с местом', () => {
    const src = read('lib/places/merge-carry.ts');
    expect(src).not.toMatch(sql(NOT_UPDATE));
    expect(unparsed(src)).toEqual([]);
    expect(rowUpdates(src).map((a) => a.column)).toEqual(['main_place_id', 'updated_at']);
  });

  it('новые туры заводятся неопубликованными: публикацию ставит только одобрение', () => {
    for (const [file, w] of Object.entries(WRITERS)) {
      if (w.kind !== 'creates') continue;
      const src = read(file);
      const inserted = insertedPublication(src);
      expect(inserted.length, `${file}: записи больше нет`).toBeGreaterThan(0);
      // Вставка публикацию не ставит: колонки нет (умолчание базы) либо FALSE.
      for (const value of inserted) expect(['absent', 'false'], `${file}: is_published = ${value}`).toContain(value);
      // И ни одна запись в существующую строку её не ставит.
      expect(unparsed(src), `${file}: запись, которую перепись не разобрала`).toEqual([]);
      expect(publicationSet(src), `${file}: ставит публикацию`).toEqual([]);
    }
  });

  it('обходные пути автоматов — замороженный список: он может только сокращаться', () => {
    const bypass = Object.entries(WRITERS).filter(([, w]) => w.kind === 'bypass_known').map(([f]) => f).sort();
    expect(bypass).toEqual([
      'lib/agents/execution/handlers/ab-scale-executor.ts',
      'lib/agents/execution/initiative-executor.ts',
      'lib/services/operators/operator-tour-scraper.ts',
      'lib/services/tours/tour.service.ts',
      'scripts/scrape-operator-tours.js',
    ]);
    // Запись самоустаревает: перестал писать содержание своим запросом — вычеркнуть.
    for (const file of bypass) {
      const src = read(file);
      const writesContent = contentColumnsWritten(src).length > 0 || unparsed(src).length > 0 || sql(INSERT).test(src);
      expect(writesContent, `${file}: обходного пути больше нет — уберите из списка`).toBe(true);
    }
  });
});
