/**
 * Описание страницы вида рыбы (/fish/[id]) для выдачи.
 *
 * Склейка всех фактов вида давала 220–313 знаков, а выдача показывает около
 * 160 — и обрезала как раз сезон, ради которого страницу ищут (аудит
 * vedarai.ru 01.10). Сезон — первым, остальное — по предложениям, пока
 * помещается (lib/seo/meta-description).
 */
import type { FishSpecies } from '@/lib/fish-species';
import { metaDescription } from '@/lib/seo/meta-description';

export function fishMetaDescription(
  species: Pick<FishSpecies, 'season' | 'shortDesc' | 'recordKg' | 'habitat'>,
): string {
  return metaDescription(
    `Сезон: ${species.season}. ${species.shortDesc} Рекорд: ${species.recordKg}. Место: ${species.habitat}.`,
  );
}
