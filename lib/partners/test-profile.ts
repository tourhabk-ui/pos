/**
 * Тестовый профиль партнёра — не на витрине (миграция 1495; слово владельца
 * 24.10, подтверждено 22.11 «да», часть 2 закрытого PR #2770).
 *
 * Отметку ставит только администратор — `PATCH /api/admin/operators/[id]/test-profile`.
 * Держится двумя замками, и оба не зависят от памяти читателя:
 *
 *  - карточка: CHECK `partners_test_not_public` в базе — тестовый профиль не
 *    стоит на витрине (`is_public`). Карточки компаний читают около сорока
 *    мест, и все уже спрашивают `is_public`: страница компании, список
 *    `/operators`, sitemap, Telegram, планер, общий список заявок без адресата
 *    (§23), добивка лидов;
 *  - туры: шлюз витрины `publicTourSql` не пускает тур тестового партнёра
 *    (`testPartnerTourSql`) — каталог, поиск, план, Кузьмич и MCP зовут его.
 *
 * Кабинет партнёра и очередь администратора отметку не прячут: иначе
 * тестовый профиль нельзя было бы ни найти, ни снять.
 */

/** Имя CHECK в базе: тестовый профиль не стоит на витрине. */
export const TEST_PROFILE_CONSTRAINT = 'partners_test_not_public';

/** Отказ двери, которая ставит тестовый профиль на витрину. */
export const TEST_PROFILE_NOT_PUBLIC_TEXT =
  'Тестовый профиль на витрину не ставится. Сначала снимите отметку «тестовый профиль».';

/** Ответ двери отметки: что на деле стало с витриной. */
export const TEST_PROFILE_MARKED_TEXT = 'Отмечен тестовым: карточка и туры сняты с витрины.';
export const TEST_PROFILE_UNMARKED_TEXT =
  'Отметка снята. На витрину карточка сама не вернулась — поставьте её туда, когда профиль готов.';

function checkAlias(fn: string, alias: string): void {
  if (alias !== '' && !/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`${fn}: недопустимый алиас «${alias}»`);
  }
}

/**
 * SQL-условие «тур принадлежит тестовому партнёру». Алиас — `operator_tours`
 * в запросе; пустая строка — таблица без алиаса, и тогда колонка называется
 * полным именем таблицы: внутри подзапроса голое `operator_id` могло бы
 * встретить одноимённую колонку другой таблицы запроса.
 */
export function testPartnerTourSql(alias: string): string {
  checkAlias('testPartnerTourSql', alias);
  const col = alias ? `${alias}.operator_id` : 'operator_tours.operator_id';
  return `EXISTS (SELECT 1 FROM partners test_gate WHERE test_gate.id = ${col} AND test_gate.is_test IS TRUE)`;
}

/**
 * SQL-условие «карточка партнёра на витрине»: опубликована и не тестовая.
 * Алиас — `partners` в запросе; пустая строка — таблица без алиаса.
 *
 * ── Зачем, если есть CHECK ────────────────────────────────────────────────
 *
 * 23.11 на витрине нашлись три служебные карточки: «Тестовый оператор Ведар»,
 * «Тестовый гид Ведар» и «Admin» — в `/api/partners` и в реестре гидов. CHECK
 * их не остановил: отметки `is_test` у них не было (миграция 1495 ставила её
 * по почте, а у стенда почта другая). Данные поправила миграция 1505; это
 * условие — второй замок: читатель витрины спрашивает отметку сам и не
 * зависит от того, что CHECK в базе стоит и что его не сняли.
 *
 * Одно условие на всех читателей, а не `AND is_test IS NOT TRUE` руками в
 * каждом: копии расходятся. Сторож `tests/unit/public-partner-gate.test.ts`
 * не пускает в `app/` и `lib/` новое сравнение `is_public` у партнёра мимо
 * этого условия.
 *
 * Кабинет партнёра, админка и стенд запросов мест условие не зовут: им
 * тестовый профиль виден по делу.
 */
export function publicPartnerSql(alias: string): string {
  checkAlias('publicPartnerSql', alias);
  const p = alias ? `${alias}.` : '';
  return `(${p}is_public = TRUE AND ${p}is_test IS NOT TRUE)`;
}

/** Отказ базы — нарушение именно этого CHECK, а не любой другой. */
export function isTestProfileNotPublicViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23514' && e.constraint === TEST_PROFILE_CONSTRAINT;
}
