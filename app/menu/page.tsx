/**
 * /menu — «Ещё»: вся платформа с телефона за одно касание из шапки.
 *
 * Повод (владелец, 02.09): футер был единственной дорогой к половине
 * платформы на телефоне, и его находили случайно — он вмонтирован не везде,
 * а таб-бар несёт пять пунктов. Эта страница читает тот же реестр, что и
 * футер (lib/navigation/platform-links), и ничего не знает сама: пункт,
 * добавленный в реестр, появляется здесь и в футере одним движением.
 *
 * Сторож mobile-two-taps: каждая публичная страница из sitemap достижима
 * с телефона за два касания — таб-бар, шапка или эта страница.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import EmergencyAction from '@/components/shared/EmergencyAction';
import { PLATFORM_SECTIONS } from '@/lib/navigation/platform-links';

export const metadata: Metadata = {
  title: 'Ещё — вся платформа Ведар',
  description: 'Все разделы Ведара: безопасность и связь на маршруте, туры и планы поездки, места, маршруты, карта, помощь и документы.',
  robots: { index: false, follow: true },
};

export default function MenuPage() {
  return (
    <div className="ds-page" style={{ paddingBottom: 96 }}>
      <Header />

      <main className="mx-auto max-w-2xl px-5 pt-6">
        {/* SOS — общий EmergencyAction рядом с заголовком, как на /safety:
            своей кнопки у экрана нет (#887, сторож sos-always-reachable). */}
        <div className="flex items-start justify-between gap-3 mb-8">
          <div>
            <p className="ds-label mb-2">Ведар</p>
            <h1 className="ds-h1 mb-2">Вся платформа</h1>
            <p className="text-sm text-[var(--text-secondary)] max-w-md">
              Всё, что не поместилось в таб-бар. Разделы те же, что в подвале на компьютере.
            </p>
          </div>
          <EmergencyAction />
        </div>

        <div className="flex flex-col gap-6">
          {PLATFORM_SECTIONS.map((section) => (
            <section key={section.id} className="ds-section" style={{ padding: '1rem 0.5rem' }}>
              <h2 className="ds-label px-3 mb-1">{section.title}</h2>
              <ul>
                {section.links.map((link) => {
                  const Icon = link.icon;
                  return (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="flex items-center gap-3 rounded-lg px-3 text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-200"
                        style={{ minHeight: 44 }}
                      >
                        <Icon size={16} className="shrink-0 text-[var(--ocean)]" aria-hidden />
                        <span className="text-[15px]">{link.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        <p className="text-xs text-[var(--text-muted)] mt-8">
          Экстренная помощь всегда рядом: красная кнопка SOS в шапке на каждом экране.
        </p>
      </main>

      <BottomNav activePath="/menu" />
    </div>
  );
}
