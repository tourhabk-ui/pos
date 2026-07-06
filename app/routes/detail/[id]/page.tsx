import { redirect } from 'next/navigation';

/**
 * Каноническая карточка маршрута — /routes/[id] (SEO, ISR, JSON-LD, GPX,
 * бронирование). Параллельная реализация (_RouteCardClient) объединена с ней;
 * старый URL оставлен как редирект, чтобы не умирали внешние ссылки.
 */
export default async function RouteCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/routes/${id}`);
}
