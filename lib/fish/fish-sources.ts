/** Даты и источники справочника рыб (/fish), Сыщик 21.11. */

/**
 * Дата последней правки текста справочника (lib/fish-species.ts) — для
 * dateModified и строки «Обновлено» (Сыщик 21.11: у /fish не было дат).
 * Меняется тем же коммитом, что и текст видов.
 */
export const FISH_TEXT_REVISION = '2026-11-21';

/**
 * Источник латинских названий — карточки видов FishBase. Только биномены:
 * «spp.», пары через «/» и краб (не рыба, в FishBase его нет) без ссылки.
 */
export function fishBaseUrl(latin: string): string | null {
  if (!/^[A-Z][a-z]+ [a-z]+$/.test(latin)) return null;
  if (latin === 'Paralithodes camtschaticus') return null;
  return `https://www.fishbase.se/summary/${latin.replace(' ', '-')}.html`;
}


/**
 * Официальные сроки любительского лова лососей и список лососевых id —
 * из единого справочника фактов (lib/facts/kamchatka.ts). Текст и источники
 * те же, что были сверены 21.11.2026.
 */
export { SALMON_FISH_IDS, SALMON_OFFICIAL_SEASON } from '@/lib/facts/kamchatka';
