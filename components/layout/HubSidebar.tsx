'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, ChevronDown, type LucideIcon } from 'lucide-react';

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
 * Mobile: если есть разделы — сворачиваемый grid-лаунчер (сетка иконок по
 *   разделам); иначе — горизонтальный скролл-бар (как раньше).
 * Активный пункт: accent цвет.
 */
export function HubSidebar({ items, title }: HubSidebarProps) {
  const pathname = usePathname();
  const groups = groupItems(items);
  const hasSections = groups.some(g => g.section);
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const current = items.find(i => isActive(i.href));

  // Закрывать лаунчер при смене страницы
  useEffect(() => { setOpen(false); }, [pathname]);

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

      {/* Mobile */}
      {hasSections ? (
        /* Grid-лаунчер: кнопка-меню + разворачивающаяся сетка иконок по разделам */
        <div className="md:hidden bg-[var(--bg-secondary)] border-b border-[var(--border)]">
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className="w-full flex items-center justify-between px-4 py-3 min-h-[48px] text-sm"
          >
            <span className="flex items-center gap-2 text-[var(--text-primary)] font-medium">
              <Menu className="w-4 h-4 text-[var(--text-secondary)]" />
              {current ? current.label : title}
            </span>
            <ChevronDown className={`w-4 h-4 text-[var(--text-secondary)] transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>

          {open && (
            <div className="px-3 pb-4 pt-1 space-y-4 max-h-[70vh] overflow-y-auto border-t border-[var(--border)]">
              {groups.map((group, gi) => (
                <div key={group.section ?? `mg${gi}`}>
                  {group.section && (
                    <p className="px-1 pt-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      {group.section}
                    </p>
                  )}
                  <div className="grid grid-cols-4 gap-2">
                    {group.items.map(item => {
                      const active = isActive(item.href);
                      const Icon = item.icon;
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={`
                            flex flex-col items-center gap-1.5 p-2 rounded-lg min-h-[72px]
                            text-center transition-colors
                            ${active
                              ? 'bg-[var(--accent-muted)]'
                              : 'hover:bg-[var(--bg-hover)]'
                            }
                          `}
                        >
                          <span className={`flex items-center justify-center w-10 h-10 rounded-full ${active ? 'bg-[var(--accent)]/15' : 'bg-[var(--bg-hover)]'}`}>
                            <Icon className={`w-5 h-5 ${active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`} strokeWidth={1.75} />
                          </span>
                          <span className={`text-[10px] leading-tight ${active ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-secondary)]'}`}>
                            {item.label}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Плоские роли — горизонтальный скролл-бар (как раньше) */
        <nav
          className="
            md:hidden
            flex overflow-x-auto gap-1 p-2
            bg-[var(--bg-secondary)] border-b border-[var(--border)]
            scrollbar-hide
          "
        >
          {items.map(item => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
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
                <Icon className="w-4 h-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      )}
    </>
  );
}
