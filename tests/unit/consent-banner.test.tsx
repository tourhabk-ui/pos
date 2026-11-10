// @vitest-environment jsdom
/**
 * Баннер согласия на трекеры — что видит человек (#3205, 10.11).
 *
 * 09.11 карточку баннера сменила узкая полоса с другим текстом. Браузерная
 * проба на проде искала баннер по прежним словам и покраснела, хотя баннер
 * был на месте; хуже — её вторая проверка («баннер не показан снова») с того
 * дня проходила бы при любом исходе. Проба теперь находит баннер по кнопке
 * отказа, а подпись берёт из `CONSENT_BUTTONS`. Здесь рендером держится то,
 * на что она опирается, и то, что баннер обязан уметь:
 *  - пока человек не ответил, показан диалог с двумя кнопками из источника;
 *  - отказ так же доступен, как согласие, и оба ответа записываются;
 *  - передача данных за пределы России названа словами;
 *  - ответивший баннера больше не видит.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/script', () => ({ default: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import ThirdPartyScripts from '@/components/legal/ThirdPartyScripts';
import { CONSENT_BUTTONS, CONSENT_STORAGE_KEY, CONSENT_VERSION, readConsent } from '@/lib/legal/consent';

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const banner = () => screen.queryByRole('dialog');

describe('баннер согласия: пока человек не ответил', () => {
  it('показан диалог с двумя кнопками, подписи — из источника', () => {
    render(<ThirdPartyScripts />);
    const dialog = banner();
    expect(dialog, 'баннер не показан — спросить человека нечем').not.toBeNull();
    const names = within(dialog!).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual([CONSENT_BUTTONS.accept, CONSENT_BUTTONS.decline]);
    expect(CONSENT_BUTTONS).toEqual({ accept: 'Разрешить', decline: 'Только необходимое' });
  });

  it('передача данных за пределы России названа, подробности — по ссылке на политику', () => {
    render(<ThirdPartyScripts />);
    const dialog = banner()!;
    expect(dialog.textContent).toMatch(/за пределы России/);
    expect(within(dialog).getByRole('link').getAttribute('href')).toBe('/legal/privacy');
  });

  it('у диалога есть имя для экранного диктора', () => {
    render(<ThirdPartyScripts />);
    const dialog = banner()!;
    const label = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    expect(label?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

describe('баннер согласия: ответ', () => {
  it('отказ записывается и баннер уходит', () => {
    render(<ThirdPartyScripts />);
    fireEvent.click(screen.getByRole('button', { name: CONSENT_BUTTONS.decline }));
    expect(banner()).toBeNull();
    expect(readConsent()).toEqual({ state: 'denied', choice: { analytics: false, advertising: false } });
  });

  it('согласие записывается и баннер уходит', () => {
    render(<ThirdPartyScripts />);
    fireEvent.click(screen.getByRole('button', { name: CONSENT_BUTTONS.accept }));
    expect(banner()).toBeNull();
    expect(readConsent()).toEqual({ state: 'granted', choice: { analytics: true, advertising: true } });
  });

  it('ответивший раньше баннера не видит — ни согласившийся, ни отказавшийся', () => {
    for (const choice of [{ analytics: true, advertising: true }, { analytics: false, advertising: false }]) {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ ...choice, at: '2026-11-10T00:00:00.000Z', v: CONSENT_VERSION }));
      render(<ThirdPartyScripts />);
      expect(banner(), JSON.stringify(choice)).toBeNull();
      cleanup();
    }
  });

  it('согласие на прежнюю версию текста не считается — спрашиваем снова', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ analytics: true, advertising: true, at: '2026-01-01T00:00:00.000Z', v: CONSENT_VERSION - 1 }));
    render(<ThirdPartyScripts />);
    expect(banner()).not.toBeNull();
  });
});
