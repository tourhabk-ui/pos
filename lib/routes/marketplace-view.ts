/**
 * Чтение представления `v_route_marketplace` — только через эту обёртку.
 *
 * Представление (миграция 056) отдаёт туры операторов по маршрутам: карточка
 * маршрута, цена маршрута «от» в каталоге, маршруты на странице компании. Его
 * WHERE записан в SQL — три флага тура и `p.is_public = true` — и отметки
 * «тестовый профиль» (1495) не знает: позвать условие витрины
 * (`publicPartnerSql`) представление не может.
 *
 * Ревью безопасности PR #3780 (23.11) нашло это дважды. Сначала — что второй
 * замок до читателей представления не доходил. Потом — что отсечка,
 * дописанная в каждого читателя, проверяется по файлу, а не по запросу: второй
 * запрос к представлению в том же файле прошёл бы без неё. Поэтому отсечка
 * стоит не у читателя, а здесь: обёртка — подзапрос, в котором тестовый
 * профиль уже отсечён, и другого способа прочитать представление нет.
 *
 * Сторож `tests/unit/public-partner-gate.test.ts`: имя представления в коде
 * `app/`, `lib/` и `components/` встречается только в этом файле.
 */
import { testPartnerIdSql } from '@/lib/partners/test-profile';
import { partnerOffStorefrontIdSql } from '@/lib/operators/site-pause';

/**
 * Представление как источник строк под псевдонимом `alias`:
 * `FROM ${routeMarketplaceSql('v')} JOIN …`. Колонки — те же, что у
 * представления; туров тестового профиля в нём нет.
 *
 * Общая витрина (карточка маршрута, цена маршрута в каталоге) не берёт и
 * туры компании на паузе, отклонённой или приостановленной
 * (lib/operators/site-pause, 24.11 — продолжение «Разберись с Местечком»):
 * шлюз `publicTourSql` их уже не пускал, а представление держит свою копию
 * флагов и паузы не знало.
 *
 * `{ byLink: true }` — для страницы самой компании по её адресу (как
 * `tourOpenByLinkSql`): её маршруты показываются и на паузе.
 */
export function routeMarketplaceSql(alias: string, opts: { byLink?: boolean } = {}): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`routeMarketplaceSql: недопустимый алиас «${alias}»`);
  }
  const offStorefront = opts.byLink ? '' : `
              AND NOT ${partnerOffStorefrontIdSql('gated_view.operator_id')}`;
  return `(SELECT gated_view.* FROM v_route_marketplace gated_view
            WHERE NOT ${testPartnerIdSql('gated_view.operator_id')}${offStorefront}) ${alias}`;
}
