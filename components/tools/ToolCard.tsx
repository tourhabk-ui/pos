import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { ArrowRight } from 'lucide-react';

interface ToolCardProps {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  tag: string;
}

export function ToolCard({ href, icon: Icon, title, description, tag }: ToolCardProps) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-4 p-6 md:p-8 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg hover:border-[var(--accent)]/50 transition-colors"
    >
      <div className="flex items-start justify-between">
        <div className="w-12 h-12 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center group-hover:bg-[var(--accent)]/20 transition-colors">
          <Icon size={22} className="text-[var(--accent)]" />
        </div>
        <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--accent)] bg-[var(--accent)]/10 px-2 py-1 rounded">
          {tag}
        </span>
      </div>
      <div className="flex-1">
        <h3 className="font-playfair text-xl font-bold text-[var(--text-primary)] mb-2">{title}</h3>
        <p className="text-[var(--text-secondary)] text-sm font-light leading-relaxed">{description}</p>
      </div>
      <div className="flex items-center gap-2 text-[var(--accent)] text-sm font-bold">
        Открыть
        <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" />
      </div>
    </Link>
  );
}
