/**
 * Значок типа активности тура — ОДИН источник, парный словарю подписей
 * (lib/tours/labels: ACTIVITY_LABELS).
 *
 * Повод — владелец 12.10, снимок страницы мест: в блоке «Туры по запросу»
 * у джип-тура к озеру Толмачёва стоял общий значок билета, а «в турах,
 * наверное, иконку активностей — в данном случае это джип-тур». Карта
 * «тип → значок» к тому дню жила пятью копиями (корзина, карточка маршрута,
 * витрина, админ-список туров, планер) с разными ключами и разными
 * значками для одного типа — та же болезнь, что у подписей до 03.08.
 *
 * Правило: ключи — РОВНО ключи ACTIVITY_LABELS (сторож
 * tests/unit/activity-icons.test.ts): новая подпись без значка не
 * заведётся молча. Неизвестный тип — общий значок билета, не пустота.
 * Значки — только lucide-react (CLAUDE.md §3), без эмодзи.
 */
import {
  Anchor, Binoculars, Camera, Car, Eye, Fish, Flame, Footprints, Helicopter, Landmark,
  Leaf, MountainSnow, PawPrint, Sailboat, Ship, Snowflake, Thermometer, Ticket, Waves,
  type LucideIcon,
} from 'lucide-react';

/** Тип активности → значок. Ключи синхронны с ACTIVITY_LABELS. */
export const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  trekking:      Footprints,
  fishing:       Fish,
  thermal:       Thermometer,
  helicopter:    Helicopter,
  boat_trip:     Ship,
  bears:         PawPrint,
  rafting:       Waves,
  snowmobile:    Snowflake,
  volcano:       Flame,
  eco:           Leaf,
  diving:        Anchor,
  // У lucide нет лошади; общий значок честнее чужого (компас, след).
  horseback:     Ticket,
  jeep_safari:   Car,
  skiing:        MountainSnow,
  kayak:         Sailboat,
  photography:   Camera,
  birdwatching:  Binoculars,
  cultural:      Landmark,
  winter_hiking: MountainSnow,
  hiking:        Footprints,
  ski:           MountainSnow,
  sightseeing:   Eye,
  other:         Ticket,
};

/** Общий значок для типа, которого словарь не знает. */
export const FALLBACK_ACTIVITY_ICON: LucideIcon = Ticket;

/** Значок активности; неизвестный тип и пустота — общий значок. */
export function activityIcon(type: string | null | undefined): LucideIcon {
  if (!type) return FALLBACK_ACTIVITY_ICON;
  return ACTIVITY_ICONS[type] ?? FALLBACK_ACTIVITY_ICON;
}
