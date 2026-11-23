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

/**
 * Точечные сниппеты видов под запросы Google (Search Console 18–20.11).
 * Без « | Ведар»; вместе title ≤ 60, description ≤ 160.
 */
export interface FishSearchMeta {
  title: string;
  description: string;
}

export const FISH_SEARCH_META: Readonly<Record<string, FishSearchMeta>> = {
  // /fish/forel — 16 показов в топ-10, 0 кликов. Шаблон ставил латинские
  // имена в title и начинал описание с «Сезон:», обрезая суть.
  forel: {
    title: 'Форель на Камчатке — микижа, сезон май — сентябрь',
    description:
      'На Камчатке форелью чаще всего называют микижу — радужную форель. Живёт в холодных ручьях и горных озёрах. Сезон — май — сентябрь. Рекорд в природе — до 6,5 кг.',
  },
  // Викторина «царь лососей»: страница есть, в GSC 18–21.11 её не было.
  chavycha: {
    title: 'Чавыча на Камчатке — царь лососей',
    description:
      'Самый крупный тихоокеанский лосось: её называют царём лососей, царём-рыбой и королевским лососем (king salmon). Сезон хода — 1 июня — 15 июля.',
  },
};

export function fishSearchMeta(id: string | null | undefined): FishSearchMeta | null {
  return id ? FISH_SEARCH_META[id] ?? null : null;
}
