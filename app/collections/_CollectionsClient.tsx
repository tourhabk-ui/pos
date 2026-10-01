'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BookOpen, Mountain, Flame, Leaf, Users } from 'lucide-react';
import { plural } from '@/lib/home/data-freshness';
import type { CollectionCardData } from '@/lib/collections/list';

type Collection = CollectionCardData;

const TAG_ICONS: Record<string, React.ElementType> = {
  вулканы: Flame,
  источники: Flame,
  природа: Leaf,
  животные: Leaf,
  треккинг: Mountain,
  'лёгкие маршруты': Mountain,
  семьи: Users,
};

function CollectionCard({ col }: { col: Collection }) {
  const itemCount = col.item_count;
  return (
    <Link
      href={`/collections/${col.slug}`}
      className="ds-card block group hover:shadow-lg transition-all duration-200"
    >
      {col.cover_image ? (
        <img src={col.cover_image} alt={col.title} className="w-full h-48 object-cover rounded-t-lg" />
      ) : (
        <div className="w-full h-48 rounded-t-lg bg-[var(--bg-hover)] flex items-center justify-center">
          <BookOpen className="w-12 h-12 text-[var(--text-muted)]" />
        </div>
      )}
      <div className="p-5">
        <div className="flex flex-wrap gap-1 mb-3">
          {col.tags.slice(0, 3).map(tag => (
            <span key={tag} className="ds-badge text-xs">{tag}</span>
          ))}
        </div>
        <h2 className="font-playfair text-xl font-bold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors mb-2">
          {col.title}
        </h2>
        {col.description && (
          <p className="text-[var(--text-secondary)] text-sm line-clamp-2 mb-3">{col.description}</p>
        )}
        <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span>{itemCount > 0 ? `${itemCount} ${plural(itemCount, 'объект', 'объекта', 'объектов')}` : 'Подборка'}</span>
          <span>{col.view_count.toLocaleString('ru')} просмотров</span>
        </div>
      </div>
    </Link>
  );
}

/**
 * Список приходит с сервера (page.tsx → lib/collections/list): прежде его
 * тянул браузер, и поисковик видел 21–23 слова (аудит 01.10). Фильтр по теме —
 * в памяти: подборок десятки, а теги считаются по ПОЛНОМУ списку — прежде они
 * брались из отфильтрованного, и после выбора темы остальные исчезали.
 */
export function CollectionsClient({ collections: all, failed }: { collections: Collection[]; failed: boolean }) {
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const allTags = Array.from(new Set(all.flatMap(c => c.tags)));
  const collections = activeTag ? all.filter(c => c.tags.includes(activeTag)) : all;

  return (
    <main className="ds-page min-h-screen pb-12">
      <div className="max-w-6xl mx-auto px-4">
        <header className="mb-10">
          <p className="text-[var(--accent)] font-semibold text-sm uppercase tracking-widest mb-2">Подборки</p>
          <h1 className="ds-h1 mb-3">Кураторские маршруты Камчатки</h1>
          <p className="text-[var(--text-secondary)] text-lg max-w-2xl">
            Тщательно подобранные места и маршруты по темам — от вулканов до горячих источников
          </p>
        </header>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-8">
            <button
              onClick={() => setActiveTag(null)}
              className={`ds-badge cursor-pointer transition-colors ${!activeTag ? 'bg-[var(--accent)] text-white' : ''}`}
            >
              Все
            </button>
            {allTags.map(tag => (
              <button
                key={tag}
                onClick={() => setActiveTag(tag === activeTag ? null : tag)}
                className={`ds-badge cursor-pointer transition-colors ${activeTag === tag ? 'bg-[var(--accent)] text-white' : ''}`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {failed ? (
          <div className="text-center py-20 text-[var(--text-muted)]">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p>Не удалось загрузить подборки. Обновите страницу.</p>
          </div>
        ) : collections.length === 0 ? (
          <div className="text-center py-20 text-[var(--text-muted)]">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p>Подборок пока нет</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {collections.map(col => (
              <CollectionCard key={col.id} col={col} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
