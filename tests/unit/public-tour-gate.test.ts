/**
 * Публичное чтение тура спрашивает ШЛЮЗ ВИТРИНЫ — черновик оператора наружу
 * не выезжает.
 *
 * ── Повод ─────────────────────────────────────────────────────────────────
 *
 * Условие «тур на витрине» стояло копией в каноническом чтении карточки
 * (`lib/tours/tour-detail-query.ts`) и НЕ стояло нигде больше. Проверено
 * исполнением на настоящем PostgreSQL: туры «Сплав по реке Быстрая»
 * (`is_active = true`, `is_published = false`) выезжали в ответ
 * `GET /api/tours` наравне с живым; `GET /api/tours/[id]` открывал их по
 * прямой ссылке; `GET /api/tours/[id]/slots` отдавал свободные даты по любому
 * id вовсе без взгляда на тур.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Не место, а ПРАВИЛО, и с двух сторон:
 *   1. сам шлюз (`publicTourSql`) содержит все три флага — иначе вызов его
 *      зеленел бы при выпотрошенном условии (§10.09: сторож, проверяющий
 *      только объявление, зеленеет ровно тогда, когда механизм отвалился);
 *   2. КАЖДЫЙ роут публичной поверхности туров (`app/api/tours/**`), читающий
 *      `operator_tours`, зовёт шлюз. Новый роут без гейта краснеет сам, а не
 *      после того, как черновик заметят на витрине;
 *   3. три сегодняшних роута — поведением: в SQL, который они реально
 *      отправляют, стоит `is_published`.
 *
 * ── Находка аудита 15.10 P1-04: копии условия по всему app/ и lib/ ─────────
 *
 * Шлюз держал только `app/api/tours/**` — ту половину, где копий уже не было.
 * За её пределами условие «тур на витрине» стояло руками в десятках файлов с
 * разным набором флагов: план поездки (compose) не смотрел `deleted_at`, и
 * УДАЛЁННЫЙ тур вставал в план; рекомендации и фид для площадок не смотрели
 * `is_published`; инструменты Кузьмича раскрывали выключенный тур по id. А
 * рядом жил второй канон того же правила — `LIVE_TOUR_CONDITIONS` каталога.
 * Отсюда ещё три части сторожа:
 *   4. перепись app/ и lib/: флаг витрины (`is_active`/`is_published = true`),
 *      набранный руками на алиасе `operator_tours`, — только из замороженного
 *      списка с причинами; список самоустаревает, как KNOWN_UNPRODUCED;
 *   5. переведённые читатели — поведением: в отправленном SQL стоит шлюз;
 *   6. «тура в плане нет» на настоящем PostgreSQL —
 *      `tests/integration/public-tour-gate.pg.test.ts` (мок ответил бы на любой
 *      SQL, поэтому сам отбор судится там).
 *   7. отказ базы на публичных отборах ревью #2642 (поиск всеми тремя
 *      ветками, календарь, туры дня, лента главной, операторы планера) — 500
 *      словами по-русски: текст исключения PostgreSQL (таблицы, колонки,
 *      statement timeout) анониму не уходит, в логе — проверка и SQLSTATE,
 *      без слов поиска.
 *   8. неверный вход тех же роутов (page=0, limit=-1, page=abc, 30 февраля,
 *      13-й месяц, NUL в тексте) — 400 с именем параметра ДО базы: пул не
 *      вызван, строки отказа в логе нет. «Временно не работает» остаётся
 *      только отказу базы (третий круг ревью #2642).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const queryMock = vi.fn();
const poolQueryMock = vi.fn();
const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...args: unknown[]) => poolQueryMock(...args),
    // Транзакция (холд OCTO) — свой клиент; его SQL судится так же.
    connect: async () => ({ query: (...args: unknown[]) => clientQueryMock(...args), release: () => undefined }),
  },
}));

import { publicTourSql, storefrontState, missingStorefrontMarks, STOREFRONT_LABELS } from '@/lib/tours/public-visibility';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';
import { GET as toursList } from '@/app/api/tours/route';
import { GET as tourDetail } from '@/app/api/tours/[id]/route';
import { GET as tourSlots } from '@/app/api/tours/[id]/slots/route';
import { GET as toursFeed } from '@/app/api/tours-feed/route';
import { composeTrip } from '@/lib/planner/compose';
import { createPlannerCache, fetchContingencyAlternatives } from '@/lib/planner';
import { getRecommendations } from '@/lib/search/tour-recommend';
import { getTouristTools } from '@/lib/agents/sdk/tourist-tools';

const TOURS_API = join(process.cwd(), 'app/api/tours');

/** Все файлы роутов публичной поверхности туров. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (entry === 'route.ts' || entry === 'route.tsx') out.push(p);
  }
  return out;
}

function req(url: string): Request {
  return new Request(url);
}
/** Next 15: params приходят Promise — синхронное чтение ломается в мажорной. */
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  queryMock.mockReset();
  poolQueryMock.mockReset();
  clientQueryMock.mockReset();
});

describe('шлюз витрины туров — сам предикат', () => {
  it('держит все три флага, а не один', () => {
    const sql = publicTourSql('ot');
    expect(sql).toContain('ot.is_active = true');
    expect(sql).toContain('ot.is_published = true');
    expect(sql).toContain('ot.deleted_at IS NULL');
  });

  it('алиас подставляется, пустой — без префикса', () => {
    expect(publicTourSql('t')).toContain('t.is_published = true');
    expect(publicTourSql('')).toContain('is_published = true');
    expect(publicTourSql('')).not.toContain('.is_published');
  });

  it('алиас из чужих рук в SQL не подставляется', () => {
    expect(() => publicTourSql("t; DROP TABLE operator_tours --")).toThrow();
  });
});

// #2642: кабинет оператора называет состояние тура тем же правилом, что шлюз.
describe('storefrontState — состояние тура для кабинета, рядом со шлюзом', () => {
  it('на витрине — только при всех трёх флагах, как в publicTourSql', () => {
    expect(storefrontState({ is_active: true, is_published: true, deleted_at: null })).toBe('on');
    expect(storefrontState({ is_active: true, is_published: true })).toBe('on');
  });

  it('новый тур (is_published = false) — черновик, а не «на витрине»', () => {
    expect(storefrontState({ is_active: true, is_published: false })).toBe('draft');
    // NULL флага — не «да», как и в SQL (NULL = true не проходит WHERE).
    expect(storefrontState({ is_active: true, is_published: null })).toBe('draft');
  });

  it('выключенный или удалённый — скрыт, опубликован он или нет', () => {
    expect(storefrontState({ is_active: false, is_published: true })).toBe('hidden');
    expect(storefrontState({ is_active: false, is_published: false })).toBe('hidden');
    expect(storefrontState({ is_active: null, is_published: true })).toBe('hidden');
    expect(storefrontState({ is_active: true, is_published: true, deleted_at: '2026-10-01T00:00:00Z' })).toBe('hidden');
  });

  it('ответ шлюза «нет» сильнее флагов: «На витрине» без витрины не пишется', () => {
    expect(storefrontState({ is_active: true, is_published: true, on_storefront: false })).toBe('hidden');
    expect(storefrontState({ is_active: true, is_published: true, on_storefront: true })).toBe('on');
  });

  it('недостающие отметки называются все: выключенному черновику одной «Активен» мало (ревью #2642)', () => {
    expect(missingStorefrontMarks({ is_active: true, is_published: true })).toEqual([]);
    expect(missingStorefrontMarks({ is_active: true, is_published: false })).toEqual(['Опубликован']);
    expect(missingStorefrontMarks({ is_active: false, is_published: true })).toEqual(['Активен']);
    expect(missingStorefrontMarks({ is_active: false, is_published: false })).toEqual(['Активен', 'Опубликован']);
    // NULL — не «да», как в шлюзе.
    expect(missingStorefrontMarks({ is_active: null, is_published: null })).toEqual(['Активен', 'Опубликован']);
  });

  it('подписи — словами, одна на состояние', () => {
    expect(STOREFRONT_LABELS).toEqual({
      on: 'На витрине',
      draft: 'Черновик — туристы не видят',
      hidden: 'Скрыт',
    });
  });
});

describe('каждый публичный роут туров спрашивает шлюз', () => {
  const files = routeFiles(TOURS_API);

  it('роуты вообще найдены (перепись, смотрящая не туда, не выглядит успешной)', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('роут, читающий operator_tours, зовёт publicTourSql', () => {
    const without: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      // Читатели тура — и через FROM, и через JOIN. JOIN здесь не для
      // красоты: именно им читает тур роут дат (`JOIN operator_tours ot`), и
      // первая редакция правила, спрашивавшая только FROM, пропустила его —
      // мутация это и показала. Чистые писатели (POST/PATCH оператора) под
      // правило не попадают: они пишут свой тур, а не показывают чужой витрине.
      if (!/(FROM|JOIN)\s+operator_tours/i.test(src)) continue;
      if (!src.includes('publicTourSql(')) without.push(f.replace(process.cwd() + '/', ''));
    }
    expect(
      without,
      'публичный роут туров читает operator_tours без шлюза витрины. '
      + 'Позовите publicTourSql (lib/tours/public-visibility.ts) — иначе наружу '
      + 'уедет черновик оператора (is_published = false)',
    ).toEqual([]);
  });
});

// Проверка MCP 29.09: публичный MCP и Кузьмич — тоже витрина. Резолвер тура
// смотрел только is_active и deleted_at: черновик находился картой и заявкой.
describe('туры на пути Кузьмича и MCP — через тот же шлюз', () => {
  const FILES = ['lib/kuzmich/tour-availability-tool.ts', 'lib/kuzmich/core.ts'];
  it('каждый FROM operator_tours в них зовёт publicTourSql', () => {
    for (const f of FILES) {
      const src = readFileSync(join(process.cwd(), f), 'utf-8');
      const reads = [...src.matchAll(/FROM operator_tours\b([\s\S]{0,400}?)(?:`|LIMIT|ORDER BY)/g)];
      expect(reads.length, f).toBeGreaterThan(0);
      for (const m of reads) expect(m[1], `${f}: ${m[0].slice(0, 100)}`).toMatch(/publicTourSql\(/);
    }
  });
});

describe('поведение трёх роутов: в отправленном SQL стоит is_published', () => {
  it('GET /api/tours — список', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await toursList(req('http://localhost/api/tours') as never);
    expect(queryMock).toHaveBeenCalled();
    for (const call of queryMock.mock.calls) {
      expect(String(call[0])).toContain('is_published = true');
    }
  });

  it('GET /api/tours/[id] — карточка', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await tourDetail(req('http://localhost/api/tours/1') as never, params('1'));
    expect(String(queryMock.mock.calls[0]?.[0])).toContain('is_published = true');
  });

  it('GET /api/tours/[id]/slots — даты', async () => {
    poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await tourSlots(req('http://localhost/api/tours/1/slots') as never, params('1'));
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('is_published = true');
    // Тур не на витрине — «такого тура нет», а не «свободных дат нет»: пустой
    // список подменил бы одно состояние другим (§4.0).
    expect(res.status).toBe(404);
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
  });

  it('тур на витрине — даты считаются', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ date: '2026-07-01', available_slots: 8, booked_slots: 0, free_slots: 8 }], rowCount: 1 });
    const res = await tourSlots(req('http://localhost/api/tours/1/slots') as never, params('1'));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; slots: unknown[] };
    expect(body.success).toBe(true);
    expect(body.slots).toHaveLength(1);
  });
});

// ── Находка аудита 15.10 P1-04: перепись ручных копий условия витрины ───────

const ROOT = process.cwd();

/** Флаг витрины, набранный руками: `is_active = true`, `is_published IS TRUE`. */
const FLAG = String.raw`is_(?:active|published)\s*(?:=\s*true|IS\s+TRUE)\b`;
/** Чтение тура: `FROM operator_tours ot`, `JOIN operator_tours AS t`, голое `FROM operator_tours`. */
const READ = /\b(?:FROM|JOIN)\s+operator_tours\b(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
/** Привязка алиаса к таблице в куске SQL. */
const BIND = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_.]*)\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
/** Слова SQL, которые после имени таблицы — не алиас. */
const SQL_WORDS = new Set([
  'where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'group', 'order', 'limit',
  'set', 'using', 'returning', 'and', 'or', 'union', 'natural', 'lateral', 'offset', 'having',
  'window', 'for', 'as', 'select', 'from', 'values', 'except', 'intersect',
]);
const isAlias = (a: string | undefined): a is string => !!a && !SQL_WORDS.has(a.toLowerCase());

/**
 * Куски SQL файла — строки и шаблоны по синтаксическому дереву, а не по
 * регулярке над исходником: строковый фрагмент условия ('t.is_active = true')
 * и шаблон с подстановками разбираются одинаково, а комментарии кода в
 * перепись не попадают вовсе. Подстановка `${…}` заменяется знаком «?»: в
 * шлюзе флаги лежат ВНУТРИ функции, и его вызов ручной копией не считается.
 */
function sqlPieces(fileName: string, src: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false, kind);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) out.push(n.head.text + n.templateSpans.map((sp) => ' ? ' + sp.literal.text).join(''));
    ts.forEachChild(n, visit);
  };
  visit(file);
  // Комментарий SQL — история, а не условие: «-- раньше стояло is_active = true».
  return out.map((p) => p.replace(/--[^\n]*/g, ''));
}

/**
 * Сколько флагов витрины набрано в файле руками на туре. Считаются:
 *   - флаг на алиасе `operator_tours` (`ot.is_published = true`) — в куске,
 *     где этот алиас привязан к туру, или во фрагменте условия без FROM, если
 *     алиас привязан к туру где-то в файле (`conditions.push('t.is_active = true')`);
 *   - флаг без алиаса в отрезке голого чтения — от `FROM operator_tours` до
 *     следующего FROM/JOIN: флаг соседней таблицы в том же запросе
 *     (`FROM partners WHERE is_active = true`) туром не считается;
 *   - фрагмент условия без алиаса (`['is_active = true']`) в файле с голым
 *     чтением тура.
 * Запись (`UPDATE operator_tours SET is_active = true`) — не чтение и не
 * считается: в ней нет FROM/JOIN тура.
 */
function handShowcaseFlags(fileName: string, src: string): number {
  const pieces = sqlPieces(fileName, src);
  const fileAliases = new Set<string>();
  let fileBare = false;
  for (const p of pieces) {
    for (const m of p.matchAll(READ)) {
      if (isAlias(m[1])) fileAliases.add(m[1]); else fileBare = true;
    }
  }
  if (fileAliases.size === 0 && !fileBare) return 0;
  let n = 0;
  const count = (text: string, re: RegExp) => { n += [...text.matchAll(re)].length; };
  const bareFlag = new RegExp(String.raw`(?<![\w.])${FLAG}`, 'gi');
  for (const p of pieces) {
    const hasFrom = /\b(?:FROM|JOIN)\b/i.test(p);
    const aliases = hasFrom
      ? new Set([...p.matchAll(BIND)].filter((m) => m[1] === 'operator_tours' && isAlias(m[2])).map((m) => m[2]))
      : new Set(fileAliases);
    aliases.add('operator_tours');
    for (const a of aliases) count(p, new RegExp(String.raw`\b${a}\.${FLAG}`, 'gi'));
    for (const m of p.matchAll(READ)) {
      if (isAlias(m[1])) continue;
      const rest = p.slice((m.index ?? 0) + m[0].length - (m[1]?.length ?? 0));
      const stop = rest.search(/\b(?:FROM|JOIN)\b/i);
      count(stop < 0 ? rest : rest.slice(0, stop), bareFlag);
    }
    if (!hasFrom && fileBare && new RegExp(String.raw`^\s*(?:AND\s+)?\(?\s*${FLAG}`, 'i').test(p)) count(p, bareFlag);
  }
  return n;
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

/**
 * Долг на 15.10: файл → число флагов витрины, набранных руками, и причина.
 * Только сокращается. Перевёл файл на publicTourSql — уменьши число; убрал
 * все — удали запись; новый файл появиться здесь не может. Причина говорит,
 * чем запись является: не витрина (админка, перепись, кабинет партнёра,
 * внутренний агент — им снятый тур виден по делу) или витрина с ВСЕМИ тремя
 * флагами руками (совпадает со шлюзом, пока его не поправят).
 *
 * Третьего рода — витрины с НЕПОЛНОЙ копией — больше нет и быть не может
 * (ревью #2642): кабинет подписывает черновик «туристы не видят», и витрина
 * без is_published делает эту подпись ложью. Тринадцать таких записей
 * переведены на шлюз; запись с иной причиной, чем две выше, сторож не примет.
 */
const NOT_SHOWCASE = 'не витрина';
const FULL_COPY = 'витрина, все три флага руками: сегодня совпадает со шлюзом, разойдётся при первой его правке';
const KNOWN_HAND_COPIES: Record<string, { n: number; why: string }> = {
  'app/seat-request/test/page.tsx': { n: 1, why: `${NOT_SHOWCASE}: тестовый стенд 24.10 — только неопубликованный тур тестового оператора, по прямой ссылке` },
  'app/api/admin/ai-assistant/route.ts': { n: 1, why: `${NOT_SHOWCASE}: счёт активных туров в контекст ассистента админки` },
  'app/api/admin/content/tours/route.ts': { n: 1, why: `${NOT_SHOWCASE}: фильтр админки по статусу — видит все состояния намеренно` },
  'app/api/admin/stats/route.ts': { n: 1, why: `${NOT_SHOWCASE}: сводка админки «активных туров»` },
  'app/api/admin/tours/route.ts': { n: 1, why: `${NOT_SHOWCASE}: фильтр админки по статусу — видит все состояния намеренно` },
  'app/api/agent/find-tours/route.ts': { n: 2, why: `${FULL_COPY} (подбор для турагента)` },
  'app/api/agent/tours/route.ts': { n: 2, why: `${FULL_COPY} (список для турагента)` },
  'app/api/cron/channel-readiness/route.ts': { n: 1, why: `${NOT_SHOWCASE}: перепись считает именно «активен, но не опубликован» — обратное условие` },
  'app/api/cron/digest/route.ts': { n: 2, why: `${NOT_SHOWCASE}: дайджест владельцу, счёт активных туров` },
  'app/api/cron/guide-readiness/route.ts': { n: 1, why: `${NOT_SHOWCASE}: перепись готовности гидов` },
  'app/api/cron/leads-followup/route.ts': { n: 1, why: `${NOT_SHOWCASE}: добивка лидов выбирает партнёра по виду его тура, тур туристу не показывается` },
  'app/api/cron/partner-candidates-census/route.ts': { n: 1, why: `${NOT_SHOWCASE}: перепись кандидатов в партнёры` },
  'app/api/cron/planner-material-census/route.ts': { n: 2, why: `${FULL_COPY} (перепись меряет материал витрины планера)` },
  'app/api/cron/pricing-rules-census/route.ts': { n: 3, why: `${NOT_SHOWCASE}: перепись правил цены, своё определение «живого» в ответе` },
  'app/api/cron/smart-notify/route.ts': { n: 2, why: `${FULL_COPY} (рассылка туристам)` },
  'app/api/cron/tour-describe/route.ts': { n: 1, why: `${NOT_SHOWCASE}: писатель описаний — черновику тоже нужен текст до публикации` },
  'app/api/cron/tour-photos-census/route.ts': { n: 1, why: `${NOT_SHOWCASE}: перепись снимков туров` },
  'app/api/hub/operator/pricing-rules/route.ts': { n: 1, why: `${NOT_SHOWCASE}: кабинет оператора, свои туры` },
  'app/api/routes/analysis/route.ts': { n: 1, why: `${NOT_SHOWCASE}: аналитика маршрутов, счёт активных среди всех туров места` },
  'app/api/telegram/admin/route.ts': { n: 1, why: `${NOT_SHOWCASE}: статистика админ-бота` },
  'app/api/telegram/webhook/route.ts': { n: 1, why: `${NOT_SHOWCASE}: команда статистики для админа в боте` },
  'app/hub/admin/channels/page.tsx': { n: 2, why: `${FULL_COPY} (счёт готовых к выкладке в админке каналов)` },
  'lib/admin/alerts.ts': { n: 1, why: `${NOT_SHOWCASE}: тревоги админки о состоянии каталога` },
  'lib/agents/agencies/marketing-agency.ts': { n: 1, why: `${NOT_SHOWCASE}: контекст внутреннего агента` },
  'lib/agents/agencies/rescue-agency.ts': { n: 1, why: `${NOT_SHOWCASE}: безопасность — турист уже едет и на снятый с витрины тур` },
  'lib/agents/execution/initiative-executor.ts': { n: 4, why: `${NOT_SHOWCASE}: исполнитель инициатив эволюции, внутренние счёты` },
  'lib/agents/scout-innovator.ts': { n: 1, why: `${NOT_SHOWCASE}: счёт в контекст внутреннего агента` },
  'lib/agents/sdk/operator-tools.ts': { n: 1, why: `${NOT_SHOWCASE}: инструменты оператора, свои туры` },
  'lib/agents/warmup.ts': { n: 1, why: `${NOT_SHOWCASE}: счёт в контекст прогрева` },
  'lib/bookings/reserve.ts': { n: 2, why: `${FULL_COPY} (дверь брони под FOR UPDATE — компонент брони, правка по §5 отдельным планом)` },
  'lib/channels/ready-tours.ts': { n: 2, why: `${FULL_COPY} (фид каналов; пункт 1.10 его оставляет как есть)` },
  'lib/eco/compensation.ts': { n: 1, why: `${NOT_SHOWCASE}: порог эко «активный оператор», не показ тура` },
  'lib/guides/team-queries.ts': { n: 1, why: `${NOT_SHOWCASE}: кабинет гида и команды` },
  'lib/leads/create.ts': { n: 1, why: `${NOT_SHOWCASE}: атрибуция лида оператору, тур не показывается` },
  'lib/notifications/telegram-channel.ts': { n: 2, why: `${FULL_COPY} (пост в канал)` },
  'lib/safety/safety-selfcheck.ts': { n: 1, why: `${NOT_SHOWCASE}: самопроверка «есть покупаемый тур», диагностика` },
  'lib/seat-requests/service.ts': { n: 2, why: `${FULL_COPY} (запрос мест из планера)` },
  'lib/services/analytics.service.ts': { n: 1, why: `${NOT_SHOWCASE}: аналитика, счёт` },
  'lib/services/routes/route-description-cache.ts': { n: 1, why: `${NOT_SHOWCASE}: писатель кэша описаний` },
  'lib/services/tours/booking-funnel-stages.ts': { n: 2, why: `${NOT_SHOWCASE}: диагностика воронки, счёт предложения` },
  'lib/telegram/welcome.ts': { n: 1, why: `${NOT_SHOWCASE}: приветствие оператора, свои туры` },
  'lib/tours/top-tour-by-activity.ts': { n: 4, why: `${FULL_COPY} (пункт 1.10 его оставляет как есть)` },
};

/** Читатели, переведённые на шлюз находкой P1-04: в список долга не возвращаются. */
const MOVED_TO_GATE = [
  'lib/planner/compose.ts',
  'lib/planner/data.ts',
  'lib/search/tour-recommend.ts',
  'lib/search/tour-search.ts',
  'app/api/tours-feed/route.ts',
  'lib/agents/sdk/tourist-tools.ts',
  'app/_home/data.ts',
  'lib/operators/list-query.ts',
  'lib/places/place-detail.ts',
  // Ревью #2642: подпись кабинета «Черновик — туристы не видят» правдива,
  // только если черновик не уходит туристу ни одним отбором.
  'app/api/ai/knowledge-base/route.ts',
  'app/api/availability/day/route.ts',
  'app/api/availability/route.ts',
  'app/api/discovery/search/route.ts',
  'app/api/home/metrics/route.ts',
  'app/api/meta/catalog/route.ts',
  'app/api/planner/partners/route.ts',
  'app/api/planner/tours-for-day/route.ts',
  'app/api/public/now/route.ts',
  'app/api/trip/plan/route.ts',
  'app/fish/[id]/page.tsx',
  'app/hub/fishing/page.tsx',
  'lib/kuzmich/engagement.ts',
  'lib/notifications/tour-channel-post.ts',
  'lib/octo/service.ts',
  'lib/services/operators/lead-processor.service.ts',
  'lib/services/search.service.ts',
  'lib/services/tours/tour.service.ts',
];

describe('перепись детектора ручной копии (сторож на сторожа)', () => {
  const n = (src: string) => handShowcaseFlags('x.ts', src);

  it('находит копию на алиасе, во фрагменте условия и в голом чтении', () => {
    expect(n('q(`SELECT 1 FROM operator_tours t WHERE t.is_active = true AND t.is_published = TRUE`)')).toBe(2);
    expect(n("const c = ['t.is_active = true']; q(`SELECT 1 FROM operator_tours t WHERE ${c}`)")).toBe(1);
    expect(n('q(`SELECT COUNT(*) FROM operator_tours WHERE is_published IS TRUE`)')).toBe(1);
    expect(n("const c = ['is_active = true']; q(`SELECT 1 FROM operator_tours WHERE ${c}`)")).toBe(1);
  });

  it('шлюз, чужая таблица, запись и комментарии копией не считаются', () => {
    expect(n('q(`SELECT 1 FROM operator_tours ot WHERE ${publicTourSql(\'ot\')}`)')).toBe(0);
    expect(n('q(`SELECT (SELECT 1 FROM operator_tours) AS a, (SELECT 1 FROM partners WHERE is_active = true) AS b`)')).toBe(0);
    expect(n('q(`SELECT 1 FROM operator_tours ot JOIN partners p ON p.id = ot.operator_id WHERE p.is_active = true`)')).toBe(0);
    expect(n('q(`UPDATE operator_tours SET is_active = true WHERE id = $1`)')).toBe(0);
    expect(n('// ot.is_active = true\nq(`SELECT 1 FROM operator_tours ot -- ot.is_active = true\n WHERE ot.id = $1`)')).toBe(0);
  });
});

describe('витрина туров в app/ и lib/ — через шлюз (находка аудита 15.10 P1-04)', () => {
  const found = new Map<string, number>();
  let readers = 0;
  for (const f of [...sourceFiles(join(ROOT, 'app')), ...sourceFiles(join(ROOT, 'lib'))]) {
    const src = readFileSync(f, 'utf-8');
    if (/\b(?:FROM|JOIN)\s+operator_tours\b/i.test(src)) readers++;
    const k = handShowcaseFlags(f, src);
    if (k > 0) found.set(relative(ROOT, f), k);
  }

  it('перепись видит читателей тура (смотрящая не туда не выглядит успешной)', () => {
    expect(readers).toBeGreaterThanOrEqual(100);
    expect(found.size).toBeGreaterThan(0);
  });

  it('новая ручная копия условия витрины — красная: зовите publicTourSql', () => {
    const fresh = [...found].filter(([f, k]) => k > (KNOWN_HAND_COPIES[f]?.n ?? 0)).map(([f, k]) => `${f}: ${k}`);
    expect(
      fresh,
      'условие «тур на витрине» набрано руками. Позовите publicTourSql '
      + '(lib/tours/public-visibility.ts): копия однажды разойдётся со шлюзом, как '
      + 'план поездки без deleted_at. Если тур здесь виден по делу (админка, '
      + 'перепись, кабинет партнёра) — запись в KNOWN_HAND_COPIES с причиной',
    ).toEqual([]);
  });

  it('список долга самоустаревает: число в записи равно найденному', () => {
    const stale = Object.entries(KNOWN_HAND_COPIES)
      .filter(([f, { n }]) => (found.get(f) ?? 0) !== n)
      .map(([f, { n }]) => `${f}: записано ${n}, найдено ${found.get(f) ?? 0}${existsSync(join(ROOT, f)) ? '' : ' (файла нет)'}`);
    expect(stale, 'копий стало меньше — уменьшите запись, не осталось — удалите её').toEqual([]);
  });

  it('у каждой записи есть причина', () => {
    for (const [f, { why }] of Object.entries(KNOWN_HAND_COPIES)) expect(why.length, f).toBeGreaterThan(25);
  });

  it('витрина с неполной копией в долге стоять не может (ревью #2642)', () => {
    // Причина записи — один из двух родов. Витрина без is_published или без
    // deleted_at делает ложью подпись кабинета «туристы не видят»: такой файл
    // переводится на шлюз, а не записывается в долг.
    const other = Object.entries(KNOWN_HAND_COPIES)
      .filter(([, { why }]) => !why.startsWith(`${NOT_SHOWCASE}:`) && !why.startsWith(FULL_COPY))
      .map(([f, { why }]) => `${f}: ${why}`);
    expect(other).toEqual([]);
  });

  it('переведённые читатели в список долга не возвращаются', () => {
    for (const f of MOVED_TO_GATE) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
      expect(KNOWN_HAND_COPIES[f], f).toBeUndefined();
    }
  });

  it('второго канона нет: LIVE_TOUR_CONDITIONS не встречается в коде app/ и lib/', () => {
    // Запрет, не литерал реализации: два канона одного правила — это то, с
    // чего началась находка.
    const declared = [...sourceFiles(join(ROOT, 'app')), ...sourceFiles(join(ROOT, 'lib'))]
      .filter((f) => /\bLIVE_TOUR_CONDITIONS\b/.test(readFileSync(f, 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
      .map((f) => relative(ROOT, f));
    expect(declared).toEqual([]);
  });
});

describe('переведённые читатели — поведением: в отправленном SQL стоит шлюз', () => {
  const sentPool = () => poolQueryMock.mock.calls.map((c) => String(c[0]));
  const sentQuery = () => queryMock.mock.calls.map((c) => String(c[0]));

  it('план поездки (composeTrip) отбирает туры шлюзом', async () => {
    poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const plan = await composeTrip({ total_days: 5, budget_total: 100000, interests: ['fishing'], month: 7, group_size: 2 });
    expect(plan).toBeNull();
    expect(sentPool()).toHaveLength(1);
    expect(sentPool()[0]).toContain(publicTourSql('t'));
  });

  it('запасной тур плана (fetchContingencyAlternatives) — тур витрины', async () => {
    poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await fetchContingencyAlternatives('1', createPlannerCache());
    expect(sentPool()[0]).toContain(publicTourSql('ot'));
  });

  it('рекомендации: каждая стратегия и запасной список — через шлюз', async () => {
    // История есть: тур 7 забронирован. Профиль и виды туриста — его прошлое,
    // шлюз не спрашивают; кандидаты в рекомендацию — спрашивают все.
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM operator_bookings\s+WHERE user_id/.test(sql)) return { rows: [{ tour_id: '7' }] };
      if (/AVG\(base_price\)/.test(sql)) return { rows: [{ avg_price: 1000, top_category: 'fishing', top_difficulty: 'easy' }] };
      return { rows: [] };
    });
    await getRecommendations('00000000-0000-4000-8000-000000000001', 6);
    const candidates = sentQuery().filter((s) => /\bLIMIT\s+\$\d/.test(s) && !/FROM operator_bookings\s+WHERE user_id/.test(s));
    // похожие, по содержимому, эко и запасной список
    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toContain(publicTourSql('t'));
    for (const s of candidates.slice(1)) expect(s).toContain(publicTourSql(''));
  });

  it('фид для площадок (/api/tours-feed) — только витрина', async () => {
    poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await toursFeed(new Request('http://localhost/api/tours-feed') as never);
    expect(res.status).toBe(200);
    expect(sentPool()[0]).toContain(publicTourSql('t'));
  });

  it('инструменты Кузьмича: поиск, подробности, даты, сравнение', async () => {
    poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const tools = getTouristTools(null);
    const run = (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`инструмента ${name} нет`);
      return t.execute(args);
    };
    await run('search_tours', {});
    await run('get_tour_details', { tour_id: '1' });
    await run('check_availability', { tour_id: '1' });
    await run('compare_tours', { tour_ids: '1,2' });
    const sent = sentPool();
    expect(sent).toHaveLength(4);
    for (const s of sent) expect(s).toContain(publicTourSql('t'));
  });
});

// ── Ревью #2642: отборы для туриста — реестр, перепись и поведение ─────────

/**
 * Кабинет оператора подписывает тур вне витрины «Черновик — туристы не видят»
 * или «Скрыт». Подпись правдива, только пока КАЖДЫЙ отбор туров, который видит
 * турист или чужая площадка, спрашивает шлюз. Ревью #2642 нашло три отбора,
 * судивших по is_active/deleted_at без is_published (поиск
 * /api/discovery/search, фид Meta, подбор туров в предложение по лиду), а
 * перепись — ещё: подсказки поиска, календарь, плашку «ближайший выезд»,
 * базу знаний ассистента, напоминание в Telegram, пост в канал, OCTO для
 * реселлеров, публичную подборку по ссылке и ленту главной (у двух последних
 * флагов не было вовсе — их не видела и перепись ручных копий выше).
 *
 * Сторож держит связку с трёх сторон:
 *   - реестр TOURIST_SELECTIONS: файл и чью витрину он кормит. Запрет
 *     регуляркой (допустим как запрет): файл реестра читает operator_tours и
 *     не зовёт шлюз, или держит рядом ручной флаг витрины;
 *   - перепись поверхностей, которые турист открывает без входа: роут /api/*,
 *     куда Edge пускает анонима (lib/auth/public-api-routes), и страница или
 *     роут вне /api и /hub/admin. Читает operator_tours — либо в реестре, либо
 *     в NOT_TOURIST_SELECTION с причиной; молчание не ответ. Записи
 *     самоустаревают: файл пропал из переписи — запись удаляется;
 *   - поведение: SQL, который отборы реально отправляют, несёт шлюз (ниже,
 *     на моке), а черновик не доходит до выдачи на настоящей базе
 *     (tests/integration/public-tour-gate.pg.test.ts).
 */
const TOURIST_SELECTIONS: Record<string, string> = {
  // Каталог и карточка
  'app/api/tours/route.ts': 'список туров GET /api/tours',
  'app/api/tours/[id]/route.ts': 'карточка тура по id',
  'app/api/tours/[id]/slots/route.ts': 'свободные даты тура',
  'app/api/tours/[id]/price/route.ts': 'цена тура на дату',
  'app/api/tours/[id]/availability/route.ts': 'доступность тура',
  'lib/tours/tour-detail-query.ts': 'каноническое чтение карточки /catalog/tours/[id]',
  'lib/search/tour-search.ts': 'каталог /catalog и поиск по словам',
  'lib/search/tour-recommend.ts': 'персональные рекомендации',
  'app/_home/data.ts': 'туры на главной',
  'app/api/home/metrics/route.ts': 'счёт туров на главной',
  'app/api/live-feed/route.ts': 'лента броней на главной: называет тур',
  'app/api/public/now/route.ts': 'плашка «ближайший выезд»',
  'app/api/availability/route.ts': 'публичный календарь дат',
  'app/api/availability/day/route.ts': 'туры на выбранный день календаря',
  'app/fish/[id]/page.tsx': 'туры на странице вида рыбы',
  'app/hub/fishing/page.tsx': 'витрина рыбалки',
  'app/operators/[slug]/page.tsx': 'страница оператора',
  'lib/operators/list-query.ts': 'список компаний /operators, факты из живых туров',
  'lib/places/place-detail.ts': '«Туры сюда» на карточке места',
  // Поиск /api/discovery/search
  'app/api/discovery/search/route.ts': 'поиск туров по AI-тегам',
  'lib/services/tours/tour.service.ts': 'поиск туров по словам и фильтрам',
  'lib/services/search.service.ts': 'автодополнение, рекомендованные, тренды, теги, похожие',
  // Планер и подбор
  'lib/planner/compose.ts': 'тур-бандл плана поездки',
  'lib/planner/data.ts': 'туры и запасные туры планера',
  'app/api/planner/partners/route.ts': 'операторы дня планера по их турам',
  'app/api/planner/tours-for-day/route.ts': 'туры на день планера',
  'app/api/trip/plan/route.ts': 'план поездки ИИ (вызывающих нет, запрос читает несуществующие колонки — шлюз стоит, чтобы починка не вернула черновик)',
  'lib/services/operators/lead-processor.service.ts': 'подбор трёх туров в предложение клиенту по лиду',
  'app/api/p/[code]/route.ts': 'подборка оператора, открытая клиентом по ссылке',
  // Кузьмич, ИИ и агенты
  'lib/kuzmich/core.ts': 'общий мозг Кузьмича',
  'lib/kuzmich/tour-availability-tool.ts': 'инструмент дат Кузьмича',
  'lib/agents/sdk/tourist-tools.ts': 'инструменты туриста: поиск, подробности, даты, сравнение',
  'lib/ai/booking-intent.ts': 'туры в чате по намерению',
  'lib/telegram/tourist-tours.ts': 'кнопки туров в Telegram-боте туриста',
  'lib/kuzmich/engagement.ts': 'напоминание туристу о туре в Telegram',
  'lib/embed/widget-chat.ts': 'чат виджета на сайте партнёра',
  'lib/mcp/connector-tools.ts': 'MCP-коннекторы (ChatGPT)',
  'app/api/ai/knowledge-base/route.ts': 'база знаний ассистента, отвечающего туристу',
  // Внешние площадки и обходчики
  'app/api/tours-feed/route.ts': 'фид для площадок',
  'app/api/meta/catalog/route.ts': 'фид каталога для Meta (Instagram, WhatsApp)',
  'lib/octo/service.ts': 'OCTO для реселлеров: продукты, даты, холд',
  'lib/notifications/tour-channel-post.ts': 'пост тура в Telegram-канал',
  'lib/seo/sitemap-entries.ts': 'sitemap',
  'lib/seo/query-landings-data.ts': 'посадочные страницы по запросам',
  'app/llms.txt/route.ts': 'llms.txt для ИИ-поиска',
  'lib/zh/entry.ts': 'китайский вход /zh',
  'lib/zh/content.ts': 'китайские конспекты туров и мест',
};

/** Префиксы, которые перепись публичных роутов не судит, — с причиной. */
const CENSUS_SKIP: Record<string, string> = {
  '/api/cron/': 'Edge пускает крон без входа, но внутри CRON_SECRET: турист сюда не ходит; '
    + 'крон, рассылающий туры людям, держит перепись ручных копий выше',
};

/**
 * Публичный роут читает operator_tours, но тур туристу не ОТБИРАЕТ — с
 * причиной. Самоустаревает: файл ушёл из переписи — запись удаляется.
 */
const NOT_TOURIST_SELECTION: Record<string, string> = {
  'app/seat-request/test/page.tsx': 'тестовый стенд пилота рыбалки (24.10): тур тестового оператора по прямой ссылке, витрины нет',
  'app/api/reviews/route.ts': 'отбор отзывов, а не туров: правдивый отзыв туриста не убирается вместе с туром (§0), название тура — подпись к нему',
  'app/api/reviews/my/route.ts': 'свои отзывы туриста о турах, на которых он был',
  'app/api/hub/bookings/[id]/route.ts': 'бронь туриста по её ключу: тур — тот, что он купил, даже если его сняли с витрины потом',
  'app/api/hub/bookings/[id]/pdf/route.ts': 'PDF брони по её ключу: тур — тот, что в брони',
  'app/api/payments/tochka/qr/route.ts': 'QR оплаты брони: тур — тот, что в брони',
  'app/api/payments/webhook/route.ts': 'приёмник оплаты: тур — тот, что в оплаченной брони',
  'app/api/hub/operator/payments/webhook/route.ts': 'приёмник оплаты: тур — тот, что в оплаченной брони',
  'app/api/safety/warnings/route.ts': 'опасности маршрута по id тура: нужны и по снятому туру, на который турист уже едет; списка туров не отдаёт',
  'app/api/routes/analysis/route.ts': 'аналитика мест для админки: счётчики по всем турам места, ни названий, ни карточек',
  'app/api/health/booking-funnel/route.ts': 'диагностика воронки за requireAdmin: счёт туров и броней',
  'app/api/telegram/admin/route.ts': 'бот владельца: статистика, туров туристу не показывает',
  'app/api/telegram/webhook/route.ts': 'команда статистики владельца в боте: счёт туров',
};

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Методы, которые роут экспортирует. */
function exportedMethods(src: string): string[] {
  return HTTP_METHODS.filter((m) => new RegExp(
    String.raw`export\s+(?:async\s+)?function\s+${m}\b|export\s+const\s+${m}\b|export\s*\{[^}]*\b${m}\b[^}]*\}`,
  ).test(src));
}

/** Адрес роута по пути файла: `[code]` — один сегмент, `(группа)` — без сегмента. */
function urlOf(rel: string): string {
  const segs = rel.replace(/^app\//, '').replace(/\/route\.tsx?$/, '').split('/')
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .map((seg) => (seg.startsWith('[') ? 'x' : seg));
  return `/${segs.join('/')}`;
}

/** Читает ли файл тур — в SQL, а не в комментарии. */
function readsTours(fileName: string, src: string): boolean {
  return sqlPieces(fileName, src).some((p) => /\b(?:FROM|JOIN)\s+operator_tours\b/i.test(p));
}

/** Зовёт ли файл шлюз — вызовом, а не упоминанием в комментарии. */
function callsGate(fileName: string, src: string): boolean {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false, kind);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'publicTourSql') found = true;
    else ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
}

/** Поверхности, которые турист открывает без входа и которые читают тур. */
function touristSurfaceReaders(): { api: string[]; pages: string[] } {
  const api: string[] = [];
  const pages: string[] = [];
  for (const f of sourceFiles(join(ROOT, 'app'))) {
    const rel = relative(ROOT, f);
    const src = readFileSync(f, 'utf-8');
    if (!readsTours(f, src)) continue;
    if (rel.startsWith('app/api/')) {
      if (!/\/route\.tsx?$/.test(rel)) continue;
      const url = urlOf(rel);
      if (Object.keys(CENSUS_SKIP).some((p) => url.startsWith(p))) continue;
      if (exportedMethods(src).some((m) => isPublicApiPath(url, m))) api.push(rel);
    } else if (!rel.startsWith('app/hub/admin/')) {
      pages.push(rel);
    }
  }
  return { api: api.sort(), pages: pages.sort() };
}

describe('отборы для туриста — через шлюз (ревью #2642)', () => {
  const surfaces = touristSurfaceReaders();

  it('перепись видит публичных читателей тура (смотрящая не туда не выглядит успешной)', () => {
    expect(surfaces.api.length).toBeGreaterThanOrEqual(15);
    expect(surfaces.pages.length).toBeGreaterThanOrEqual(4);
    // Сверка самой переписи на известном: публичная подборка — роут без входа.
    expect(surfaces.api).toContain('app/api/p/[code]/route.ts');
    expect(urlOf('app/api/p/[code]/route.ts')).toBe('/api/p/x');
  });

  it('файл реестра читает тур и зовёт шлюз — отбор для туриста без шлюза запрещён', () => {
    const bad: string[] = [];
    for (const [f, surface] of Object.entries(TOURIST_SELECTIONS)) {
      const p = join(ROOT, f);
      if (!existsSync(p)) { bad.push(`${f}: файла нет (${surface})`); continue; }
      const src = readFileSync(p, 'utf-8');
      if (!readsTours(p, src)) bad.push(`${f}: operator_tours не читает — запись устарела`);
      else if (!callsGate(p, src)) bad.push(`${f}: читает тур без publicTourSql (${surface})`);
      const hand = handShowcaseFlags(p, src);
      if (hand > 0) bad.push(`${f}: флагов витрины руками ${hand} — рядом со шлюзом их быть не должно`);
    }
    expect(bad, 'отбор туров для туриста обязан спрашивать шлюз витрины').toEqual([]);
  });

  it('публичный читатель тура — либо отбор в реестре, либо исключение с причиной', () => {
    const silent = [...surfaces.api, ...surfaces.pages]
      .filter((f) => !(f in TOURIST_SELECTIONS) && !(f in NOT_TOURIST_SELECTION));
    expect(
      silent,
      'поверхность, которую турист открывает без входа, читает operator_tours. Отбираете тур '
      + 'для туриста — позовите publicTourSql и внесите файл в TOURIST_SELECTIONS; не отбираете '
      + '(бронь по ключу, оплата, отзыв) — запись в NOT_TOURIST_SELECTION с причиной',
    ).toEqual([]);
  });

  it('исключения самоустаревают и не прячут отбор', () => {
    const all = new Set([...surfaces.api, ...surfaces.pages]);
    const stale = Object.keys(NOT_TOURIST_SELECTION).filter((f) => !all.has(f));
    expect(stale, 'файл ушёл из переписи (не публичный или не читает тур) — удалите запись').toEqual([]);
    const both = Object.keys(NOT_TOURIST_SELECTION).filter((f) => f in TOURIST_SELECTIONS);
    expect(both).toEqual([]);
    for (const [f, why] of Object.entries(NOT_TOURIST_SELECTION)) expect(why.length, f).toBeGreaterThan(25);
  });
});

describe('отборы ревью #2642 — поведением: в отправленном SQL стоит шлюз', () => {
  const GATES = ['ot', 't', ''].map((a) => publicTourSql(a));
  /** SQL, читающие тур, — каждый со шлюзом; и хотя бы один такой был. */
  const expectGated = (sent: string[], label: string) => {
    const reads = sent.filter((s) => /\b(?:FROM|JOIN)\s+operator_tours\b/i.test(s));
    expect(reads.length, `${label}: тур не читался вовсе`).toBeGreaterThan(0);
    for (const s of reads) expect(GATES.some((g) => s.includes(g)), `${label}: ${s.slice(0, 160)}`).toBe(true);
  };
  const sentPool = () => poolQueryMock.mock.calls.map((c) => String(c[0]));
  const sentQuery = () => queryMock.mock.calls.map((c) => String(c[0]));
  const empty = { rows: [], rowCount: 0 };

  it('GET /api/discovery/search: ветка AI-тегов и поиск по словам', async () => {
    queryMock.mockResolvedValue(empty);
    poolQueryMock.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 });
    const { GET } = await import('@/app/api/discovery/search/route');
    const { NextRequest } = await import('next/server');
    expect((await GET(new NextRequest('http://localhost/api/discovery/search?landscape=volcano'))).status).toBe(200);
    expectGated(sentQuery(), 'ai_tags');
    expect((await GET(new NextRequest('http://localhost/api/discovery/search?q=%D0%B2%D1%83%D0%BB%D0%BA%D0%B0%D0%BD'))).status).toBe(200);
    expect(sentPool()).toHaveLength(2); // счёт и выдача
    expectGated(sentPool(), 'поиск по словам');
  });

  describe('отказ базы — 500 словами: текст исключения анониму не уходит, в логе имя проверки и SQLSTATE (ревью #2642)', () => {
    // Так PostgreSQL называет отказ: таблица и колонка — то, чего аноним знать
    // не должен. Слово поиска — то, чему не место в логе.
    const LEAK = 'column t.secret_col of relation operator_tours does not exist';
    const WORD = 'тайноеслово';
    const reject = () => Object.assign(new Error(LEAK), { code: '42703' });
    const nextReq = async (url: string) => new (await import('next/server')).NextRequest(url);

    const CASES: Array<{ name: string; scope: string; check: string; text: string; call: () => Promise<Response> }> = [
      {
        name: 'поиск по словам', scope: 'discovery-search', check: 'поиск по словам',
        text: 'Поиск временно не работает, попробуйте позже',
        call: async () => (await import('@/app/api/discovery/search/route')).GET(await nextReq(`http://localhost/api/discovery/search?q=${encodeURIComponent(WORD)}`)),
      },
      {
        name: 'поиск по AI-тегам', scope: 'discovery-search', check: 'поиск по AI-тегам',
        text: 'Поиск временно не работает, попробуйте позже',
        call: async () => (await import('@/app/api/discovery/search/route')).GET(await nextReq(`http://localhost/api/discovery/search?landscape=${encodeURIComponent(WORD)}`)),
      },
      {
        name: 'расширенный поиск', scope: 'discovery-search', check: 'расширенный поиск',
        text: 'Поиск временно не работает, попробуйте позже',
        call: async () => (await import('@/app/api/discovery/search/route')).GET(await nextReq(`http://localhost/api/discovery/search?advanced=true&q=${encodeURIComponent(WORD)}`)),
      },
      {
        name: 'календарь месяца', scope: 'availability', check: 'календарь месяца',
        text: 'Календарь временно не загружается, попробуйте позже',
        call: async () => (await import('@/app/api/availability/route')).GET(await nextReq('http://localhost/api/availability?month=2099-07')),
      },
      {
        name: 'туры дня', scope: 'availability-day', check: 'туры дня',
        text: 'Туры на эту дату временно не загружаются, попробуйте позже',
        call: async () => (await import('@/app/api/availability/day/route')).GET(await nextReq('http://localhost/api/availability/day?date=2099-07-01')),
      },
      {
        name: 'лента главной', scope: 'live-feed', check: 'лента главной',
        text: 'Лента временно не загружается, попробуйте позже',
        call: async () => (await import('@/app/api/live-feed/route')).GET(),
      },
      {
        name: 'операторы дня в планере', scope: 'planner-partners', check: 'операторы дня',
        text: 'Операторы временно не загружаются, попробуйте позже',
        call: async () => (await import('@/app/api/planner/partners/route')).GET(await nextReq('http://localhost/api/planner/partners?activity_type=fishing')),
      },
    ];

    it.each(CASES)('$name', async (c) => {
      queryMock.mockRejectedValue(reject());
      poolQueryMock.mockRejectedValue(reject());
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const res = await c.call();
        // Не пустая выдача с success: отказ — это 500 (§4.0).
        expect(res.status).toBe(500);
        const raw = await res.text();
        expect(raw).not.toContain('secret_col');
        expect(raw).not.toContain('operator_tours');
        const body = JSON.parse(raw) as { error?: unknown; message?: unknown };
        expect(body.error).toBe(c.text);
        expect(body.message).toBeUndefined();
        // Отказ назван: область, проверка и SQLSTATE.
        expect(err).toHaveBeenCalledWith(
          expect.stringContaining(`[${c.scope}] ${c.check}`),
          expect.objectContaining({ code: '42703' }),
        );
        // Слово поиска в лог не идёт.
        expect(JSON.stringify(err.mock.calls)).not.toContain(WORD);
      } finally {
        err.mockRestore();
      }
    });
  });

  describe('неверный вход — 400 словами до базы, без строки отказа в логе (ревью #2642, третий круг)', () => {
    // Прежде такой вход доходил до базы: `page=0` давал OFFSET -20 (2201X),
    // `limit=-1` — 2201W, `page=abc` в ветке AI-тегов — NaN в bigint (22P02),
    // `2099-02-30` — 22008, NUL в тексте — 22021. Человек читал «временно не
    // работает», хотя повтор ничего не изменит, а лог отказов базы заполнялся
    // чужими опечатками. Здесь вход судится вызовом роута: статус, имя
    // параметра, фраза — и что ни пул, ни лог не тронуты.
    const nextReq = async (url: string) => new (await import('next/server')).NextRequest(url);
    const search = async (qs: string) =>
      (await import('@/app/api/discovery/search/route')).GET(await nextReq(`http://localhost/api/discovery/search?${qs}`));
    const day = async (qs: string) =>
      (await import('@/app/api/availability/day/route')).GET(await nextReq(`http://localhost/api/availability/day?${qs}`));
    const month = async (qs: string) =>
      (await import('@/app/api/availability/route')).GET(await nextReq(`http://localhost/api/availability?${qs}`));

    const PAGE = 'Номер страницы (page) — целое число от 1 до 10000';
    const LIMIT = 'Размер страницы (limit) — целое число от 1 до 100';
    const DATE = 'Дата (date) — день календаря в формате ГГГГ-ММ-ДД, например 2027-07-15';
    const MONTH = 'Месяц (month) — в формате ГГГГ-ММ, например 2027-07';
    const ACTIVITY = 'Вид активности (activity) содержит недопустимый символ';

    const CASES: Array<{ name: string; call: () => Promise<Response>; param: string; text: string }> = [
      { name: 'поиск: page=0', call: () => search('q=x&page=0'), param: 'page', text: PAGE },
      { name: 'поиск: limit=-1', call: () => search('q=x&limit=-1'), param: 'limit', text: LIMIT },
      { name: 'поиск: page=abc', call: () => search('q=x&page=abc'), param: 'page', text: PAGE },
      { name: 'поиск по AI-тегам: page=abc', call: () => search('landscape=volcano&page=abc'), param: 'page', text: PAGE },
      { name: 'поиск по AI-тегам: limit=0', call: () => search('feature=hot&limit=0'), param: 'limit', text: LIMIT },
      { name: 'расширенный: page=-3', call: () => search('advanced=true&q=x&page=-3'), param: 'page', text: PAGE },
      { name: 'поиск: page=1.5', call: () => search('page=1.5'), param: 'page', text: PAGE },
      { name: 'поиск: page=10001', call: () => search('page=10001'), param: 'page', text: PAGE },
      { name: 'поиск: limit=101', call: () => search('limit=101'), param: 'limit', text: LIMIT },
      { name: 'поиск: limit=1e2', call: () => search('limit=1e2'), param: 'limit', text: LIMIT },
      { name: 'поиск: minPrice=-5', call: () => search('minPrice=-5'), param: 'minPrice', text: 'Цена от (minPrice) — число не меньше 0, например 15000' },
      { name: 'поиск: maxPrice=abc', call: () => search('maxPrice=abc'), param: 'maxPrice', text: 'Цена до (maxPrice) — число не меньше 0, например 50000' },
      { name: 'поиск: rating=Infinity', call: () => search('rating=Infinity'), param: 'rating', text: 'Рейтинг от (rating) — число не меньше 0, например 4.5' },
      { name: 'поиск: NUL в тексте', call: () => search('q=%00'), param: 'q', text: 'Текст поиска (q) содержит недопустимый символ' },
      { name: 'поиск по AI-тегам: NUL в ландшафте', call: () => search('landscape=a%00b'), param: 'landscape', text: 'Ландшафт (landscape) содержит недопустимый символ' },
      { name: 'туры дня: 30 февраля', call: () => day('date=2099-02-30'), param: 'date', text: DATE },
      { name: 'туры дня: 13-й месяц', call: () => day('date=2099-13-01'), param: 'date', text: DATE },
      { name: 'туры дня: не дата', call: () => day('date=abc'), param: 'date', text: DATE },
      { name: 'туры дня: без даты', call: () => day(''), param: 'date', text: DATE },
      { name: 'туры дня: NUL в виде активности', call: () => day('date=2099-07-01&activity=%00'), param: 'activity', text: ACTIVITY },
      { name: 'календарь: 13-й месяц', call: () => month('month=2099-13'), param: 'month', text: MONTH },
      { name: 'календарь: месяц без числа', call: () => month('month=abc'), param: 'month', text: MONTH },
      { name: 'календарь: один год', call: () => month('month=2099'), param: 'month', text: MONTH },
      { name: 'календарь: нулевой год', call: () => month('month=0000-01'), param: 'month', text: MONTH },
      { name: 'календарь: NUL в виде активности', call: () => month('month=2099-07&activity=%00'), param: 'activity', text: ACTIVITY },
    ];

    it.each(CASES)('$name', async (c) => {
      // База ответила бы успехом — но спрашивать её нельзя.
      queryMock.mockResolvedValue(empty);
      poolQueryMock.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 });
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const res = await c.call();
        expect(res.status).toBe(400);
        const body = await res.json() as { success?: unknown; error?: unknown; param?: unknown };
        expect(body.success).toBe(false);
        expect(body.param).toBe(c.param);
        expect(body.error).toBe(c.text);
        expect(queryMock).not.toHaveBeenCalled();
        expect(poolQueryMock).not.toHaveBeenCalled();
        expect(err).not.toHaveBeenCalled();
      } finally {
        err.mockRestore();
      }
    });

    it('граничный верный вход доходит до базы числами; пустой параметр — как не заданный', async () => {
      poolQueryMock.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 });
      const res = await search('q=x&page=10000&limit=100&minPrice=0&maxPrice=1500.5&rating=4.5');
      expect(res.status).toBe(200);
      // [счёт, выдача]; у выдачи последние два — LIMIT и OFFSET.
      expect(poolQueryMock.mock.calls[1][1]).toEqual(['%x%', 0, 1500.5, 4.5, 100, 999_900]);

      poolQueryMock.mockClear();
      expect((await search('q=x&page=&limit=&minPrice=')).status).toBe(200);
      expect(poolQueryMock.mock.calls[1][1]).toEqual(['%x%', 20, 0]);

      queryMock.mockResolvedValue(empty);
      expect((await search('landscape=volcano&page=3&limit=5')).status).toBe(200);
      expect(queryMock.mock.calls[0][1]).toEqual(['volcano', 5, 10]);

      poolQueryMock.mockClear();
      expect((await day('date=2099-02-28&activity=fishing')).status).toBe(200);
      expect(poolQueryMock.mock.calls[0][1]).toEqual(['2099-02-28', 'fishing']);
      poolQueryMock.mockClear();
      expect((await month('month=2099-02')).status).toBe(200);
      expect(poolQueryMock.mock.calls[0][1]).toEqual(['2099-02-01', '2099-02-28']);
    });
  });

  it('подсказки поиска: автодополнение, рекомендованные, тренды, теги, похожие', async () => {
    const { searchService } = await import('@/lib/services/search.service');
    poolQueryMock.mockResolvedValue(empty);
    await searchService.autocomplete('вулкан', 5);
    await searchService.getRecommended(5);
    await searchService.getTrending(5);
    await searchService.getPopularTags(5);
    expect(sentPool()).toHaveLength(4);
    expectGated(sentPool(), 'подсказки');
    // Похожие: исходный тур читается по id (его поля не уходят наружу),
    // кандидаты — только с витрины.
    poolQueryMock.mockReset();
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ id: '1', category: 'fishing', difficulty: 'easy' }], rowCount: 1 })
      .mockResolvedValueOnce(empty);
    await searchService.getSimilar('1', 5);
    expectGated(sentPool().slice(1), 'похожие');
  });

  it('фид Meta и подбор туров в предложение по лиду', async () => {
    poolQueryMock.mockResolvedValue(empty);
    const meta = await import('@/app/api/meta/catalog/route');
    expect((await meta.GET()).status).toBe(200);
    expectGated(sentPool(), 'фид Meta');

    poolQueryMock.mockReset();
    poolQueryMock.mockResolvedValue(empty);
    const { leadProcessor } = await import('@/lib/services/operators/lead-processor.service');
    const match = (leadProcessor as unknown as {
      matchTours: (i: unknown, r: string | null, op: string | null) => Promise<unknown[]>;
    }).matchTours.bind(leadProcessor);
    await match({ activity_types: ['fishing'], interests: [], budget_rub: null, duration_days: null }, null, null);
    expectGated(sentPool(), 'matchTours');
  });

  it('календарь, плашка «ближайший выезд», лента главной, подборка по ссылке', async () => {
    const { NextRequest } = await import('next/server');
    poolQueryMock.mockResolvedValue(empty);
    const month = await import('@/app/api/availability/route');
    await month.GET(new NextRequest('http://localhost/api/availability?month=2099-07'));
    const day = await import('@/app/api/availability/day/route');
    await day.GET(new NextRequest('http://localhost/api/availability/day?date=2099-07-01'));
    expectGated(sentPool(), 'календарь');

    poolQueryMock.mockReset();
    poolQueryMock.mockResolvedValue(empty);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('сеть в тесте не нужна'));
    try {
      const now = await import('@/app/api/public/now/route');
      await now.GET();
    } finally {
      fetchSpy.mockRestore();
    }
    const live = await import('@/app/api/live-feed/route');
    await live.GET();
    expectGated(sentPool(), 'ближайший выезд и лента');

    poolQueryMock.mockReset();
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ id: 's1', title: null, client_name: null, operator_name: null, expires_at: null }], rowCount: 1 })
      .mockResolvedValueOnce(empty);
    const sel = await import('@/app/api/p/[code]/route');
    const res = await sel.GET(new NextRequest('http://localhost/api/p/abc'), { params: Promise.resolve({ code: 'abc' }) });
    expect(res.status).toBe(200);
    expectGated(sentPool(), 'подборка по ссылке');
  });

  it('напоминание в Telegram и пост в канал', async () => {
    poolQueryMock.mockResolvedValue(empty);
    const { sendEngagementPushes } = await import('@/lib/kuzmich/engagement');
    await sendEngagementPushes();
    expectGated(sentPool(), 'напоминание');

    const prev = process.env.TELEGRAM_CHANNEL_ID;
    process.env.TELEGRAM_CHANNEL_ID = '-100';
    try {
      queryMock.mockResolvedValue(empty);
      const { postTourToChannel } = await import('@/lib/notifications/tour-channel-post');
      const r = await postTourToChannel('1');
      expect(r.ok).toBe(false);
      expectGated(sentQuery(), 'пост в канал');
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_CHANNEL_ID; else process.env.TELEGRAM_CHANNEL_ID = prev;
    }
  });

  it('OCTO: поставщики, продукты, даты и холд под FOR UPDATE', async () => {
    poolQueryMock.mockResolvedValue(empty);
    const octo = await import('@/lib/octo/service');
    await octo.getSuppliers();
    await octo.getProducts();
    await octo.getProductById('1');
    await octo.checkAvailability('1', 'o1', '2099-07-01', '2099-07-02');
    // Даты из календаря читаются по продукту, который реселлер получил из
    // getProducts (шлюз там); запасной путь FREESALE читает тур сам — со шлюзом.
    expectGated(sentPool().filter((s) => !/FROM tour_availability ta/.test(s)), 'OCTO чтение');

    clientQueryMock.mockResolvedValue(empty);
    const r = await octo.createBooking({
      tourId: '1', optionId: 'o1', availabilityId: 'a1', bookingDate: '2099-07-01',
      adultCount: 1, childCount: 0, apiKeyId: 'k1',
    });
    expect(r).toEqual({ error: 'PRODUCT_NOT_FOUND' });
    const held = clientQueryMock.mock.calls.map((c) => String(c[0])).filter((s) => /FOR UPDATE/.test(s));
    expect(held).toHaveLength(1);
    expectGated(held, 'холд OCTO');
  });

  it('счёт на главной и планер: операторы и туры дня', async () => {
    const { NextRequest } = await import('next/server');
    queryMock.mockResolvedValue({ rows: [{}], rowCount: 1 });
    const metrics = await import('@/app/api/home/metrics/route');
    await metrics.GET();
    expectGated(sentQuery(), 'счёт главной');

    poolQueryMock.mockResolvedValue(empty);
    const partners = await import('@/app/api/planner/partners/route');
    await partners.GET(new NextRequest('http://localhost/api/planner/partners?activity_type=fishing'));
    const forDay = await import('@/app/api/planner/tours-for-day/route');
    await forDay.GET(new NextRequest('http://localhost/api/planner/tours-for-day?activity_type=fishing&zone=western&limit=3'));
    expect(sentPool().length).toBeGreaterThanOrEqual(3);
    expectGated(sentPool(), 'планер');
  });
});
