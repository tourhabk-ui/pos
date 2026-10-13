import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { CarrierReviewForm } from '@/components/transfers/CarrierReviewForm';
import { CARRIER_SLUG_RE, findPublicCarrier } from '@/lib/transfers/carrier-reviews';
import { carrierPagePath } from '@/lib/transfers/charter-format';

/**
 * /transfers/[slug]/review — отзыв о перевозчике (миграция 1235; слово
 * владельца 13.10: «делай блок отзывов но логично»).
 *
 * Сюда приводят два пути, и оба доказывают поездку: ссылка менеджера Ведара
 * по заявке на машину (ключ во фрагменте адреса — на сервер он не уходит) и
 * «Мои заказы мест» для того, кто ехал местом в поездке. Без одного из них
 * страница объясняет правило, а не открывает форму.
 *
 * Страница служебная — не индексируется. Перевозчика нет — 404; отказ базы —
 * ошибка страницы, а не «не найден» (§4.0).
 */

export const dynamic = 'force-dynamic';

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const carrier = CARRIER_SLUG_RE.test(slug) ? await findPublicCarrier(slug) : null;
  return {
    title: carrier ? `Отзыв о поездке — ${carrier.name}` : 'Перевозчик не найден',
    robots: { index: false, follow: false },
  };
}

export default async function CarrierReviewPage({ params, searchParams }: {
  params: Promise<Params>;
  searchParams: Promise<{ seat?: string | string[] }>;
}) {
  const { slug } = await params;
  if (!CARRIER_SLUG_RE.test(slug)) notFound();
  const carrier = await findPublicCarrier(slug);
  if (!carrier) notFound();
  const seat = (await searchParams).seat;

  return (
    <div style={{ background: 'var(--bg-primary)' }} className="min-h-screen">
      <Header />
      <main className="max-w-2xl mx-auto px-4 sm:px-6 pt-6 pb-16">
        <nav aria-label="Хлебные крошки" className="flex items-center gap-1 text-[13px] text-[var(--text-secondary)] mb-3 -ml-1">
          <Link href="/transfers" className="inline-flex items-center min-h-[44px] px-1 hover:text-[var(--text-primary)]">Трансферы</Link>
          <ChevronRight className="w-3 h-3" aria-hidden />
          <Link href={carrierPagePath(carrier.slug)} className="inline-flex items-center min-h-[44px] px-1 hover:text-[var(--text-primary)]">{carrier.name}</Link>
        </nav>
        <h1 className="font-playfair text-3xl font-bold text-[var(--text-primary)] mb-2">Отзыв о поездке с «{carrier.name}»</h1>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          Отзыв оставляет только тот, кто ехал, — и под ним будет видно, чем это подтверждено.
        </p>
        <CarrierReviewForm carrierSlug={carrier.slug} carrierName={carrier.name} initialSeat={typeof seat === 'string' ? seat : undefined} />
      </main>
      <Footer />
    </div>
  );
}
