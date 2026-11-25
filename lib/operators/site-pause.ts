/**
 * Операторы на паузе витрины — слово владельца 21.11.2026 (комментарий к
 * #3487): «Местечко» на паузе, а его туры всё ещё опубликованы.
 *
 * ── Где действует ─────────────────────────────────────────────────────────
 *
 * 21.11 пауза закрыла только блоки туров на страницах мест и посадочных и
 * снимки оператора. Каталог, список компаний /operators, главная, планер,
 * Кузьмич и ответы агентам (MCP get_tours, get_tour_details) её не знали:
 * шлюз витрины `publicTourSql` смотрел флаги тура и отметку тестового
 * профиля, но не паузу. На проде 23.11 «Местечко» стояло в /operators с
 * шестнадцатью турами и отдавалось агентам. Андрей 23.11: «Разберись с
 * Местечком».
 *
 * С 23.11 пауза — часть шлюза витрины: тур оператора на паузе не выходит ни
 * на одну общую витрину (все читатели `publicTourSql`), а сама компания — в
 * список /operators (`listedPartner`). Одно правило на все витрины (CLAUDE.md
 * §0), а не копия по читателям: копию однажды забывают в одном, как здесь.
 *
 * Открытым остаётся то, что открывают по прямой ссылке, — карточка тура и её
 * даты, цена, бронь и вопрос оператору, страница компании, её сайт, виджет и
 * подборка по ссылке (`tourOpenByLinkSql`, lib/tours/public-visibility):
 * человек, у которого уже есть ссылка, может оставить заявку. Ведар эти
 * адреса сам никому не предлагает.
 *
 * Вместе со списком с витрины уходят партнёры со статусом `suspended` и
 * `rejected`: это явный отказ, не «ещё не активен». `pending` и `active`
 * список не подменяет — у части живых операторов статус мог остаться
 * умолчанием вставки.
 *
 * Снять паузу — убрать slug видимым коммитом. Срок возврата владелец не
 * назвал: пауза не кончается сама.
 *
 * 25.11 пауза с «Местечка» снята — слово владельца «Сними паузу» («это наш
 * давний друг»). Причины паузы 21.11 не записано нигде: ни жалобы, ни
 * юридического повода, ни просьбы оператора, ни отказа в согласии на снимки.
 * Список пуст; механизм остался. Отклонённые и приостановленные партнёры
 * уходят с витрины по-прежнему. Вернётся пауза — slug сюда, видимым коммитом.
 *
 * Сторожа: tests/unit/operator-site-pause.test.ts (правило — на списке,
 * переданном тестом), сцена «пауза оператора» в
 * tests/integration/public-tour-gate.pg.test.ts.
 */

const SLUG_RE = /^[a-z0-9-]+$/;
const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;

export const OPERATOR_SITE_PAUSE_SLUGS: readonly string[] = [];

/**
 * На паузе ли этот оператор — по slug. `paused` — список паузы; по умолчанию
 * действующий. Другой список передают только тесты правила.
 */
export function operatorPausedOnTourBlocks(
  slug: string | null | undefined,
  paused: readonly string[] = OPERATOR_SITE_PAUSE_SLUGS,
): boolean {
  return typeof slug === 'string' && paused.includes(slug);
}

function pausedSlugsSql(paused: readonly string[]): string {
  for (const slug of paused) {
    if (!SLUG_RE.test(slug)) {
      throw new Error(`operatorShownInTourBlocksSql: недопустимый slug «${slug}»`);
    }
  }
  return paused.map((s) => `'${s}'`).join(', ');
}

/**
 * SQL-условие «партнёра можно показать на общей витрине»: не на паузе и не
 * отклонён. Имя осталось от 21.11, когда условие закрывало только блоки мест
 * и посадочных.
 * Алиас — имя таблицы `partners` в запросе; пустая строка — без префикса.
 * Алиас задаёт код, не пользователь, и всё же проверяется. `paused` — список
 * паузы; по умолчанию действующий, другой передают только тесты правила.
 */
export function operatorShownInTourBlocksSql(
  alias = 'p',
  paused: readonly string[] = OPERATOR_SITE_PAUSE_SLUGS,
): string {
  if (alias !== '' && !ALIAS_RE.test(alias)) {
    throw new Error(`operatorShownInTourBlocksSql: недопустимый алиас «${alias}»`);
  }
  const p = alias ? `${alias}.` : '';
  const status = `(${p}status IS NULL OR ${p}status NOT IN ('suspended', 'rejected'))`;
  const slugs = pausedSlugsSql(paused);
  if (!slugs) return status;
  return `${status} AND (${p}slug IS NULL OR ${p}slug <> ALL(ARRAY[${slugs}]::text[]))`;
}

/**
 * SQL-условие «партнёр с этим id снят с витрины» (пауза, `suspended`,
 * `rejected`). Для шлюза витрины туров: у тура в запросе есть только id
 * партнёра. `column` — имя колонки, проверяется: в текст запроса попадает
 * только имя. `paused` — как у `operatorShownInTourBlocksSql`.
 */
export function partnerOffStorefrontIdSql(
  column: string,
  paused: readonly string[] = OPERATOR_SITE_PAUSE_SLUGS,
): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column)) {
    throw new Error(`partnerOffStorefrontIdSql: недопустимая колонка «${column}»`);
  }
  return `EXISTS (SELECT 1 FROM partners AS off_gate WHERE off_gate.id = ${column} AND NOT (${operatorShownInTourBlocksSql('off_gate', paused)}))`;
}
