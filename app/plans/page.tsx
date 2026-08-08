/**
 * /plans — хаб готовых планов («Мой план 2.0», A-1).
 * Внутренняя перелинковка программатик-страниц + вход в живой планировщик.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { PLAN_PRESETS } from '@/lib/plans/presets';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Готовые планы поездок на Камчатку — с турами и ценами',
  description: 'Готовые маршруты по Камчатке на 5, 7, 10 и 14 дней: вулканы, рыбалка, медведи, океан. Каждый план ведёт к брони реальных туров.',
  alternates: { canonical: `${SITE}/plans` },
};

const DAY_GROUPS = [5, 7, 10, 14] as const;

export default function PlansHubPage() {
  return (
    <>
      <Header />
      <main className="ds-page">
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
          <header className="space-y-3">
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Готовые планы поездок
            </h1>
            <p className="text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Каждый план собран движком платформы из реальных данных: точки, сезонность, честная
              занятость туров. Открывайте, смотрите по дням — и бронируйте, или пересоберите под
              себя в планировщике.
            </p>
          </header>

          {DAY_GROUPS.map((n) => {
            const group = PLAN_PRESETS.filter((p) => p.days === n);
            if (group.length === 0) return null;
            return (
              <section key={n} className="space-y-3">
                <h2 className="ds-h2">{n} дней</h2>
                <div className="space-y-2">
                  {group.map((p) => (
                    <Link key={p.slug} href={`/plans/${p.slug}`} className="ds-card block p-4">
                      <div className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{p.title}</div>
                      <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{p.description}</div>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}

          <section className="ds-card p-6 text-center space-y-3">
            <h2 className="font-playfair text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Нужен план под ваши даты?
            </h2>
            <Link href="/planner" className="ds-btn ds-btn-primary inline-flex px-6 py-3">
              Открыть планировщик
            </Link>
          </section>
        </div>
      </main>
    </>
  );
}
