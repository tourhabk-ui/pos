/**
 * GET /api/hub/carrier/rental — кабинет проката на сайте: машины прайса,
 * заявки на прокат и правки на модерации вошедшего владельца карточки.
 *
 * Каждый список читается отдельно и не прочитанный — null, а не пустой:
 * «не загрузилось» и «нет ни одной» — разные ответы (§4.0). Имя и телефон
 * заказчика — его же заявки: заказчик дал согласие на передачу прокатчику.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireCarrier } from '@/lib/transfers/carrier-auth';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { loadCabinetCars, loadCabinetEdits, loadCabinetRequests, WEB_REQUEST_LIMIT } from '@/lib/rental/cabinet-read';
import { loadRentalActor } from '@/lib/rental/web-cabinet';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const actor = await loadRentalActor(carrier.partnerId);
  if (actor.outcome !== 'ok') {
    return NextResponse.json(
      { success: false, error: 'Не удалось прочитать карточку — кабинет проката не открыт. Обновите страницу.' },
      { status: 503 },
    );
  }

  const [cars, requests, edits] = await Promise.all([
    loadCabinetCars(carrier.partnerId),
    loadCabinetRequests(carrier.partnerId, WEB_REQUEST_LIMIT),
    loadCabinetEdits(carrier.partnerId),
  ]);
  const shown = requests.outcome === 'ok' ? requests.rows.slice(0, WEB_REQUEST_LIMIT - 1) : null;

  return NextResponse.json({
    success: true,
    data: {
      partnerName: actor.actor.partnerName,
      canWrite: isRentalPilotSlug(actor.actor.slug),
      cars: cars.outcome === 'ok' ? cars.rows : null,
      requests: shown,
      olderRequests: requests.outcome === 'ok' && requests.rows.length > (shown?.length ?? 0),
      edits: edits.outcome === 'ok' ? edits.rows : null,
    },
  }, { headers: { 'cache-control': 'no-store' } });
}
