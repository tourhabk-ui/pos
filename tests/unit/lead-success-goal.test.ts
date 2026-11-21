// @vitest-environment jsdom
/**
 * Цель Метрики «Заявка отправлена» (`lead_success`): уходит только после
 * ответа сервера «заявка записана», без персональных данных и не с экранов,
 * которые счётчик видеть не должен. Плюс ссылка футера на канал.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { trackLeadSuccess, LEAD_EVENTS } from '@/lib/analytics/lead-tracking';
import { METRIKA_ID } from '@/lib/analytics/metrika';

const read = (p: string) => readFileSync(p, 'utf8');

describe('trackLeadSuccess', () => {
  let ym: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    ym = vi.fn();
    (window as unknown as { ym: unknown }).ym = ym;
    window.history.replaceState(null, '', '/request');
  });

  it('шлёт reachGoal lead_success с источником и номером тура — и только ими', () => {
    window.history.replaceState(null, '', '/catalog/tours/zaporozhets-vulkan-gorelyy');
    trackLeadSuccess('booking_form', 42);
    expect(ym).toHaveBeenCalledTimes(1);
    const [id, method, name, params] = ym.mock.calls[0];
    expect(id).toBe(METRIKA_ID);
    expect(method).toBe('reachGoal');
    expect(name).toBe(LEAD_EVENTS.LEAD_SUCCESS.event_name);
    expect(name).toBe('lead_success');
    const defined = Object.fromEntries(Object.entries(params as Record<string, unknown>).filter(([, v]) => v !== undefined));
    expect(defined).toEqual({ category: 'conversion', source: 'booking_form', route_id: '42' });
  });

  it('без номера тура route_id не уходит', () => {
    trackLeadSuccess('request_page');
    const params = ym.mock.calls[0][3] as Record<string, unknown>;
    expect(params.route_id).toBeUndefined();
    expect(params.source).toBe('request_page');
  });

  it('с исключённых путей (/hub, /booking-success) цель не уходит', () => {
    for (const p of ['/hub/tourist/cart/checkout', '/booking-success/5']) {
      window.history.replaceState(null, '', p);
      trackLeadSuccess('kuzmich_widget', 1);
    }
    expect(ym).not.toHaveBeenCalled();
  });

  it('нет ym (нет согласия) — ничего не падает', () => {
    delete (window as unknown as { ym?: unknown }).ym;
    expect(() => trackLeadSuccess('request_page')).not.toThrow();
  });
});

describe('вызовы стоят после успешного ответа сервера', () => {
  it('/request — только при res.ok', () => {
    expect(read('app/request/_RequestClient.tsx')).toMatch(/if \(res\.ok\) trackLeadSuccess\('request_page'\);/);
  });

  it('форма брони — после проверки id и перед переходом на /booking-success', () => {
    const src = read('components/marketplace/BookingFormClient.tsx');
    const call = src.indexOf("trackLeadSuccess('booking_form', tourId)");
    expect(call).toBeGreaterThan(src.indexOf("if (!id) throw new Error("));
    expect(call).toBeLessThan(src.indexOf('router.push(`/booking-success/'));
    expect(call).toBeGreaterThan(src.indexOf('if (!res.ok) {'));
  });

  it('виджет Кузьмича — после if (!res.ok) throw', () => {
    const src = read('components/kuzmich/KuzmichWidget.tsx');
    const call = src.indexOf("trackLeadSuccess('kuzmich_widget', data.tourId)");
    expect(call).toBeGreaterThan(src.indexOf("if (!res.ok) throw new Error(json.error"));
  });

  it('в параметры цели не передаются имя, телефон, почта, номер брони', () => {
    for (const f of ['app/request/_RequestClient.tsx', 'components/marketplace/BookingFormClient.tsx', 'components/kuzmich/KuzmichWidget.tsx']) {
      for (const m of read(f).matchAll(/trackLeadSuccess\(([^)]*)\)/g)) {
        expect(m[1]).not.toMatch(/name|phone|email|token|\bid\b/i);
      }
    }
  });
});

describe('футер', () => {
  it('Telegram-канал — t.me/kamchatka_real, старого kamchatourhub нет', () => {
    const footer = read('components/layout/Footer.tsx');
    expect(footer).toContain('ORGANIZATION_PROFILES.telegramChannel');
    expect(footer).toContain('ORGANIZATION_PROFILES.telegramSupport');
    expect(footer).toContain('ORGANIZATION_PROFILES.maxChannel');
    expect(footer).toContain('@kuzmichai_bot');
    expect(footer).not.toMatch(/kamchatourhub/);
  });
});
