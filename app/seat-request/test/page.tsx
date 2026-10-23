/**
 * /seat-request/test?tour=<id> — форма запроса мест по туру тестового стенда
 * (lib/seat-requests/test-stand, 24.10). Только тур тестового оператора;
 * любой другой — 404. В поиск не идёт.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pool } from '@/lib/db-pool';
import { TEST_STAND_PARTNER_IDS } from '@/lib/seat-requests/test-stand';
import { TestStandForm } from './_TestStandForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Тестовый запрос мест',
  robots: { index: false, follow: false },
};

export default async function Page({ searchParams }: { searchParams: Promise<{ tour?: string }> }) {
  const raw = (await searchParams).tour ?? '';
  if (!/^\d{1,9}$/.test(raw)) notFound();
  let tour: { id: string; title: string; season_start: string | null; season_end: string | null } | undefined;
  try {
    ({ rows: [tour] } = await pool.query<{ id: string; title: string; season_start: string | null; season_end: string | null }>(
      `SELECT id::text, title, season_start::text, season_end::text
         FROM operator_tours
        WHERE id = $1 AND is_active = true AND deleted_at IS NULL AND operator_id = ANY($2::uuid[])`,
      [Number(raw), TEST_STAND_PARTNER_IDS],
    ));
  } catch {
    tour = undefined;
  }
  if (!tour) notFound();
  const window = tour.season_start && tour.season_end ? { from: tour.season_start, to: tour.season_end } : null;
  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-2 text-xl font-semibold">Тестовый запрос мест</h1>
      <p className="mb-4 text-sm opacity-80">Тур тестового стенда, на сайте его нет. Запрос уйдёт тестовому оператору.</p>
      <TestStandForm tour={{ id: tour.id, title: tour.title }} seasonWindow={window} />
    </main>
  );
}
