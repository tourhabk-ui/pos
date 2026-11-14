/**
 * «Анализатор безопасности» (/tools/safety): номер 112 стоит в результате при
 * любом ответе модели (14.11).
 *
 * Блок «ЧС» на этом экране пишет модель. До 14.11 другого упоминания
 * экстренного номера в результате не было: модель промолчала или написала
 * своё — и человек, читающий оценку риска, номера не видел. Строка 112 берётся
 * из единого источника (lib/safety/emergency-numbers) и от модели не зависит.
 *
 * Судится рендером экрана: нажатие «GPS» → ответ сервера → что видит человек.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/lib/geo/current-position', () => ({
  geolocationOnce: () => ({
    getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) =>
      ok({ coords: { latitude: 53.02, longitude: 158.65 } }),
  }),
}));

import { SafetyClient } from '@/app/tools/safety/_SafetyClient';
import { EMERGENCY_PRIMARY } from '@/lib/safety/emergency-numbers';

function serverAnswers(data: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: {
      placeId: 'p1', placeName: 'Халактырский пляж', placeType: 'coast', altitudeM: null,
      hazards: [], nearestMedicalKm: null, satCommunicator: false, registrationRequired: false,
      realtime: null, riskScore: null, kuzmichAssessment: null, recommendations: [], emergencyTip: null,
      ...data,
    },
  }), { status: 200 })) as typeof fetch;
}

async function openResult(): Promise<void> {
  render(<SafetyClient />);
  fireEvent.click(screen.getByTitle('Использовать моё местоположение'));
  await screen.findByText('Халактырский пляж');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('112 в результате — из единого источника', () => {
  it('модель промолчала (блока «ЧС» нет) — строка 112 есть, и по ней можно позвонить', async () => {
    serverAnswers({});
    await openResult();
    expect(screen.queryByText('ЧС')).toBeNull();
    const call = screen.getByRole('link', { name: /Экстренный вызов — 112/ });
    expect(call.getAttribute('href')).toBe('tel:112');
  });

  it('модель написала в «ЧС» свой номер — строка 112 всё равно стоит отдельно', async () => {
    serverAnswers({ emergencyTip: 'Звоните спасателям по номеру 23-53-62.' });
    await openResult();
    expect(screen.getByText('ЧС')).toBeTruthy();
    const call = screen.getByRole('link', { name: /Экстренный вызов — 112/ });
    expect(call.getAttribute('href')).toBe('tel:112');
  });

  it('слова строки — из источника: номер, служба и подсказка', async () => {
    serverAnswers({});
    await openResult();
    const call = screen.getByRole('link', { name: /Экстренный вызов/ });
    expect(call.textContent).toContain(EMERGENCY_PRIMARY.phone);
    expect(call.textContent).toContain(EMERGENCY_PRIMARY.name);
    expect(call.textContent).toContain(EMERGENCY_PRIMARY.hint ?? '');
  });
});
