/**
 * Сторож переписи материала планировщика.
 *
 * Перепись заведена 20.09 под вопрос, на который нельзя отвечать
 * правдоподобием: ослаблять ли у отборов точное совпадение `activity_type`.
 * Ослабишь — и в вулканический день ляжет рыболовный тур, а обещание «вот
 * ваш день на вулкане» с чужим содержимым хуже пустого дня. Значит сперва
 * числа по каждой паре «зона × активность».
 *
 * Сторож держит ровно то, чем такая перепись может соврать:
 *   — начать чинить вместо того, чтобы считать;
 *   — считать своими предикатами, а не теми, какими ищет движок;
 *   — свести таблицу из половины данных, когда вторая не прочиталась;
 *   — назвать «ноль» там, где запрос упал.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/api/cron/planner-material-census/route.ts'), 'utf8');
const DATA = readFileSync(join(ROOT, 'lib/planner/data.ts'), 'utf8');
const ENGINE = readFileSync(join(ROOT, 'lib/planner/engine.ts'), 'utf8');

describe('перепись только считает', () => {
  it('ни одной записи ни при каком аргументе', () => {
    // Из «пара пуста» не следует, ЧТО с этим делать: завести тур, связать
    // маршрут с зоной или снять активность. Выбор за человеком.
    //
    // Судим по SQL, а не по всему файлу: в шапке эти слова стоят намеренно,
    // как описание того, чего роут не делает. Первая редакция ловила
    // собственный комментарий — та же ошибка, что днём раньше со сторожем
    // заголовка дня.
    const sql = [...ROUTE.matchAll(/`([^`]*(?:SELECT|FROM)[^`]*)`/g)].map((m) => m[1]).join('\n');
    expect(sql.length, 'SQL в роуте не нашёлся — сломался разбор').toBeGreaterThan(100);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it('роут только читает: ни POST, ни другого метода', () => {
    expect(ROUTE).toMatch(/export async function GET/);
    expect(ROUTE).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it('закрыт CRON_SECRET, как остальные переписи', () => {
    expect(ROUTE).toContain('timingSafeCompare');
    expect(ROUTE).toContain('getCronSecret');
  });
});

describe('считает тем же, чем ищет движок', () => {
  it('зоны и активности берутся из движка, а не переписаны в роуте', () => {
    // Свой список разошёлся бы с тем, по которому движок действительно
    // ищет, и перепись отвечала бы про несуществующую платформу.
    expect(ROUTE).toMatch(/import \{ ACTIVITY_CONSTRAINTS, ZONE_NAMES[^}]*\} from '@\/lib\/planner\/constants'/);
    expect(ROUTE).not.toMatch(/const ZONES\s*=\s*\[/);
    // Именно constants, а не engine: движок умеет писать в базу и звать
    // модели, и импорт из него давал переписи эти умения в реестре
    // возможностей — «только читаю» становилось неправдой.
    expect(ROUTE).not.toMatch(/from '@\/lib\/planner\/engine'/);
  });

  it('предикаты туров совпадают с fetchRealToursForZone', () => {
    // Перепись, считающая по СВОИМ условиям, отвечает на другой вопрос.
    //
    // Судим по SQL, а не по файлу целиком: те же слова стоят в строке
    // `definitions`, и первая редакция зеленела на ОПИСАНИИ при потерянном
    // предикате — то самое «описание живёт дольше кода» (§10.09), от
    // которого сторож и должен защищать.
    const toursSql = ROUTE.slice(
      ROUTE.indexOf('FROM operator_tours'),
      ROUTE.indexOf('GROUP BY 1, 2'),
    );
    expect(toursSql.length, 'SQL туров не нашёлся — сломался разбор').toBeGreaterThan(100);

    for (const predicate of ['is_active', 'is_published', 'deleted_at IS NULL', 'p.is_public']) {
      expect(toursSql, `в SQL переписи нет ${predicate}`).toContain(predicate);
      expect(DATA, `в движке нет ${predicate}`).toContain(predicate);
    }
  });

  it('предикаты маршрутов совпадают с fetchRoutesForZone', () => {
    const routesBlock = ROUTE.slice(ROUTE.indexOf('FROM agent_route_knowledge'));
    expect(routesBlock).toContain('is_visible = TRUE');
    expect(routesBlock).toContain('lat IS NOT NULL');
    expect(ENGINE).toContain('is_visible = TRUE');
  });

  it('определения отданы в ответе, а не оставлены читателю', () => {
    // Число без определения читают как удобнее — так и появились «778 мест»
    // и «20 туров» (§4.1).
    expect(ROUTE).toContain('definitions');
    expect(ROUTE).toMatch(/tours:\s*\n?\s*'operator_tours/);
  });
});

describe('третье состояние: ноль не подменяет отказ', () => {
  it('таблица не сводится из половины данных', () => {
    // Одна сторона не прочиталась — пары нельзя называть пустыми: мы на них
    // не посмотрели.
    expect(ROUTE).toMatch(/const measurable = tourCounts !== null && routeCounts !== null/);
    expect(ROUTE).toMatch(/cells: measurable \? cells : null/);
    expect(ROUTE).toMatch(/empty_pairs: measurable \? emptyPairs : null/);
  });

  it('отказ запроса попадает и в лог, и в ответ', () => {
    expect(ROUTE).toContain('[planner-material-census] туры не посчитаны');
    expect(ROUTE).toContain('[planner-material-census] маршруты не посчитаны');
    expect(ROUTE).toMatch(/errors\.push\(`tours:/);
    expect(ROUTE).toMatch(/errors\.push\(`routes:/);
  });

  it('знаменатель отдаётся рядом с пустыми парами', () => {
    // «Пустых 40» без «из скольки» — число, по которому нельзя судить.
    expect(ROUTE).toContain('pairs_total');
  });
});

describe('жильё: видно ли заведённое', () => {
  it('считается БЕЗ фильтра живости', () => {
    // Весь смысл — увидеть строку, которую не видит ни один продуктовый
    // инструмент: и поиск, и страница, и MCP фильтруют is_active = true.
    // Добавить сюда тот же фильтр значило бы построить четвёртый слепой
    // инструмент.
    const staysSql = ROUTE.slice(ROUTE.indexOf('FROM accommodations'), ROUTE.indexOf('GROUP BY 1`'));
    expect(staysSql.length, 'SQL жилья не нашёлся').toBeGreaterThan(10);
    expect(staysSql).not.toMatch(/WHERE[\s\S]*is_active/);
  });

  it('заведённое и видимое — разные числа, и разница названа', () => {
    // «Видимое» — то же условие, что у витрины: is_active И одобрение
    // администратора (миграция 1027, lib/stay/moderation).
    expect(ROUTE).toMatch(/COUNT\(\*\) FILTER \(WHERE \$\{publicAccommodationSql\(''\)\}\)/);
    expect(ROUTE).toMatch(/hidden: total - active/);
  });

  it('зона отдаётся как записана, без перевода', () => {
    // Расхождение между словом владельца («13 км») и ключом движка
    // (`avachinsky`) — это и есть то, что надо увидеть; перевод его скрыл бы.
    expect(ROUTE).toContain('location_zone AS zone');
    expect(ROUTE).toContain("r.zone ?? 'зона не записана'");
  });

  it('отказ запроса не выдаётся за «жилья нет»', () => {
    expect(ROUTE).toContain('[planner-material-census] жильё не посчитано');
    expect(ROUTE).toMatch(/errors\.push\(`stays:/);
    // null, а не нули: ноль значит «посчитали, пусто».
    expect(ROUTE).toMatch(/let stays: PlannerMaterialCensus\['stays'\] = null/);
  });
});

describe('род запуска объявлен', () => {
  it('перепись числится ручной, а не молчит', () => {
    // Роут без workflow и без объявления — красный (§8). Молчание не ответ.
    const declared = MANUAL_ENDPOINTS['planner-material-census'];
    expect(declared, 'нет объявления в cron-schedulers').toBeTruthy();
    expect(declared.kind).toBe('manual');
    expect(declared.writes, 'перепись объявлена пишущей').toBe(false);
  });
});
