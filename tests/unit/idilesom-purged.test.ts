/**
 * tests/unit/idilesom-purged.test.ts
 *
 * Скрейпер чужого сайта удалён и не возвращается.
 *
 * ── Решение владельца 07.09: «нужно вычистить idilesom» ───────────────────
 *
 * Про этот источник в репозитории уже была длинная история: миграция 767
 * вычищала его рекламу из наших описаний, 871 убрала его имя из подписи мест,
 * PlaceFooter перестал вести на него ссылкой, §12 понизила его линии из
 * «снятого трека» в «записан, но не подтверждён». Каждый раз убиралось
 * следствие, а машина, которая его производила, оставалась работать.
 *
 * Теперь убрана машина: импортёр мест и треков, четыре крон-эндпоинта, сверка
 * наших линий с его страницами, админ-страница импорта, четыре скрипта, два
 * workflow с маркерами.
 *
 * Что осознанно ОСТАВЛЕНО и почему — чтобы следующий чистильщик не снёс:
 *   - сам контент (маршруты, описания, геометрия): владелец выбрал чистку
 *     подписи, а не удаление скачанного — снос стоил бы ~257 линий из 301;
 *   - `source_url` в базе: происхождение нужно для проверки фактов и авторских
 *     прав, и на экран оно не выводится (PlaceFooter, миграция 871);
 *   - слог 'idilesom' в UNVERIFIED_SOURCES (lib/map/line-standard): страховка
 *     для строк, до которых миграция 941 не дотянулась. Убрать его — значит
 *     отправить такую линию в плотностную эвристику, а та вернёт ей звание
 *     снятого трека, то есть сплошную зелёную «здесь идут»;
 *   - фильтры `description ILIKE '%idilesom%'`: ими ищут ОСТАТКИ его рекламы в
 *     описаниях. Это инструмент чистки, а не зависимость от источника.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const GONE = [
  'lib/services/ingest/idilesom-importer.ts',
  'app/api/cron/idilesom-gap/route.ts',
  'app/api/cron/idilesom-name-gap/route.ts',
  'app/api/cron/idilesom-scout/route.ts',
  'app/api/cron/idilesom-tracks/route.ts',
  'app/api/cron/route-track-reconcile/route.ts',
  'app/api/admin/import/idilesom-places/route.ts',
  'app/hub/admin/content/places-import/page.tsx',
  'scripts/import-idilesom-places.ts',
  'scripts/import-idilesom-tracks.ts',
  'scripts/scrape-idilesom-full.js',
  'scripts/enrich-idilesom-descriptions.ts',
  '.github/workflows/import-idilesom-tracks.yml',
  '.github/workflows/route-track-reconcile.yml',
  '.github/triggers/idilesom-tracks.json',
  '.github/triggers/route-track-reconcile.json',
];

describe('машинерия источника удалена', () => {
  for (const f of GONE) {
    it(`нет файла: ${f}`, () => {
      expect(existsSync(join(root, f)), `${f} вернулся`).toBe(false);
    });
  }
});

describe('к сайту источника больше не ходят', () => {
  function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
    }
    return out;
  }

  /**
   * Комментарии не в счёт: история этого источника записана в нескольких
   * файлах намеренно (миграция, порядок витрины, список непроверенных слогов),
   * и стирать объяснение вместе с кодом значило бы через месяц не понять, что
   * тут было и почему. Ищем ЖИВОЙ код.
   */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')   // блочные
      .replace(/^[ \t]*\/\/.*$/gm, '')    // строчные JS
      .replace(/^[ \t]*--.*$/gm, '');     // SQL внутри шаблонных строк
  }

  /**
   * Осознанные исключения — места, которые УБИРАЮТ за источником, а не ходят
   * к нему. Приём тот же, что у сканера ПД (ALLOWLIST в scan-repo): чтобы
   * добавить сюда файл, надо написать причину, а не молча ослабить правило.
   */
  const CLEANUP_ALLOWLIST = new Map<string, string>([
    ['lib/services/data-repair.ts',
     'сверяет старые значения source_name и приводит их к роду — без имени в ' +
     'условии нечего было бы искать; строки, записанные до миграции 941, иначе ' +
     'остались бы неприведёнными навсегда'],
  ]);

  it('ни один живой файл не упоминает домен источника', () => {
    // Ищем ПОДСТРОКОЙ, а не регуляркой по URL. Незаякоренная регулярка вида
    // /https?:\/\/…idilesom\.com/ — это форма санитайзера, который обходится
    // (`https://evil.com/?x=https://idilesom.com`), и CodeQL справедливо метит
    // её как js/regex/missing-regexp-anchor. Здесь ничего не санируется:
    // вопрос «встречается ли домен в живом коде» — вопрос о подстроке, и
    // отвечать на него надо подстрокой.
    const offenders = ['lib', 'app', 'components', 'scripts']
      .flatMap(d => walk(join(root, d)))
      .filter(f => stripComments(readFileSync(f, 'utf-8')).includes('idilesom.com'))
      .map(f => f.replace(root + '/', ''))
      .filter(f => !CLEANUP_ALLOWLIST.has(f));

    expect(offenders, `запрос к источнику вернулся: ${offenders.join(', ')}`).toEqual([]);
  });

  it('исключения не протухают: каждое всё ещё содержит имя источника', () => {
    // Иначе список разрешений переживёт причину своего существования и станет
    // разрешать то, чего давно нет, — тихо расширяя дыру под будущий возврат.
    for (const [file, why] of CLEANUP_ALLOWLIST) {
      const src = stripComments(readFileSync(join(root, file), 'utf-8'));
      expect(src.includes('idilesom'), `${file}: исключение больше не нужно (${why})`).toBe(true);
    }
  });
});

describe('подпись источника вычищена миграцией, а не обнулена', () => {
  const MIG = readFileSync(join(root, 'migrations/941_purge_idilesom_source_signature.sql'), 'utf-8');

  it('имя в подписи маршрута заменено родом', () => {
    expect(MIG).toMatch(/UPDATE kamchatka_routes[\s\S]*?SET source_name = 'сторонний источник'/);
  });

  it('метка линии переименована в external, а НЕ обнулена', () => {
    // Ключевое место. NULL отправил бы 257 непроверенных линий в плотностную
    // эвристику, и та вернула бы им сплошную зелёную — обещание «здесь идут».
    expect(MIG).toMatch(/jsonb_set\(geometry, '\{source\}', '"external"'\)/);
    expect(MIG).not.toMatch(/SET geometry = NULL/);
    expect(MIG).not.toMatch(/geometry\s*-\s*'source'/);
  });

  it('контент не удаляется — ни одной строки DELETE', () => {
    expect(MIG).not.toMatch(/\bDELETE\b/i);
  });

  it('source_url оставлен намеренно: происхождение не стирается', () => {
    expect(MIG).not.toMatch(/SET source_url = NULL/);
  });
});

describe('починка данных не вписывает имя обратно', () => {
  const REPAIR = readFileSync(join(root, 'lib/services/data-repair.ts'), 'utf-8');

  it('нормализация ведёт к роду, а не к домену конкурента', () => {
    // Прежний шаг приводил 'idilesom' к 'idilesom.com' и после миграции
    // возвращал бы имя по одной записи за прогон, мимо всякой миграции.
    expect(REPAIR).not.toMatch(/SET source_name = 'idilesom\.com'/);
    expect(REPAIR).toMatch(/SET source_name = 'сторонний источник'/);
  });
});

describe('витрина категории не поднимает наверх чужой контент', () => {
  const PAGE = readFileSync(join(root, 'components/routes/CategoryPage.tsx'), 'utf-8');
  const CODE = PAGE.split('\n').filter(l => !/^\s*(--|\/\/|\*)/.test(l)).join('\n');

  it('порядок больше не решается именем поставщика', () => {
    expect(CODE).not.toMatch(/source_name = 'idilesom\.com'/);
    expect(CODE).not.toMatch(/source_name = 'kamchatintour\.ru'/);
  });

  it('порядок решается наполненностью карточки', () => {
    expect(CODE).toMatch(/length\(COALESCE\(description, ''\)\) >= 300/);
  });
});
