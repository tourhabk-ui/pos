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
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const queryMock = vi.fn();
const poolQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { publicTourSql } from '@/lib/tours/public-visibility';
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
 * внутренний агент — им снятый тур виден по делу), витрина с ВСЕМИ тремя
 * флагами руками (совпадает со шлюзом, пока его не поправят), или витрина с
 * НЕПОЛНОЙ копией — настоящий пробел, оставленный вне пункта 1.10 дорожной
 * карты и названный словами.
 */
const NOT_SHOWCASE = 'не витрина';
const FULL_COPY = 'витрина, все три флага руками: сегодня совпадает со шлюзом, разойдётся при первой его правке';
const PARTIAL = 'витрина, НЕПОЛНАЯ копия';
const KNOWN_HAND_COPIES: Record<string, { n: number; why: string }> = {
  'app/api/admin/ai-assistant/route.ts': { n: 1, why: `${NOT_SHOWCASE}: счёт активных туров в контекст ассистента админки` },
  'app/api/admin/content/tours/route.ts': { n: 1, why: `${NOT_SHOWCASE}: фильтр админки по статусу — видит все состояния намеренно` },
  'app/api/admin/stats/route.ts': { n: 1, why: `${NOT_SHOWCASE}: сводка админки «активных туров»` },
  'app/api/admin/tours/route.ts': { n: 1, why: `${NOT_SHOWCASE}: фильтр админки по статусу — видит все состояния намеренно` },
  'app/api/agent/find-tours/route.ts': { n: 2, why: `${FULL_COPY} (подбор для турагента)` },
  'app/api/agent/tours/route.ts': { n: 2, why: `${FULL_COPY} (список для турагента)` },
  'app/api/ai/knowledge-base/route.ts': { n: 1, why: `${PARTIAL}: нет is_published — снятый тур уходит в базу знаний ИИ` },
  'app/api/availability/day/route.ts': { n: 2, why: `${PARTIAL}: нет deleted_at тура — даты удалённого тура в публичном ответе` },
  'app/api/availability/route.ts': { n: 2, why: `${PARTIAL}: нет deleted_at тура — даты удалённого тура в публичном ответе` },
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
  'app/api/discovery/search/route.ts': { n: 1, why: `${PARTIAL}: фильтр по AI-тегам без is_published — снятый тур находится поиском` },
  'app/api/home/metrics/route.ts': { n: 2, why: `${FULL_COPY} (цифры главной)` },
  'app/api/hub/operator/pricing-rules/route.ts': { n: 1, why: `${NOT_SHOWCASE}: кабинет оператора, свои туры` },
  'app/api/meta/catalog/route.ts': { n: 1, why: `${PARTIAL}: фид Meta без is_published — снятый тур уходит на чужую витрину` },
  'app/api/operator/calendar/bulk-open/route.ts': { n: 1, why: `${NOT_SHOWCASE}: кабинет оператора, проверка владения своим туром` },
  'app/api/planner/partners/route.ts': { n: 2, why: `${FULL_COPY} (партнёры планера)` },
  'app/api/planner/tours-for-day/route.ts': { n: 4, why: `${FULL_COPY} (туры на день планера)` },
  'app/api/public/now/route.ts': { n: 1, why: `${PARTIAL}: «ближайший выезд» без is_published — снятый тур на публичной плашке` },
  'app/api/routes/analysis/route.ts': { n: 1, why: `${NOT_SHOWCASE}: аналитика маршрутов, счёт активных среди всех туров места` },
  'app/api/telegram/admin/route.ts': { n: 1, why: `${NOT_SHOWCASE}: статистика админ-бота` },
  'app/api/telegram/webhook/route.ts': { n: 1, why: `${NOT_SHOWCASE}: команда статистики для админа в боте` },
  'app/api/trip/plan/route.ts': { n: 1, why: `${PARTIAL}: нет is_published; роут не зовёт ни одна поверхность, а запрос читает колонки, которых у тура нет (coordinates, season, reviews_count)` },
  'app/fish/[id]/page.tsx': { n: 2, why: `${FULL_COPY} (туры на странице вида рыбы)` },
  'app/hub/admin/channels/page.tsx': { n: 2, why: `${FULL_COPY} (счёт готовых к выкладке в админке каналов)` },
  'app/hub/fishing/page.tsx': { n: 2, why: `${FULL_COPY} (витрина рыбалки)` },
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
  'lib/kuzmich/engagement.ts': { n: 1, why: `${PARTIAL}: напоминание о туре без is_active и deleted_at — выключенный или удалённый тур уходит в личку` },
  'lib/leads/create.ts': { n: 1, why: `${NOT_SHOWCASE}: атрибуция лида оператору, тур не показывается` },
  'lib/notifications/telegram-channel.ts': { n: 2, why: `${FULL_COPY} (пост в канал)` },
  'lib/notifications/tour-channel-post.ts': { n: 1, why: `${PARTIAL}: пост тура по id без is_published — снятый тур публикуется в канал` },
  'lib/octo/service.ts': { n: 5, why: `${PARTIAL}: OCTO для площадок без is_active — выключенный тур продаётся каналом` },
  'lib/places/place-detail.ts': { n: 2, why: `${PARTIAL}: «Туры сюда» на карточке места без deleted_at — удалённый тур в списке` },
  'lib/safety/safety-selfcheck.ts': { n: 1, why: `${NOT_SHOWCASE}: самопроверка «есть покупаемый тур», диагностика` },
  'lib/seat-requests/service.ts': { n: 2, why: `${FULL_COPY} (запрос мест из планера)` },
  'lib/services/analytics.service.ts': { n: 1, why: `${NOT_SHOWCASE}: аналитика, счёт` },
  'lib/services/operators/lead-processor.service.ts': { n: 1, why: `${PARTIAL}: подбор туров в предложение по лиду без is_published` },
  'lib/services/routes/route-description-cache.ts': { n: 1, why: `${NOT_SHOWCASE}: писатель кэша описаний` },
  'lib/services/search.service.ts': { n: 5, why: `${PARTIAL}: поиск и автодополнение без is_published` },
  'lib/services/tours/booking-funnel-stages.ts': { n: 2, why: `${NOT_SHOWCASE}: диагностика воронки, счёт предложения` },
  'lib/services/tours/tour.service.ts': { n: 1, why: `${PARTIAL}: поиск сервиса туров без is_published` },
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
