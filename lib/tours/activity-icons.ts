/**
 * Значок типа активности и типа места — ОДИН источник, парный словарю
 * подписей (lib/tours/labels: ACTIVITY_LABELS, LOCATION_LABELS, синонимы
 * ACTIVITY_ALIASES).
 *
 * Повод — владелец 12.10, снимок страницы мест: в блоке «Туры по запросу»
 * у джип-тура к озеру Толмачёва стоял общий значок билета, а «в турах,
 * наверное, иконку активностей — в данном случае это джип-тур». Карта
 * «тип → значок» к тому дню жила СЕМЬЮ копиями (корзина, карточка
 * маршрута, витрина, админ-список туров, планер, плейсхолдер без фото,
 * блок туров по запросу) с разными значками для одного типа: вертолёт был
 * вертолётом, самолётом и ветром, вулкан — огнём и горой, термы —
 * градусником с солнцем и без. Та же болезнь, что у подписей до 03.08.
 * Копии сведены сюда словом владельца 12.10 («переводи копии значков на
 * единый словарь»); где копии расходились, выбран значок, который чаще
 * встречался и честнее называет вид.
 *
 * Правила (сторож tests/unit/activity-icons.test.ts):
 *   - ключи ACTIVITY_ICONS — РОВНО ключи ACTIVITY_LABELS, LOCATION_ICONS —
 *     ровно LOCATION_LABELS: новая подпись без значка не заведётся молча;
 *   - синонимы маршрутов (bear_watching, jeep, photo) дают значок основного
 *     ключа; неизвестный тип — общий значок, не пустота и не исключение;
 *   - своих карт «тип → значок» в app/ и components/ больше нет.
 * Значки — только lucide-react (CLAUDE.md §3), без эмодзи.
 */
import {
  Anchor, Binoculars, Camera, Car, Eye, Fish, Flame, Footprints, Helicopter, Landmark,
  Leaf, MapPin, Mountain, MountainSnow, PawPrint, Sailboat, Snowflake, Thermometer,
  Ticket, TreePine, Waves, Droplets, Wind,
  type LucideIcon,
} from 'lucide-react';
import { canonicalActivity } from './labels';

/** Тип активности → значок. Ключи синхронны с ACTIVITY_LABELS. */
export const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  trekking:      Mountain,
  fishing:       Fish,
  thermal:       Thermometer,
  helicopter:    Helicopter,
  boat_trip:     Anchor,
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
  surf:          Waves,
  hiking:        Footprints,
  ski:           MountainSnow,
  sightseeing:   Eye,
  // «Маршрут» — точка на карте, а не билет.
  other:         MapPin,
};

/**
 * Тип локации ТУРА → значок. Ключи синхронны с LOCATION_LABELS.
 *
 * Это не словарь родов МЕСТА (places.location_type: бухта, мыс, водопад,
 * скала, смотровая, музей…) — тот шире и живёт со своими подписями в
 * карточке места (components/routes/PlaceCard), чипах /places и листе
 * места; сводить его — отдельная работа. Где роды совпадают, значки взяты
 * как в карточке места (озеро — капли, гейзер — пар), чтобы одно и то же
 * не выглядело по-разному на соседних экранах.
 */
export const LOCATION_ICONS: Record<string, LucideIcon> = {
  mountain:   Mountain,
  volcano:    Flame,
  hot_spring: Thermometer,
  lake:       Droplets,
  sea:        Waves,
  river:      Waves,
  forest:     TreePine,
  coast:      Anchor,
  geyser:     Wind,
};

/** Общий значок для типа, которого словарь не знает. */
export const FALLBACK_ACTIVITY_ICON: LucideIcon = Ticket;

/** Значок активности; синоним — значок основного ключа; неизвестное и пустота — общий значок. */
export function activityIcon(type: string | null | undefined): LucideIcon {
  if (!type) return FALLBACK_ACTIVITY_ICON;
  return ACTIVITY_ICONS[canonicalActivity(type)] ?? FALLBACK_ACTIVITY_ICON;
}

/** Значок типа места; неизвестное и пустота — общий значок. */
export function locationIcon(type: string | null | undefined): LucideIcon {
  if (!type) return FALLBACK_ACTIVITY_ICON;
  return LOCATION_ICONS[type] ?? FALLBACK_ACTIVITY_ICON;
}

/**
 * Значок для поверхностей, где в одном списке лежат и туры, и места
 * (корзина): сначала тип активности, затем тип места — как anyTypeLabel.
 */
export function anyTypeIcon(type: string | null | undefined): LucideIcon {
  if (!type) return FALLBACK_ACTIVITY_ICON;
  return ACTIVITY_ICONS[canonicalActivity(type)] ?? LOCATION_ICONS[type] ?? FALLBACK_ACTIVITY_ICON;
}
