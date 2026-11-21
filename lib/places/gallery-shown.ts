/**
 * Какой кадр галереи места показывается — одно правило для карточки места,
 * фото маршрута из его точек и раздачи кадра по прямому адресу.
 *
 * Условие одно: кадр не спрятан рукой (`hidden_reason`, 1263).
 *
 * Снимок партнёра (`partner_id`, 1431) до 21.11 показывался только при его
 * действующем согласии версии PLACE_CARDS_CONSENT_FROM. Владелец 20.11:
 * «делай без их согласия» (на маршрутах — #3623), 21.11: «и на местах тоже»
 * — согласие больше не условие показа; подпись «Фото: <партнёр>» со ссылкой
 * на его страницу осталась (lib/places/place-detail, photoRightsOf).
 *
 * Кадр оператора на паузе витринных блоков или отклонённого
 * (`operatorShownInTourBlocksSql`, владелец 21.11: «Местечко» на паузе) не
 * показывается — ни на карточке места, ни у маршрута, ни по прямому адресу.
 *
 * Правило одно намеренно: 1263 прятала кадр в трёх местах тремя одинаковыми
 * строками `hidden_reason IS NULL`, и четвёртый читатель мог забыть пятую.
 */

import { operatorShownInTourBlocksSql } from '@/lib/operators/site-pause';

/** SQL-условие «кадр галереи показывается»; `g` — псевдоним place_gallery_photos. */
export function galleryShownSql(g: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(g)) throw new Error(`galleryShownSql: псевдоним «${g}»`);
  return `(${g}.hidden_reason IS NULL AND (${g}.partner_id IS NULL OR EXISTS (
      SELECT 1 FROM partners gp WHERE gp.id = ${g}.partner_id AND ${operatorShownInTourBlocksSql('gp')})))`;
}
