/**
 * Главный кадр тура — одно правило для всех витрин.
 *
 * Повод (29.09, владелец, скриншоты): на главной в «Турах сезона» у сплава по
 * Быстрой стояла групповая фотография из `tour_image`, а в карточке тура
 * первым кадром галереи — река на фоне вулканов. Карточка тура берёт
 * `photos[0]` (`allPhotos` в `_TourDetailClient`), главная и каталог —
 * `tour_image`; поле оператор заполнял раньше галереи, и в нём остался кадр
 * «на всякий случай». Красивая картинка терялась ровно там, где тур продают.
 *
 * Правило: первый кадр галереи, а если галереи нет — `tour_image`. Пустая
 * строка — не кадр (это дырка в массиве, а не картинка). Нет ни того, ни
 * другого — `null`, и витрина рисует градиент, а не подставленную чужую фото.
 */

/** SQL: главный кадр тура. `alias` — алиас `operator_tours` в запросе. */
export function tourHeroImageSql(alias: string = 'ot'): string {
  return `COALESCE(NULLIF(btrim((${alias}.photos)[1]), ''), NULLIF(btrim(${alias}.tour_image), ''))`;
}

/** То же для уже прочитанной строки тура (метаданные страницы, разметка). */
export function tourHeroImage(
  photos: readonly (string | null)[] | null | undefined,
  tourImage: string | null | undefined,
): string | null {
  const first = photos?.[0]?.trim();
  if (first) return first;
  const cover = tourImage?.trim();
  return cover ? cover : null;
}
