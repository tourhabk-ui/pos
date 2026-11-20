/**
 * Какой кадр галереи места показывается — одно правило для карточки места,
 * фото маршрута из его точек и раздачи кадра по прямому адресу.
 *
 * Два условия:
 *  - кадр не спрятан рукой (`hidden_reason`, 1263);
 *  - снимок партнёра (`partner_id`, 1431) — только при его действующем
 *    согласии той версии, что называет карточки мест и маршрутов
 *    (`PLACE_CARDS_CONSENT_FROM`, владелец 12.11). Нет подписи, подпись
 *    прежней версии, согласие отозвано — кадра нет нигде: ни на карточке,
 *    ни у маршрута, ни по прямому адресу.
 *
 * Правило одно намеренно: 1263 прятала кадр в трёх местах тремя одинаковыми
 * строками `hidden_reason IS NULL`, и четвёртый читатель мог забыть пятую.
 */
import { PLACE_CARDS_CONSENT_FROM } from '@/lib/legal/partner-materials-consent';

if (!/^\d{4}-\d{2}-\d{2}$/.test(PLACE_CARDS_CONSENT_FROM)) {
  // Строка встраивается в SQL литералом — только дата, ничего больше.
  throw new Error('PLACE_CARDS_CONSENT_FROM: ожидается дата YYYY-MM-DD');
}

/** SQL-условие «кадр галереи показывается»; `g` — псевдоним place_gallery_photos. */
export function galleryShownSql(g: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(g)) throw new Error(`galleryShownSql: псевдоним «${g}»`);
  return `(${g}.hidden_reason IS NULL AND (${g}.partner_id IS NULL OR EXISTS (
      SELECT 1 FROM partner_material_consents pmc
       WHERE pmc.partner_id = ${g}.partner_id
         AND pmc.revoked_at IS NULL
         AND pmc.text_version >= '${PLACE_CARDS_CONSENT_FROM}')))`;
}

/**
 * SQL-условие «у партнёра действующее согласие версии, что называет карточки
 * мест и маршрутов»; `partnerIdExpr` — выражение с id партнёра (`pa.id`).
 * То же условие, что внутри `galleryShownSql`, — для снимков туров на
 * карточках маршрутов (lib/routes/tour-photos): подпись прежней версии
 * называет только «блоки туров», а не снимок самого маршрута.
 */
export function partnerPlaceCardsConsentSql(partnerIdExpr: string): string {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(partnerIdExpr)) {
    throw new Error(`partnerPlaceCardsConsentSql: выражение «${partnerIdExpr}»`);
  }
  return `EXISTS (
      SELECT 1 FROM partner_material_consents pmc
       WHERE pmc.partner_id = ${partnerIdExpr}
         AND pmc.revoked_at IS NULL
         AND pmc.text_version >= '${PLACE_CARDS_CONSENT_FROM}')`;
}
