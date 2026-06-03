import type { Metadata } from 'next';
import { Backpack, ShieldCheck } from 'lucide-react';
import { ToolCard } from '@/components/tools/ToolCard';

export const metadata: Metadata = {
  title: 'Инструменты путешественника — Ведар',
  description: 'Бесплатные AI-утилиты для подготовки к поездке на Камчатку: чек-лист снаряжения и анализатор безопасности.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/tools' },
};

const TOOLS = [
  {
    href: '/tools/equipment',
    icon: Backpack,
    title: 'Чек-лист снаряжения',
    description: 'Укажи маршрут и дату — Кузьмич составит персональный список вещей с учётом сезона и сложности маршрута.',
    tag: 'Бесплатно',
  },
  {
    href: '/tools/safety',
    icon: ShieldCheck,
    title: 'Анализатор безопасности',
    description: 'Введи название места — получи реальную оценку рисков, актуальный статус и рекомендации для туриста.',
    tag: 'Бесплатно',
  },
] as const;

export default function ToolsPage() {
  return (
    <section className="py-20 bg-[var(--bg-primary)]">
      <div className="container mx-auto px-6 max-w-4xl">
        <div className="mb-12">
          <span className="text-[var(--accent)] font-bold tracking-[0.4em] uppercase text-[10px] mb-4 inline-block">
            Мини-инструменты
          </span>
          <h1 className="font-playfair text-4xl md:text-6xl font-bold leading-tight text-[var(--text-primary)]">
            Инструменты <br />
            <span className="text-[var(--accent)] italic">путешественника</span>
          </h1>
          <p className="text-[var(--text-secondary)] mt-4 text-lg font-light max-w-2xl">
            Быстрые AI-утилиты для подготовки к поездке. Без регистрации, бесплатно.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {TOOLS.map(tool => (
            <ToolCard key={tool.href} {...tool} />
          ))}
        </div>
      </div>
    </section>
  );
}
