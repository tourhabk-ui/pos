'use client';

/**
 * MobileExploreTile — быстрые ссылки на разделы, до которых раньше не было
 * пути с мобильной главной: маркетплейс, AI-конструктор маршрута (/planner —
 * не путать с /planning, live-трекингом похода на который ведёт нижний нав),
 * избранное. Одинаков для гостя и авторизованного — это навигация, не
 * персональные данные, auth-ветвление не нужно (/hub/tourist/wishlist сам
 * уводит разлогиненного на /auth/login через <Protected>).
 */

import Link from 'next/link';
import { ShoppingBag, Route, Heart } from 'lucide-react';

const EXPLORE_LINKS = [
  { icon: ShoppingBag, label: 'Маркетплейс', href: '/marketplace' },
  { icon: Route,       label: 'Собрать маршрут', href: '/planner' },
  { icon: Heart,       label: 'Избранное', href: '/hub/tourist/wishlist' },
] as const;

export function MobileExploreTile() {
  return (
    <div className="col-span-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <span className="font-playfair text-lg font-bold text-[var(--text-primary)]">Исследовать</span>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {EXPLORE_LINKS.map(({ icon: Icon, label, href }) => (
          <Link
            key={label}
            href={href}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-hover)] px-4 py-2 text-sm text-[var(--text-primary)] transition-all duration-200 active:scale-95"
          >
            <Icon size={15} strokeWidth={1.5} aria-hidden />
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}
