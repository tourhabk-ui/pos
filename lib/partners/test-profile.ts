/**
 * Тестовый профиль партнёра не выходит на витрину.
 *
 * Отметку ставит только администратор (`PATCH /api/admin/operators/[id]/test-profile`).
 * Пока она стоит, компания и её туры не попадают в каталог, список операторов,
 * поиск, страницу компании, sitemap, ответы планировщика, Telegram-список,
 * MCP и прочие публичные API. Кабинет партнёра и очередь администратора
 * отметку не прячут: иначе тестовый профиль нельзя было бы ни найти, ни снять.
 *
 * NULL колонки (строка до миграции) — не тест: `IS NOT TRUE`.
 */

export function notTestPartnerSql(alias = ''): string {
  if (alias !== '' && !/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`notTestPartnerSql: недопустимый псевдоним «${alias}»`);
  }
  const p = alias ? `${alias}.` : '';
  return `${p}is_test IS NOT TRUE`;
}

/**
 * Тур не принадлежит тестовому партнёру. Алиас — `operator_tours` в запросе,
 * пустая строка — колонка без префикса. Внутреннее имя `partners_test_gate`
 * не берётся из запроса.
 */
export function excludeTestPartnerTourSql(alias: string): string {
  if (alias !== '' && !/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`excludeTestPartnerTourSql: недопустимый псевдоним «${alias}»`);
  }
  const col = alias ? `${alias}.operator_id` : 'operator_id';
  return `NOT EXISTS (SELECT 1 FROM partners partners_test_gate WHERE partners_test_gate.id = ${col} AND partners_test_gate.is_test IS TRUE)`;
}
