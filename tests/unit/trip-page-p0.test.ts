import { describe, it, expect, vi } from 'vitest';
import { tripPageUrl, runTripRequest } from '@/lib/agent/trip-request';
import { parseTripLine } from '@/components/requests/TripBlock';

describe('P0 trip page', () => {
  it('tripPageUrl keeps keys in the fragment', () => {
    expect(tripPageUrl('TRIP-ABC123', ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'], 'https://x.ru/'))
      .toBe('https://x.ru/trip-request/TRIP-ABC123#aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb');
  });
  it('parseTripLine reads the operator block', () => {
    const t = parseTripLine('[Поездка TRIP-ABC123, 3 чел.] В этой же поездке: тур X 2026-11-05; жильё на подбор 2026-11-05 — 2026-11-08. Звоните');
    expect(t).toEqual({ tripId: 'TRIP-ABC123', people: '3', parts: ['тур X 2026-11-05', 'жильё на подбор 2026-11-05 — 2026-11-08'] });
    expect(parseTripLine('просто комментарий')).toBeNull();
  });

  it('stay match + carrier choice -> ONE manager lead, trip URL', async () => {
    const d = {
      bookTour: vi.fn(async () => 'Заявка создана. Ключ статуса заявки: aaaaaaaaaaaaaaaaaaaa. ok'),
      requestStay: vi.fn(async () => 'x'),
      requestCharter: vi.fn(async () => 'Перевозчиков несколько — укажите, кому адресовать.'),
      createLead: vi.fn(async () => 'Заявка менеджеру создана. Ключ статуса заявки: bbbbbbbbbbbbbbbbbbbb.'),
      confirmNote: 'n',
    };
    const r = await runTripRequest({ name: 'Аня', phone: '+79990000000', consent: true, tour: 't1', tour_date: '2026-11-05', participants: 2,
      stay_wanted: true, check_in: '2026-11-05', check_out: '2026-11-08', transfer_destination: 'город', transfer_date: '2026-11-05' }, d as never);
    expect(d.createLead).toHaveBeenCalledTimes(1);
    expect(d.requestStay).not.toHaveBeenCalled();
    expect(r.tripUrl).toMatch(/\/trip-request\/TRIP-[A-F0-9]{6}#aaaaaaaaaaaaaaaaaaaa\.bbbbbbbbbbbbbbbbbbbb$/);
  });
});
