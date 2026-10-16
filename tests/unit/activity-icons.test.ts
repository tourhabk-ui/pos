// @vitest-environment node
/**
 * Значки активностей и мест парны словарю подписей (владелец 12.10: «в турах,
 * наверное, иконку активностей — в данном случае это джип-тур»; «переводи
 * копии значков на единый словарь»).
 *
 * Держит связку: у каждой подписи есть значок и у каждого значка — подпись
 * (новый тип без значка или значок-сирота — красный); синонимы маршрутов
 * дают значок и подпись основного ключа; канон там, где копии расходились
 * (вертолёт — вертолёт, море — якорь, вулкан — огонь); семь поверхностей
 * берут значок отсюда, и своей карты «тип → значок» в app/ и components/
 * больше нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Anchor, Car, Camera, Droplets, Fish, Flame, Helicopter, MapPin, PawPrint, Ticket, TreePine, Wind } from 'lucide-react';
import { ACTIVITY_ICONS, LOCATION_ICONS, FALLBACK_ACTIVITY_ICON, activityIcon, locationIcon, anyTypeIcon, iconSpeaksInRow } from '@/lib/tours/activity-icons';
import { ACTIVITY_LABELS, LOCATION_LABELS, ACTIVITY_ALIASES, activityLabel, anyTypeLabel } from '@/lib/tours/labels';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Поверхности, у которых 12.10 была своя карта значков, плюс блок туров по запросу. */
const SURFACES = [
  'app/hub/tourist/cart/_CartClient.tsx',
  'app/routes/[id]/_RouteDetailClient.tsx',
  'app/hub/admin/content/tours/page.tsx',
  'app/planner/_PlannerClient.tsx',
  'components/marketplace/MarketplaceClient.tsx',
  'components/routes/RouteGradientPlaceholder.tsx',
  'components/search/ToursForQuery.tsx',
];

/** Карты родов МЕСТА, не активностей: сведение — отдельная работа (см. шапку словаря). */
const KNOWN_PLACE_KIND_MAPS = ['components/routes/PlaceCard.tsx'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('значки активностей и мест', () => {
  it('ключи значков — ровно ключи подписей (активности и места)', () => {
    expect(Object.keys(ACTIVITY_ICONS).sort()).toEqual(Object.keys(ACTIVITY_LABELS).sort());
    expect(Object.keys(LOCATION_ICONS).sort()).toEqual(Object.keys(LOCATION_LABELS).sort());
  });

  it('канон там, где копии расходились: вертолёт, море, вулкан, джип, тайга', () => {
    expect(activityIcon('helicopter')).toBe(Helicopter);
    expect(activityIcon('boat_trip')).toBe(Anchor);
    expect(activityIcon('volcano')).toBe(Flame);
    expect(activityIcon('jeep_safari')).toBe(Car);
    expect(activityIcon('fishing')).toBe(Fish);
    expect(locationIcon('volcano')).toBe(Flame);
    expect(locationIcon('forest')).toBe(TreePine);
    // Где роды совпадают с карточкой места — те же значки, что там.
    const placeCard = read('components/routes/PlaceCard.tsx');
    expect(placeCard).toMatch(/lake:\s+Droplets/);
    expect(placeCard).toMatch(/geyser:\s+Wind/);
    expect(locationIcon('lake')).toBe(Droplets);
    expect(locationIcon('geyser')).toBe(Wind);
  });

  it('синонимы маршрутов ведут к значку и подписи основного ключа', () => {
    for (const [alias, canon] of Object.entries(ACTIVITY_ALIASES)) {
      expect(ACTIVITY_LABELS[canon], `${alias} → ${canon}: основного ключа нет в словаре`).toBeDefined();
      expect(ACTIVITY_LABELS[alias], `${alias}: синоним не заводится второй подписью`).toBeUndefined();
      expect(activityIcon(alias)).toBe(activityIcon(canon));
      expect(activityLabel(alias)).toBe(activityLabel(canon));
    }
    expect(activityIcon('bear_watching')).toBe(PawPrint);
    expect(activityIcon('photo')).toBe(Camera);
    expect(activityLabel('jeep')).toBe('Джип-сафари');
  });

  it('неизвестный тип и пустота — общий значок, не исключение и не пустота; «маршрут» — точка на карте', () => {
    expect(activityIcon('zzz')).toBe(FALLBACK_ACTIVITY_ICON);
    expect(activityIcon(null)).toBe(Ticket);
    expect(activityIcon(undefined)).toBe(Ticket);
    expect(locationIcon('zzz')).toBe(Ticket);
    expect(activityIcon('other')).toBe(MapPin);
  });

  it('ряд каталога: значок без слова — только свой и единственный в ряду (владелец 16.10)', () => {
    // Рыбалка, джип, вертолёт — у каждого свой значок: хватит значка.
    expect([...iconSpeaksInRow(['fishing', 'jeep_safari', 'helicopter'])]).toEqual(['fishing', 'jeep_safari', 'helicopter']);
    // Сплав и сёрфинг — обе волны: рядом не различить, оба словом; рыбалка — значком.
    expect([...iconSpeaksInRow(['rafting', 'surf', 'fishing'])]).toEqual(['fishing']);
    // Морская прогулка и дайвинг — оба якоря.
    expect(iconSpeaksInRow(['boat_trip', 'diving']).size).toBe(0);
    // Один из пары в ряду — значок свой и единственный.
    expect([...iconSpeaksInRow(['rafting'])]).toEqual(['rafting']);
    // Общий значок (конная прогулка, неизвестный вид) и «маршрут» — словом, даже в одиночку.
    expect(iconSpeaksInRow(['horseback']).size).toBe(0);
    expect(iconSpeaksInRow(['zzz']).size).toBe(0);
    expect(iconSpeaksInRow(['other']).size).toBe(0);
    expect([...iconSpeaksInRow(['horseback', 'fishing', 'other'])]).toEqual(['fishing']);
    // Синонимы одного вида — два одинаковых значка: словом оба.
    expect(iconSpeaksInRow(['jeep', 'jeep_safari']).size).toBe(0);
    expect(iconSpeaksInRow([]).size).toBe(0);
  });

  it('корзина: сначала активность, затем место — как anyTypeLabel', () => {
    expect(anyTypeIcon('fishing')).toBe(Fish);
    expect(anyTypeIcon('mountain')).toBe(LOCATION_ICONS.mountain);
    expect(anyTypeIcon('jeep')).toBe(Car);
    expect(anyTypeIcon('zzz')).toBe(Ticket);
    expect(anyTypeLabel('jeep')).toBe('Джип-сафари');
  });

  it('семь поверхностей берут значок из словаря, а не из своей карты', () => {
    for (const f of SURFACES) {
      const src = read(f);
      expect(src, f).toContain("from '@/lib/tours/activity-icons'");
      expect(src, f).not.toMatch(/const\s+ACTIVITY_ICONS\s*[:=]/);
      expect(src, f).not.toMatch(/case '(fishing|helicopter|trekking|boat_trip)': return </);
      expect(src, f).not.toMatch(/Icon:\s*(Plane|Wind|ThermometerSun)\b/);
    }
    expect(read('components/search/ToursForQuery.tsx')).toMatch(/const Icon = activityIcon\(t\.activity_type\)/);
  });

  it('своих карт «тип → значок» в app/ и components/ больше нет (кроме родов места — названы с причиной)', () => {
    const found = ['app', 'components']
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => /const\s+(ACTIVITY|LOCATION)_ICONS\s*[:=]/.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(ROOT, f))
      .sort();
    // Самоустаревающий список: роды МЕСТА (бухта, мыс, музей…) — другой, более
    // широкий словарь со своими подписями; сведётся отдельной работой. Исчез
    // из карточки места — запись обязана уйти отсюда.
    expect(found).toEqual(KNOWN_PLACE_KIND_MAPS);
  });
});
