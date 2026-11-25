/**
 * Шлюз витрины туров: какой тур оператора вправе увидеть турист.
 *
 * ── Почему одной строкой, а не копией в каждом читателе ───────────────────
 *
 * Снятие тура с витрины делается ИМЕННО флагом `is_published` (миграции
 * 807/808/837: демо-туры, чужие партнёры, несезонные окна); `is_active` при
 * этом часто остаётся true. Каноническое чтение карточки
 * (`lib/tours/tour-detail-query.ts`) это условие держало, а публичные роуты
 * `/api/tours`, `/api/tours/[id]` и `/api/tours/[id]/slots` — нет: список
 * фильтровал только `is_active`, карточка — `is_active` и `deleted_at`, а
 * даты отдавались по любому id вовсе без взгляда на тур. Проверено
 * исполнением: два тура «Сплав по реке Быстрая» (`is_active = true`,
 * `is_published = false`) выезжали в ответ `GET /api/tours` наравне с живым.
 *
 * Разных правил тут быть не может: черновик оператора — это черновик на всех
 * трёх адресах. Поэтому условие живёт здесь, а читатели его зовут. Так же
 * устроен шлюз витрины жилья и проката (`lib/moderation/gate.ts`) — и по той
 * же причине: условие, размноженное по читателям, однажды забудут в одном.
 *
 * Сторож: `tests/unit/public-tour-gate.test.ts` — там же реестр отборов для
 * туриста и чужих площадок (`TOURIST_SELECTIONS`) и перепись поверхностей,
 * открытых без входа: читатель тура без шлюза и без записи краснеет (ревью
 * #2642 — подпись кабинета «туристы не видят» правдива, только пока шлюз
 * спрашивает каждый такой отбор). Черновик на настоящей базе —
 * `tests/integration/public-tour-gate.pg.test.ts`.
 */

import { testPartnerTourSql } from '@/lib/partners/test-profile';
import { partnerOffStorefrontIdSql } from '@/lib/operators/site-pause';

function checkTourAlias(fn: string, alias: string): void {
  if (alias !== '' && !/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`${fn}: недопустимый алиас «${alias}»`);
  }
}

/** Флаги тура и отметка тестового профиля — общее у витрины и прямой ссылки. */
function tourFlagsSql(alias: string): string {
  const p = alias ? `${alias}.` : '';
  // Тур тестового партнёра на витрину не выходит (миграция 1495, #2770).
  return `${p}is_active = true AND ${p}is_published = true AND ${p}deleted_at IS NULL AND NOT ${testPartnerTourSql(alias)}`;
}

/**
 * SQL-условие «тур на витрине». Алиас — имя таблицы `operator_tours` в
 * запросе; пустая строка — без префикса. Алиас задаёт код, не пользователь,
 * и всё же проверяется: подстановка в SQL без проверки — привычка, которая
 * однажды встретит строку из запроса.
 */
export function publicTourSql(alias = 'ot'): string {
  checkTourAlias('publicTourSql', alias);
  // Тур оператора на паузе или отклонённого — тоже не на витрине (23.11,
  // «Разберись с Местечком», lib/operators/site-pause): каталог, поиск, план,
  // главная, Кузьмич и MCP зовут этот шлюз.
  const operatorColumn = alias ? `${alias}.operator_id` : 'operator_tours.operator_id';
  return `(${tourFlagsSql(alias)} AND NOT ${partnerOffStorefrontIdSql(operatorColumn)})`;
}

/**
 * SQL-условие «тур открывается по прямой ссылке»: то же, что витрина, без
 * паузы оператора. Для читателей, которые показывают ОДИН тур или одну
 * компанию по адресу, уже бывшему у человека в руках: карточка тура, её даты,
 * цена и вопрос оператору, страница компании, её сайт, виджет, подборка по
 * ссылке. Тур на паузе Ведар не предлагает, но заявку по старой ссылке
 * оставить можно (решение 21.11, lib/operators/site-pause). Черновик,
 * удалённый тур и тестовый профиль закрыты и здесь.
 *
 * Отбор, где турист выбирает из нескольких туров или компаний, зовёт
 * `publicTourSql`, а не это условие.
 */
export function tourOpenByLinkSql(alias = 'ot'): string {
  checkTourAlias('tourOpenByLinkSql', alias);
  return `(${tourFlagsSql(alias)})`;
}

/**
 * Почему тур НЕ на витрине — SQL-предикаты тех же трёх флагов, что у шлюза
 * (#2881, 30.10). Нужны переписям («не видны туристу 12: черновики 7,
 * выключены 4, и то и другое 1»): у шлюза два флага тура и отметка партнёра
 * «тестовый профиль» (1495), других причин невидимости он не знает — тур без
 * цены, дат или линии маршрута турист ВИДИТ. Живут здесь, а не в переписи,
 * чтобы семантика флагов имела одного хозяина (сторож `public-tour-gate`
 * считает копии условия по `app/` и `lib/`).
 *
 *   draft       — включён, но не опубликован (черновик оператора; `storefrontState` → 'draft')
 *   inactive    — опубликован, но выключен оператором (→ 'hidden')
 *   testProfile — тур тестового партнёра (→ 'hidden' по ответу шлюза); у
 *                 переписи эта причина старше флагов
 *
 * Третьего предиката нет намеренно: «остальное невидимое» (выключен и не
 * опубликован, либо флаг не записан) перепись считает как «невидим и не
 * черновик и не выключен», и сумма трёх вёдер равна числу невидимых по
 * построению, а не по удаче.
 */
export function hiddenTourReasonSql(alias = 'ot'): { draft: string; inactive: string; testProfile: string } {
  checkTourAlias('hiddenTourReasonSql', alias);
  const p = alias ? `${alias}.` : '';
  return {
    draft: `(${p}is_active IS TRUE AND ${p}is_published IS FALSE)`,
    inactive: `(${p}is_active IS FALSE AND ${p}is_published IS TRUE)`,
    // Тур тестового партнёра (1495): шлюз прячет его при любых флагах.
    testProfile: testPartnerTourSql(alias),
  };
}

/**
 * Видит ли турист тур — словами для кабинета оператора (#2642).
 *
 * ── Повод ─────────────────────────────────────────────────────────────────
 *
 * Новый тур заводится с `is_published = false` (миграция 040, `createTour`),
 * и каталог его не показывает: отбор идёт шлюзом выше. А список туров в
 * кабинете ставил бейдж по одному `is_active` — черновик выглядел «Активен»,
 * и оператор ждал броней от тура, которого туристы не видят. Экран «Чего не
 * хватает» судил по одному `is_published` и промахивался с другой стороны —
 * у выключенного тура.
 *
 * Исходов три, а не два, потому что лекарства разные: черновик публикуют
 * отметкой «Опубликован» в редакторе, скрытый — включают («Активен» или глаз
 * в списке туров). Подписи — одни на оба экрана (`STOREFRONT_LABELS`).
 *
 * ── Связь со шлюзом ───────────────────────────────────────────────────────
 *
 * «На витрине» здесь — те же три флага, что в `publicTourSql`; NULL флага —
 * не «да», как и в SQL (`NULL = true` не проходит WHERE). Чтобы копия не
 * разошлась со шлюзом молча, кабинет получает и ответ самого шлюза —
 * `on_storefront` из того же запроса (`publicTourSql(...) AS on_storefront`),
 * и слово шлюза «нет» сильнее флагов: «На витрине» у тура, которого нет в
 * каталоге, — та самая ложь, ради которой функция заведена. Равенство
 * «флаги дают on» ⇔ `on_storefront` ⇔ «тур в выдаче каталога» на настоящей
 * базе держит `tests/integration/public-tour-gate.pg.test.ts`.
 */
export type StorefrontState = 'on' | 'draft' | 'hidden';

export interface StorefrontFlags {
  is_active: boolean | null | undefined;
  is_published: boolean | null | undefined;
  deleted_at?: string | Date | null;
  /** Ответ шлюза `publicTourSql` из того же запроса, если строка его несёт. */
  on_storefront?: boolean | null;
}

export function storefrontState(t: StorefrontFlags): StorefrontState {
  if (t.deleted_at != null || t.is_active !== true) return 'hidden';
  if (t.is_published !== true) return 'draft';
  if (t.on_storefront === false) return 'hidden';
  return 'on';
}

/**
 * Какие отметки редактора не стоят у тура — словами, как они названы в
 * редакторе. Лекарство называется целиком: у выключенного и неопубликованного
 * тура не хватает ОБЕИХ, и подсказка «включите „Активен“» оставила бы его вне
 * витрины (ревью #2642). Удалённый тур кабинет не показывает вовсе, поэтому
 * его здесь нет.
 */
export type StorefrontMark = 'Активен' | 'Опубликован';

export function missingStorefrontMarks(t: StorefrontFlags): StorefrontMark[] {
  const out: StorefrontMark[] = [];
  if (t.is_active !== true) out.push('Активен');
  if (t.is_published !== true) out.push('Опубликован');
  return out;
}

/** Подпись состояния — одна на список туров и экран «Чего не хватает». */
export const STOREFRONT_LABELS: Record<StorefrontState, string> = {
  on: 'На витрине',
  draft: 'Черновик — туристы не видят',
  hidden: 'Скрыт',
};
