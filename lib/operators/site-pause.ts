/**
 * Операторы на паузе витринных блоков — слово владельца 21.11.2026
 * (комментарий к #3487): «Местечко» на паузе, а его туры всё ещё
 * опубликованы. Шлюз витрины `publicTourSql` смотрит только флаги тура
 * (`is_active`, `is_published`, `deleted_at`), не статус партнёра и не
 * паузу. Поэтому туры «Местечка» попадали в блоки на страницах мест
 * (/places/…) и на посадочных (в том числе /dolina-gejzerov-ekskursiya).
 *
 * Что значит «прячем» здесь. Тур оператора из списка не показывается в
 * этих двух блоках и не входит в число «туров к месту» на плитке каталога
 * (тот же отбор, что блок на карточке места). Карточка тура по прямой
 * ссылке открывается: заявку оставляют там. Каталог /catalog и ответы
 * агента этот список сам по себе не закрывает — такое расширение нужно
 * отдельным словом.
 *
 * Вместе со списком из блоков уходят партнёры со статусом `suspended` и
 * `rejected`: это явный отказ, не «ещё не активен». `pending` и `active`
 * список не подменяет — у части живых операторов статус мог остаться
 * умолчанием вставки.
 *
 * Снять паузу — убрать slug видимым коммитом. Срок возврата владелец не
 * назвал: пауза не кончается сама. Сторож: tests/unit/operator-site-pause.test.ts.
 */

const SLUG_RE = /^[a-z0-9-]+$/;
const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;

export const OPERATOR_SITE_PAUSE_SLUGS: readonly string[] = ['mestechko'];

/** Спрятан ли этот оператор из блоков туров мест и посадочных — по slug. */
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
 * SQL-условие «оператора этого тура можно показать в блоке мест / посадочной».
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
