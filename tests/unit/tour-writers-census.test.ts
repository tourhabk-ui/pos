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
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MODERATED_TOUR_COLUMNS } from '@/lib/tours/moderation';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}

const WRITES = /\b(UPDATE|INSERT\s+INTO)\s+operator_tours\b/;

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

const FOUND = [...walk('app'), ...walk('lib'), ...walk('scripts')].filter((f) => WRITES.test(read(f))).sort();

/** Куски «UPDATE operator_tours … WHERE»: в них ищем, какие колонки пишутся. */
function updateSets(src: string): string[] {
  const out: string[] = [];
  const re = /\bUPDATE\s+operator_tours\b/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const rest = src.slice(m.index, m.index + 1500);
    const end = rest.search(/\bWHERE\b/);
    out.push(end === -1 ? rest : rest.slice(0, end));
  }
  return out;
}

function contentColumnsWritten(file: string): string[] {
  const sets = updateSets(read(file));
  return MODERATED_TOUR_COLUMNS.filter((col) => sets.some((set) => new RegExp(`(^|[\\s,(])${col}\\s*=(?!=)`).test(set)));
}

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

  it('«не содержание» — действительно не содержание: ни одной колонки из списка проверки', () => {
    for (const [file, w] of Object.entries(WRITERS)) {
      if (w.kind !== 'not_content') continue;
      expect(contentColumnsWritten(file), `${file}: пишет содержание мимо очереди`).toEqual([]);
    }
  });

  it('слияние мест переносит только связь с местом', () => {
    expect(contentColumnsWritten('lib/places/merge-carry.ts')).toEqual(['main_place_id']);
  });

  it('новые туры заводятся неопубликованными: публикацию ставит только одобрение', () => {
    for (const [file, w] of Object.entries(WRITERS)) {
      if (w.kind !== 'creates') continue;
      const src = read(file);
      expect(src, `${file}: записи больше нет`).toMatch(/INSERT\s+INTO\s+operator_tours\b/);
      // Ни одна запись этих файлов не ставит публикацию.
      for (const set of updateSets(src)) expect(set, file).not.toMatch(/is_published\s*=\s*(TRUE|true|\$)/);
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
      const writesContent = contentColumnsWritten(file).length > 0 || /INSERT\s+INTO\s+operator_tours\b/.test(src);
      expect(writesContent, `${file}: обходного пути больше нет — уберите из списка`).toBe(true);
    }
  });
});
