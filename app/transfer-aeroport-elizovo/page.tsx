/** Посадочная под запрос «трансфер аэропорт Елизово» — lib/seo/query-landings (ru-transfer). */
import { Header } from '@/components/layout/Header';
import { QueryLandingView } from '@/components/seo/QueryLanding';
import { landingByKey } from '@/lib/seo/query-landings';
import { landingMetadata } from '@/lib/seo/query-landing-meta';
import { loadCharterCarriers, type CharterState } from '@/lib/transfers/charter';

export const dynamic = 'force-dynamic';

const LANDING = landingByKey('ru-transfer');

export const metadata = landingMetadata(LANDING);

/**
 * Трансфер — машина целиком под заказ (CLAUDE.md §14): страница показывает
 * перевозчиков с их прайсом тем же загрузчиком, что /transfers. Отказ базы —
 * «не загрузился» на экране и SQLSTATE в лог, а не пустой список (§4.0).
 */
export default async function Page() {
  let charter: CharterState;
  try {
    charter = { state: 'ok', carriers: await loadCharterCarriers() };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? '';
    console.error('[query-landing/transfer]', code, err instanceof Error ? err.message : err);
    charter = { state: 'failed' };
  }
  return (
    <>
      <Header />
      <QueryLandingView landing={LANDING} tours={[]} charter={charter} />
    </>
  );
}
