import React from 'react';
import Link from 'next/link';
import { Users, Compass } from 'lucide-react';

export function LiveOnTrails() {
  return (
    <div className="px-4 pb-4 grid grid-cols-2 gap-3">
      <Link
        href="/routes"
        className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--accent)]/40 transition-colors"
      >
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'color-mix(in srgb, var(--accent) 15%, var(--bg-primary))' }}>
          <Users size={15} className="text-[var(--accent)]" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-[var(--text-primary)] leading-tight">12 человек</p>
          <p className="text-[10px] text-[var(--text-muted)]">сейчас на маршрутах</p>
        </div>
      </Link>

      <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border)]">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'color-mix(in srgb, var(--ocean) 15%, var(--bg-primary))' }}>
          <Compass size={15} className="text-[var(--ocean)]" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-[var(--text-primary)] leading-tight">Исследователь</p>
          <p className="text-[10px] text-[var(--text-muted)]">Ваш стиль</p>
        </div>
      </div>
    </div>
  );
}
