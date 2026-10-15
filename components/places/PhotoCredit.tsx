import type { PlacePhotoAttribution, PlacePhotoRights } from './types';

/**
 * Подпись «Фото:» под кадром карточки места — одна вёрстка для главного кадра
 * и для кадров галереи (15.10).
 *
 * До этого дня полную подпись — автор, лицензия, страница файла — получал
 * только главный кадр, а кадр галереи подписывался одним именем. Для снимков
 * Wikimedia Commons это неполная атрибуция: CC BY и CC BY-SA требуют назвать
 * лицензию и дать ссылку. Пока снимки Commons стояли главными кадрами, пробел
 * был не виден; после 1263 и 1265 у карточек, где кадры партнёров спрятаны,
 * снимки Commons живут только в галерее (1266).
 *
 * Что записано — то и выводится, без умолчаний (§4.0): нет ни автора, ни
 * лицензии — подписи нет.
 */
export default function PhotoCredit({ author, license, licenseUrl, sourceUrl }: PlacePhotoAttribution) {
  if (!author && !license) return null;
  return (
    // Ширину и поля задаёт раскладка карточки (_PlaceDetailClient), не блок.
    <div className="pt-1.5 text-right text-[11px] text-[var(--text-muted)]">
      Фото:{' '}
      {author && (
        sourceUrl ? (
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-[var(--ocean)]">
            {author}
          </a>
        ) : (
          <span>{author}</span>
        )
      )}
      {license && (
        <>
          {author ? ' · ' : ''}
          {licenseUrl ? (
            <a href={licenseUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-[var(--ocean)]">
              {license}
            </a>
          ) : (
            <span>{license}</span>
          )}
        </>
      )}
    </div>
  );
}

const NO_RIGHTS: PlacePhotoRights = { license: null, licenseUrl: null, sourceUrl: null };

/**
 * Чья подпись под кадром на экране. Кадр галереи — его автор и его права,
 * имя главного кадра ему не приписывается (04.10, владелец: «если фото Ильи —
 * то и подпись его»). Кадр не из галереи или ещё не известен — подпись
 * главного кадра. Подписать нечем (ни автора, ни лицензии) — null.
 */
export function creditFor(
  current: string | null,
  credits: Record<string, string | null>,
  rights: Record<string, PlacePhotoRights> | undefined,
  hero: PlacePhotoAttribution | null,
  isHero: (src: string) => boolean,
): PlacePhotoAttribution | null {
  const credit = current && current in credits && !isHero(current)
    ? { author: credits[current], ...(rights?.[current] ?? NO_RIGHTS) }
    : hero;
  return credit && (credit.author || credit.license) ? credit : null;
}
