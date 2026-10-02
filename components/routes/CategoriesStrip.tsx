import Link from 'next/link';
import { Compass } from 'lucide-react';
import type { CategoryLink } from '@/lib/routes/live-categories';

/**
 * Полоса-навигация по живым категориям каталога (/routes/<slug>).
 * Список приходит с сервера — ссылки в первом HTML: до 01.10 на страницы
 * категорий не вело ни одной ссылки снаружи их самих (аудит vedarai.ru).
 * `null` или пусто — сервер не прочитал список или живых нет: не рисуется.
 */
export default function CategoriesStrip({ categories }: { categories: CategoryLink[] | null }) {
  if (!categories || categories.length === 0) return null;
  return (
    <div className="mb-5 flex items-center gap-2 overflow-x-auto pb-1">
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] shrink-0">
        <Compass className="w-3.5 h-3.5 text-[var(--ocean)]" />
        Виды
      </span>
      {categories.map((c) => (
        <Link
          key={c.slug}
          href={`/routes/${c.slug}`}
          className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-all duration-200 hover:border-[var(--ocean)] hover:text-[var(--ocean)]"
        >
          {c.name}
        </Link>
      ))}
    </div>
  );
}
