'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type LucideIcon } from 'lucide-react';

interface SidebarItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Раздел меню. Пункты с одинаковым section группируются под заголовком.
      Если ни у одного пункта нет section — меню плоское (как раньше). */
  section?: string;
}

interface HubSidebarProps {
  items: SidebarItem[];
  title: string;
}

// Группирует пункты в порядке следования: подряд идущие с одним section — в одну
// группу. Обратная совместимость: без section получается одна группа без заголовка.
function groupItems(items: SidebarItem[]): Array<{ section?: string; items: SidebarItem[] }> {
  const groups: Array<{ section?: string; items: SidebarItem[] }> = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    if (last && last.section === it.section) last.items.push(it);
    else groups.push({ section: it.section, items: [it] });
  }
  return groups;
}

/**
 * HubSidebar -- боковая навигация для hub-разделов.
 * Desktop: вертикальный sidebar слева, разделы с заголовками.
 * Mobile: горизонтальный скролл-бар сверху, разделы с метками-разделителями.
 * Активный пункт: accent цвет + бордер справа.
 */
export function HubSidebar({ items, title }: HubSidebarProps) {
  const pathname = usePathname();
  const groups = groupItems(items);
  const hasSections = groups.some(g => g.section);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className="
          hidden md:flex flex-col w-60 shrink-0
          bg-[var(--bg-secondary)] border-r border-[var(--border)]
          min-h-full
        "
      >
        <div className="p-4 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
        </div>

        <nav className="flex-1 p-2 space-y-0.5">
          {groups.map((group, gi) => (
            <div key={group.section ?? `g${gi}`} className={gi > 0 && group.section ? 'pt-3' : undefined}>
              {group.section && (
                <p className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {group.section}
                </p>
              )}
              <div className="space-y-0.5">
                {group.items.map(item => {
                  const active = isActive(item.href);
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`
                        flex items-center gap-3 px-3 py-2.5
                        rounded-[var(--radius-sm)]
                        text-sm transition-colors duration-200
                        min-h-[44px]
                        ${active
                          ? 'bg-[var(--accent-muted)] text-[var(--accent)] border-r-2 border-[var(--accent)]'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                        }
                      `}
                    >
                      <Icon className="w-5 h-5 shrink-0" />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* Mobile: горизонтальная навигация с метками разделов */}
      <nav
        className="
          md:hidden
          flex overflow-x-auto gap-1 p-2 items-center
          bg-[var(--bg-secondary)] border-b border-[var(--border)]
          scrollbar-hide
        "
      >
        {groups.map((group, gi) => (
          <div key={group.section ?? `mg${gi}`} className="flex items-center gap-1 shrink-0">
            {hasSections && group.section && (
              <span className="flex items-center gap-1 pl-2 pr-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] shrink-0 border-l border-[var(--border)] first:border-l-0">
                {group.section}
              </span>
            )}
            {group.items.map(item => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={item.label}
                  title={item.label}
                  className={`
                    flex items-center gap-1.5 px-3 py-2
                    rounded-[var(--radius-sm)]
                    text-sm whitespace-nowrap shrink-0
                    min-h-[44px]
                    transition-colors duration-200
                    ${active
                      ? 'bg-[var(--accent-muted)] text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    }
                  `}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}
