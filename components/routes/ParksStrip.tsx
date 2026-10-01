'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { TreePine } from 'lucide-react';

import type { ParkLite } from '@/lib/parks/list';

/**
 * Полоса-навигация по природным паркам.
 * Список приходит с сервера (`initialParks`), чтобы ссылки были в первом
 * HTML: собранная в браузере полоса была единственным входом на карточки
 * парков, и обход сайта не находил их ни с одной страницы (аудит 01.10).
 * `null` — сервер не прочитал список, тогда спрашиваем GET /api/parks.
 * Пустой список или отказ — не рендерится ничего, каталог работает как раньше.
 */
export default function ParksStrip({ initialParks = null }: { initialParks?: ParkLite[] | null }) {
  const [parks, setParks] = useState<ParkLite[]>(initialParks ?? []);

  useEffect(() => {
    if (initialParks !== null) return;
    fetch('/api/parks')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { parks?: ParkLite[] } | null) => {
        if (d?.parks?.length) setParks(d.parks);
      })
      .catch((err: unknown) => {
        console.error('[ParksStrip] список парков не получен:', err instanceof Error ? err.message : String(err));
      });
  }, [initialParks]);

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
