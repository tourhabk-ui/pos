import Link from 'next/link';
import { plural } from '@/lib/home/data-freshness';
import { loadMapPlacesIndex, type MapPlacesIndex as Index } from '@/lib/map/places-index';

/**
 * Места на карте — списком под ней, в серверном HTML (14.10).
 *
 * Сама карта рисуется в браузере, и до этого у /map для поисковика было 12
 * слов. Здесь те же места ссылками на карточки, по типам; группы свёрнуты,
 * чтобы под картой не вырастала лента в пять экранов. Свёрнутое тоже в
 * разметке — поисковик его читает.
 *
 * Нет данных или чтение не удалось — блока нет: карта работает и без него,
 * а отказ уже в логе загрузчика (lib/map/places-index).
 */
export function MapPlacesIndex({ index }: { index: Index | null }) {
  if (!index || index.total === 0) return null;
  return (
    <section aria-labelledby="map-places-index" className="max-w-7xl mx-auto px-4 pt-10 pb-28 md:pb-12">
      <h2 id="map-places-index" className="ds-h2 mb-2">Места на карте Камчатки</h2>
      <p className="text-[var(--text-secondary)] mb-6 max-w-2xl">
        На карте — {index.total} {plural(index.total, 'место', 'места', 'мест')}. Ниже они же списком по
        типам, у каждого — своя карточка.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {index.groups.map((g) => (
          <details key={g.type} className="ds-card p-4">
            <summary className="cursor-pointer select-none">
              <h3 className="inline font-semibold text-[var(--text-primary)]">{g.label}</h3>
              <span className="text-[var(--text-muted)]"> · {g.places.length}</span>
            </summary>
            <ul className="mt-3 sm:columns-2 gap-x-6 text-sm">
              {g.places.map((p) => (
                <li key={p.href} className="py-1 break-inside-avoid">
                  <Link href={p.href} prefetch={false} className="text-[var(--ocean)] hover:underline">
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}

/** Загрузка и вывод — для страницы карты: своя граница ожидания, шапку карты не держит. */
export async function MapPlacesIndexSection() {
  return <MapPlacesIndex index={await loadMapPlacesIndex()} />;
}
