import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { PartnerConsentForm } from '@/components/partners/PartnerConsentForm';

/**
 * /partner-consent — партнёр подписывает согласие на использование
 * материалов своего сайта на Ведаре (миграция 1321, решение владельца 23.10).
 *
 * Сюда приводит одноразовая ссылка менеджера Ведара (ключ во фрагменте
 * адреса — на сервер он не уходит). Без неё страница объясняет, как получить
 * ссылку, а не открывает форму. Страница служебная — не индексируется.
 */

export const metadata: Metadata = {
  title: 'Согласие партнёра на использование материалов',
  robots: { index: false, follow: false },
};

export default function PartnerConsentPage() {
  return (
    <div style={{ background: 'var(--bg-primary)' }} className="min-h-screen">
      <Header />
      <main className="max-w-2xl mx-auto px-4 sm:px-6 pt-6 pb-16">
        <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)] mb-2">Для партнёров Ведара</p>
        <h1 className="font-playfair text-3xl font-bold text-[var(--text-primary)] mb-2">Согласие на использование материалов</h1>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          Ведар рассказывает туристам о вашем деле вашими же словами и снимками — только с вашего согласия. Здесь вы видите,
          что именно разрешаете, и выбираете, где это можно показывать.
        </p>
        <PartnerConsentForm />
      </main>
      <Footer />
    </div>
  );
}
