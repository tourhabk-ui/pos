/**
 * Сторож словаря разделов мест: единый источник + перепись оставшихся копий.
 *
 * 17.09 словарь PLACE_TYPE_LABEL вынесен из app/places/[id]/page.tsx в
 * lib/places/type-label.ts, чтобы карточка и контекст Хранителя называли
 * раздел одним словом. Второй экземпляр того же словаря в любом другом
 * файле — тот же дефект, что две копии карточки тура (§11): расходятся молча.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { PLACE_TYPE_LABEL, placeTypeLabel } from '@/lib/places/type-label';

describe('placeTypeLabel — три исхода', () => {
  it('known type → Russian label', () => {
    expect(placeTypeLabel('volcano')).toBe('Вулкан');
    expect(placeTypeLabel('mountain')).toBe('Гора');
  });
  it('recorded but unmapped type → the slug itself, not silence and not «Место»', () => {
    expect(placeTypeLabel('glacier')).toBe('glacier');
  });
  it('absent type → null (caller prints nothing)', () => {
    expect(placeTypeLabel(null)).toBeNull();
    expect(placeTypeLabel(undefined)).toBeNull();
    expect(placeTypeLabel('')).toBeNull();
  });
  it('dictionary covers the catalogue sections the place card relies on', () => {
    for (const k of ['volcano', 'mountain', 'lake', 'hot_spring', 'geyser', 'bay']) {
      expect(PLACE_TYPE_LABEL[k]).toBeTruthy();
    }
  });
});

/**
 * Перепись 17.09: словарь «слаг типа → русское слово» живёт в ДВЕНАДЦАТИ
 * файлах, и как минимум в двух редакциях («Источник» / «Термальный
 * источник», «Смотровая» / «Смотровая площадка»). Этот PR объединил две
 * поверхности, которые сторожа *-type-cleanup уже держали вместе: карточку
 * места и контекст Хранителя. Остальные копии НЕ сметены заодно — это
 * решение владельца: у листа карты слова короче намеренно, у админки фото
 * есть ключ settlement, которого нет больше нигде. Сводить всё к одному
 * слову значило бы менять текст на десяти экранах ради опрятности.
 *
 * Список ниже — перепись факта, не реестр решений (тот же приём, что
 * FROZEN_COLLISIONS у номеров миграций и KNOWN_UNCONSUMED у конфига). Он
 * может только СОКРАЩАТЬСЯ: новая копия словаря краснеет, а копия, которую
 * перевели на lib/places/type-label.ts, обязана быть отсюда убрана — иначе
 * сторож зеленеет ровно тогда, когда объединение отвалилось.
 */
const KNOWN_COPIES = new Set([
  'app/api/search/route.ts',
  'app/collections/[slug]/_CollectionDetailClient.tsx',
  'app/hub/admin/content/tours/page.tsx',
  'app/hub/admin/places-photos/_PlacesPhotosClient.tsx',
  'app/routes/[id]/_RouteDetailClient.tsx',
  'app/tools/safety/_SafetyClient.tsx',
  'app/trending/_TrendingClient.tsx',
  'components/map/PlaceMapSheet.tsx',
  'components/places/types.ts',
  'components/safety/LiveStatus.tsx',
  'lib/notifications/telegram-channel.ts',
]);

describe('копии словаря типов — только сокращаются', () => {
  function copies(): string[] {
    return execSync(
      "grep -rln \"volcano: 'Вулкан'\" app lib components --include=*.ts --include=*.tsx || true",
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).filter(f => f !== 'lib/places/type-label.ts').sort();
  }

  it('the single source exists', () => {
    expect(PLACE_TYPE_LABEL.volcano).toBe('Вулкан');
  });

  it('the place card no longer carries its own copy', () => {
    expect(copies()).not.toContain('app/places/[id]/page.tsx');
  });

  it('no NEW copy of the dictionary appears outside the frozen list', () => {
    const fresh = copies().filter(f => !KNOWN_COPIES.has(f));
    expect(fresh, 'новая копия словаря — брать из lib/places/type-label.ts').toEqual([]);
  });

  it('a copy that was unified must be removed from the frozen list (list only shrinks)', () => {
    const present = new Set(copies());
    const stale = [...KNOWN_COPIES].filter(f => !present.has(f));
    expect(stale, 'этих копий больше нет — убрать из KNOWN_COPIES').toEqual([]);
  });
});
