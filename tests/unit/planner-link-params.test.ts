/**
 * Сторож: параметр, положенный в ссылку на /planner, кем-то читается.
 *
 * ── Что было (замер 19.09) ───────────────────────────────────────────────
 *
 * `lib/mcp/handoff-targets.ts` отдавал туриста внешней модели по адресу
 * `/planner?days=7&interests=вулканы и медведи`, карточка тура — по
 * `/planner?hint=fishing`. Экран читал из URL ТОЛЬКО `mood`: оба набора
 * выбрасывались, человек приходил на пустую форму и заполнял её заново.
 *
 * Два производителя, ноль потребителей — §10.09 в чистом виде. Причём
 * молчаливый: ссылка открывается, форма работает, ничего не падает.
 * Единственный признак — турист заполняет второй раз то, что уже сказал.
 *
 * Поэтому сторож держит СВЯЗКУ, а не наличие кода: он находит ВСЕХ, кто
 * кладёт параметры в ссылку на планировщик, и требует, чтобы каждое имя
 * читалось клиентом. Новый параметр без потребителя краснеет сам.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseInterestWords, INTEREST_WORDS } from '@/lib/planner/interest-words';

const ROOT = process.cwd();
const CLIENT = readFileSync(join(ROOT, 'app/planner/_PlannerClient.tsx'), 'utf-8');
const HANDOFF = readFileSync(join(ROOT, 'lib/mcp/handoff-targets.ts'), 'utf-8');

/** Имена параметров, которые клиент действительно достаёт из URL. */
function consumedParams(): Set<string> {
  return new Set(
    [...CLIENT.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((m) => m[1]),
  );
}

describe('параметры ссылки доходят до формы', () => {
  it('клиент читает mood, interests, hint и days', () => {
    const consumed = consumedParams();
    for (const name of ['mood', 'interests', 'hint', 'days']) {
      expect(consumed.has(name), `клиент не читает ?${name}`).toBe(true);
    }
  });

  it('никто не кладёт в ссылку параметр, которого клиент не читает', () => {
    // Перепись производителей по коду, а не по памяти: ссылки на планировщик
    // строят и MCP, и карточка тура, и плитки главной.
    // `-c color.ui=false` обязателен: у проверяющего может стоять
    // `color.ui=always`, и тогда grep вернёт пути с ANSI-последовательностями
    // (урок 16.08, сторож no-ignored-sources). Отказ, который не
    // воспроизводится на CI, учит не верить гарду.
    const grep = execFileSync('git', [
      '-c', 'color.ui=false',
      'grep', '-hoE', "/planner\\?[A-Za-z_]+=|query\\.set\\('[a-z_]+'", '--', 'app', 'lib', 'components',
    ], { cwd: ROOT, encoding: 'utf8' });

    const produced = new Set<string>();
    for (const hit of grep.split('\n')) {
      const inUrl = hit.match(/\/planner\?([A-Za-z_]+)=/);
      if (inUrl) produced.add(inUrl[1]);
    }
    // `query.set(...)` ловится отдельно — только в файле раздачи, чтобы не
    // собрать чужие query со всего репозитория.
    for (const m of HANDOFF.matchAll(/query\.set\('([a-z_]+)'/g)) produced.add(m[1]);

    const orphans = [...produced].filter((p) => !consumedParams().has(p));
    expect(orphans, `кладут, но не читают: ${orphans.join(', ')}`).toEqual([]);
  });

  it('MCP по-прежнему кладёт days и interests — связка живая с обоих концов', () => {
    // Если производителя убрать, первый тест останется зелёным на пустом
    // месте: клиент читает параметры, которых никто не шлёт.
    expect(HANDOFF).toMatch(/query\.set\('days'/);
    expect(HANDOFF).toMatch(/query\.set\('interests'/);
  });
});

describe('разбор интересов пригоден для клиента', () => {
  it('модуль словаря не имеет импортов', () => {
    // Любая зависимость здесь уедет в браузерный бандл вместе со словарём;
    // ради этого он и переехал из trip-plan-tool, который тянет pool.
    const src = readFileSync(join(ROOT, 'lib/planner/interest-words.ts'), 'utf-8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it('словарь ОДИН: Кузьмич и экран читают один и тот же', () => {
    const tool = readFileSync(join(ROOT, 'lib/kuzmich/trip-plan-tool.ts'), 'utf-8');
    expect(tool).toContain("from '@/lib/planner/interest-words'");
    // Копия словаря в старом доме — то, из-за чего два перевода расходятся.
    expect(tool).not.toMatch(/const INTEREST_WORDS/);
    expect(CLIENT).toContain("from '@/lib/planner/interest-words'");
    // Бочка тянет движок с пулом — клиенту только глубокий путь.
    expect(CLIENT).not.toMatch(/from '@\/lib\/planner'/);
  });

  it('слова туриста превращаются в ключи движка', () => {
    expect(parseInterestWords('хотим вулканы и морские прогулки')).toEqual(
      expect.arrayContaining(['volcano', 'boat_trip']),
    );
    // Не разобрали ничего — пустой список, а не подставленное умолчание:
    // умолчание выбирает вызывающий, и у Кузьмича с экраном они разные.
    expect(parseInterestWords('здравствуйте')).toEqual([]);
  });
});

describe('ключ движка находит свою плитку', () => {
  it('каждому ключу словаря есть плитка на экране', () => {
    // Ключ без плитки молча пропадает: турист назвал интерес, а на экране
    // ничего не выбралось, и он об этом не узнает.
    const tiles = new Set(
      [...CLIENT.matchAll(/\{ id: '([a-z_]+)',\s+label:/g)].map((m) => m[1]),
    );
    expect(tiles.size, 'плитки не нашлись — сломался разбор экрана').toBeGreaterThan(5);

    // Карта расхождений имён читается из того же файла: проверять надо
    // ИТОГОВЫЙ путь ключа до плитки, а не наличие плитки с тем же именем.
    const mapBlock = CLIENT.slice(
      CLIENT.indexOf('const ENGINE_KEY_TO_TILE'),
      CLIENT.indexOf('const PLACE_IDS'),
    );
    const toTile: Record<string, string> = Object.fromEntries(
      [...mapBlock.matchAll(/(\w+): '([a-z_]+)'/g)].map((m) => [m[1], m[2]]),
    );

    const missing = [...new Set(Object.values(INTEREST_WORDS))]
      .filter((k) => !tiles.has(toTile[k] ?? k));
    expect(missing, `нет плитки для: ${missing.join(', ')}`).toEqual([]);
  });

  it('расхождение имён названо явно, а не подогнано', () => {
    // У движка активность зовётся thermal, плитка — hot_spring.
    expect(CLIENT).toContain('ENGINE_KEY_TO_TILE');
    expect(CLIENT).toMatch(/thermal: 'hot_spring'/);
  });
});
