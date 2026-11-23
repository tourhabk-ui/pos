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
 * назвал: пауза не кончается сама. Сторожа: tests/unit/operator-site-pause.test.ts,
 * сцена «пауза оператора» в tests/integration/public-tour-gate.pg.test.ts.
 */

const SLUG_RE = /^[a-z0-9-]+$/;
const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;

export const OPERATOR_SITE_PAUSE_SLUGS: readonly string[] = ['mestechko'];

/** На паузе ли этот оператор — по slug. */
export function operatorPausedOnTourBlocks(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && OPERATOR_SITE_PAUSE_SLUGS.includes(slug);
}

function pausedSlugsSql(): string {
  for (const slug of OPERATOR_SITE_PAUSE_SLUGS) {
    if (!SLUG_RE.test(slug)) {
      throw new Error(`operatorShownInTourBlocksSql: недопустимый slug «${slug}»`);
    }
  }
  return OPERATOR_SITE_PAUSE_SLUGS.map((s) => `'${s}'`).join(', ');
}

/**
 * SQL-условие «партнёра можно показать на общей витрине»: не на паузе и не
 * отклонён. Имя осталось от 21.11, когда условие закрывало только блоки мест
 * и посадочных.
 * Алиас — имя таблицы `partners` в запросе; пустая строка — без префикса.
 * Алиас задаёт код, не пользователь, и всё же проверяется.
 */
export function operatorShownInTourBlocksSql(alias = 'p'): string {
  if (alias !== '' && !ALIAS_RE.test(alias)) {
    throw new Error(`operatorShownInTourBlocksSql: недопустимый алиас «${alias}»`);
  }
  const p = alias ? `${alias}.` : '';
  const status = `(${p}status IS NULL OR ${p}status NOT IN ('suspended', 'rejected'))`;
  const slugs = pausedSlugsSql();
  if (!slugs) return status;
  return `${status} AND (${p}slug IS NULL OR ${p}slug <> ALL(ARRAY[${slugs}]::text[]))`;
}

/**
 * SQL-условие «партнёр с этим id снят с витрины» (пауза, `suspended`,
 * `rejected`). Для шлюза витрины туров: у тура в запросе есть только id
 * партнёра. `column` — имя колонки, проверяется: в текст запроса попадает
 * только имя.
 */
export function partnerOffStorefrontIdSql(column: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column)) {
    throw new Error(`partnerOffStorefrontIdSql: недопустимая колонка «${column}»`);
  }
  return `EXISTS (SELECT 1 FROM partners AS off_gate WHERE off_gate.id = ${column} AND NOT (${operatorShownInTourBlocksSql('off_gate')}))`;
}
