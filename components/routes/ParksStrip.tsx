'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { TreePine } from 'lucide-react';

interface ParkLite {
  slug: string;
  displayName: string;
}

/**
 * Полоса-навигация по природным паркам (GET /api/parks).
 * Fail-silent: ошибка/пустой список — не рендерится ничего,
 * каталог работает как раньше.
 */
export default function ParksStrip() {
  const [parks, setParks] = useState<ParkLite[]>([]);

  useEffect(() => {
    fetch('/api/parks')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { parks?: ParkLite[] } | null) => {
        if (d?.parks?.length) setParks(d.parks);
      })
      .catch(() => {});
  }, []);

  if (parks.length === 0) return null;

  return (
    <div className="mb-5 flex items-center gap-2 overflow-x-auto pb-1">
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] shrink-0">
        <TreePine className="w-3.5 h-3.5 text-[var(--success)]" />
        Парки
      </span>
      {parks.map(p => (
        <Link
          key={p.slug}
          href={`/park/${p.slug}`}
          className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-all duration-200 hover:border-[var(--success)] hover:text-[var(--success)]"
        >
          {p.displayName.replace(/^Природный парк /, '').replace(/[«»]/g, '')}
        </Link>
      ))}
    </div>
  );
}
