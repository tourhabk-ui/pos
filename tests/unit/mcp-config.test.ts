/**
 * Подключение к БД на чтение: секрет не в репозитории, доступ разрешительный.
 *
 * Заведено 04.09. До этого дня каждый факт о проде добывался так: написать
 * cron-эндпоинт, смержить, дождаться деплоя, прочитать логи прогона — от
 * двадцати минут до часа на один вопрос. Собственный хук проекта
 * (.claude/hooks/db-schema-check.sh) при этом уже спрашивал «Проверил колонки
 * через MCP postgres query?» — инструмента, которого не было.
 *
 * Сторож держит две границы, и обе про чужие персональные данные:
 *   1) пароль не попадает в репозиторий — psql подставляет его переменной;
 *   2) роль получает SELECT по СПИСКУ РАЗРЕШЁННЫХ таблиц, и таблицы с ПД в
 *      него не входят. Разрешительный список выбран не для строгости: в базе
 *      245 таблиц, ПД растекаются по ним через JOIN, и запретительный список
 *      защищает ровно до первой забытой таблицы.
 *
 * Клиентский конфиг (.mcp.json) в репозиторий НЕ кладётся: запрет записан
 * решением ревью и сторожится mcp-phone-dedup.test.ts — платформа сама отдаёт
 * манифест по /.well-known/mcp.json, и два похожих файла путали читателя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const ROLE_SQL = 'infra/mcp-postgres/role.sql';

/**
 * Судим КОД, а не прозу. В шапке role.sql нарочно объяснено, ПОЧЕМУ там нет
 * `ALTER DEFAULT PRIVILEGES ... GRANT SELECT` и почему пароль не пишется
 * литералом, — сторож, читающий комментарии, краснел бы на этом объяснении.
 * Тот же приём уже спас channel-fact-gate: «сторож, читающий комментарии,
 * краснел бы на памяти».
 */
const sqlCode = (src: string) => src.replace(/^\s*--.*$/gm, '');

describe('роль читает по разрешительному списку', () => {
  const sql = () => sqlCode(read(ROLE_SQL));

  it('скрипт лежит ВНЕ migrations: миграции накатываются сами, а тут пароль', () => {
    expect(existsSync(join(ROOT, ROLE_SQL))).toBe(true);
    expect(existsSync(join(ROOT, 'migrations/role.sql'))).toBe(false);
    expect(sql()).toMatch(/mcp_password/);
    // Пароль подставляет psql переменной; литерала в файле нет. Проверяем
    // именно литерал: у нас PASSWORD склеивается через quote_literal, и
    // наивная регулярка ловила бы собственную безопасную склейку.
    expect(sql()).not.toMatch(/PASSWORD\s+'[^'|]+'\s*(?:;|$)/im);
  });

  it('начинает с пустых рук и не открывает будущие таблицы', () => {
    const s = sql();
    expect(s).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_readonly/);
    expect(s).toMatch(/REVOKE CREATE ON SCHEMA public FROM mcp_readonly/);
    // ALTER DEFAULT PRIVILEGES ... GRANT открыл бы всё, что заведут завтра.
    expect(s, 'умолчания снова открывают роли новые таблицы')
      .not.toMatch(/ALTER DEFAULT PRIVILEGES[\s\S]{0,120}GRANT SELECT/);
  });

  it('таблиц с персональными данными в списке нет', () => {
    // Список разрешённых — единственный источник доступа; проверяем ЕГО, а не
    // весь файл: имена запрещённых таблиц в комментариях стоят намеренно.
    const list = /allowed text\[\] := ARRAY\[([\s\S]*?)\];/.exec(sql())?.[1] ?? '';
    expect(list, 'список разрешённых таблиц не найден').not.toBe('');
    const tables = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(5);
    for (const forbidden of ['users', 'partners', 'operator_bookings', 'leads', 'tour_payments', 'payouts', 'tourist_documents']) {
      expect(tables, `${forbidden} несёт персональные данные и не может быть в списке`).not.toContain(forbidden);
    }
    // И то, ради чего всё затевалось, — на месте.
    for (const needed of ['places', 'kamchatka_routes', 'operator_tours', 'evo_growth_issues']) {
      expect(tables).toContain(needed);
    }
  });

  it('выдаётся только чтение', () => {
    const s = sql();
    expect(s).toMatch(/GRANT SELECT ON public\.%I TO mcp_readonly/);
    expect(s, 'роли выдали право записи').not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)\s+ON/i);
  });

  it('отсутствующая таблица называется вслух, а не молча пропускается', () => {
    expect(sql()).toMatch(/RAISE NOTICE 'таблицы % нет в базе/);
  });
});
