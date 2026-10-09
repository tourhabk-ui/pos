/**
 * Русские имена зон безопасности — ЕДИНЫЙ источник.
 *
 * Слаги зон (avachinsky/northern/eastern/western) — внутренние ключи 4-зонной
 * модели, а не имена вулканов. На /safety чип «avachinsky» на предупреждении
 * про Мутновский читался как ошибка («тег не про тот вулкан»), хотя это была
 * верная зона с сырым слагом наружу: Мутновский и Горелый относятся к
 * Авачинско-Петропавловской зоне. Слаг — для кода, человеку — имя зоны.
 *
 * Список имён раньше жил локально в /api/public/danger-summary — второй
 * потребитель завёл бы вторую копию, и они бы разъехались.
 */
import { KRAI_SOUTH_ZONE } from '@/lib/safety/krai-south';
import { KRAI_COMMANDER_ZONE, KRAI_KORYAK_ZONE } from '@/lib/safety/krai-far';

export const ZONE_NAMES: Record<string, string> = {
  avachinsky: 'Авачинско-Петропавловский',
  northern:   'Северная Камчатка',
  eastern:    'Восточное побережье',
  western:    'Западное побережье',
};

/**
 * Имя зоны для показа человеку; незнакомый слаг возвращается как есть.
 * Метки «юг до Петропавловска», «Корякский округ» и «Командоры» — не зоны, а
 * охват по координатам места (04.10 и 09.10, lib/safety/krai-south.ts,
 * lib/safety/krai-far.ts), поэтому в ZONE_NAMES их нет: там перечень четырёх
 * зон, и его обходят как перечень.
 */
export function zoneName(slug: string): string {
  if (slug === KRAI_SOUTH_ZONE) return 'Юг Камчатки до Петропавловска';
  if (slug === KRAI_KORYAK_ZONE) return 'Корякский округ (север края)';
  if (slug === KRAI_COMMANDER_ZONE) return 'Командорские острова';
  return ZONE_NAMES[slug] ?? slug;
}
