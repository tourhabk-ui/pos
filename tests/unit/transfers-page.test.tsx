/**
 * Витрина /transfers — машина целиком под заказ (владелец 13.10: «у нас не
 * правильная логика бронируют целую машину а не место в ней»; до того —
 * «что за поиск в трансфере… не понимаю смысл формы»). Судится рендером:
 *
 *   · мест в поездках на витрине нет — ни формы дат, ни «Найти места», ни
 *     «Мои заказы мест»; модуль мест спрятан, а не удалён;
 *   · перевозчики с прайсом — три исхода: есть / нет — словами / не
 *     прочитались — «сбой, это не значит, что их нет»;
 *   · «как заказать» называет логику целой машины: цена за машину, заявка на
 *     странице перевозчика, подтверждение менеджером, расчёт напрямую;
 *   · шапка — одна строка сути на телефоне, подробности с sm;
 *   · прежние ссылки «места в поездках» (?from&to&seats&trip) открывают ту же
 *     витрину машин.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('@/components/transfers/CharterCard', () => ({
  CharterCard: ({ carrier }: { carrier: { name: string } }) => <article>Карточка: {carrier.name}</article>,
}));
const carriers = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/transfers/charter', () => ({ loadCharterCarriers: () => carriers.load() }));

import { TransfersPage } from '@/components/transfers/TransfersPage';
import TransfersRoute from '@/app/transfers/(list)/page';
import type { CharterState } from '@/lib/transfers/charter-format';

const CHARTER = { state: 'ok', carriers: [{ partnerId: 'p-1', name: 'Шатун' }] } as unknown as CharterState;

describe('витрина: только машина целиком', () => {
  it('перевозчики с прайсом и «как заказать»; мест в поездках, формы дат и моих заказов мест нет', () => {
    const { container } = render(<TransfersPage charter={CHARTER} />);
    expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Машина под заказ', 'Как заказать']);
    expect(screen.getByText('Карточка: Шатун')).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toMatch(/Найти места|Места в поездках|Мои заказы мест|за место/);
  });

  it('«как заказать» — логика целой машины: цена за машину, заявка у перевозчика, менеджер, расчёт напрямую', () => {
    render(<TransfersPage charter={CHARTER} />);
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain('цена за машину целиком');
    // Владелец 14.10: «это сложно получается» — путь к заказу назван кнопкой у строки прайса.
    expect(steps[0]).toContain('Нажмите «Заказать» у направления');
    expect(steps[1]).toContain('заявку на машину на странице перевозчика');
    expect(steps[1]).toContain('направление уже выбрано');
    expect(steps[2]).toContain('Менеджер Ведара подтвердит машину с перевозчиком');
    expect(steps[2]).toContain('через платформу машина не оплачивается');
  });

  it('перевозчиков нет — словами; не прочитались — «сбой, это не значит, что их нет»', () => {
    const { unmount } = render(<TransfersPage charter={{ state: 'ok', carriers: [] }} />);
    expect(screen.getByText('Перевозчиков с прайсом под заказ пока нет.')).toBeTruthy();
    unmount();
    render(<TransfersPage charter={{ state: 'failed' }} />);
    expect(screen.getByText('Не смогли проверить вахтовки под заказ')).toBeTruthy();
    expect(screen.getByText(/Это не значит, что их нет/)).toBeTruthy();
  });

  it('шапка: на телефоне одна строка сути, подробности — только с sm', () => {
    render(<TransfersPage charter={CHARTER} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Трансферы');
    expect(h1.className).toContain('text-[28px]');
    expect(h1.className).not.toMatch(/\bds-h1\b/);
    const lead = h1.nextElementSibling as HTMLElement;
    expect(lead.textContent).toContain('Машина целиком под заказ — по прайсу перевозчика, цена за машину.');
    const more = lead.querySelector('span.hidden') as HTMLElement;
    expect(more.className).toContain('sm:inline');
    expect(more.textContent).toContain('заявку менеджер Ведара подтверждает с перевозчиком');
  });
});

describe('страница: данные и прежние ссылки', () => {
  it('отказ чтения перевозчиков — «не смогли проверить» и строка с кодом в логе, а не «перевозчиков нет»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    carriers.load.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57P01' }));
    render(await TransfersRoute());
    expect(screen.getByText('Не смогли проверить вахтовки под заказ')).toBeTruthy();
    expect(err).toHaveBeenCalledWith('[transfers/charter]', '57P01', 'boom');
    err.mockRestore();
  });

  it('ссылки прежнего вида (?from&to&seats&trip) открывают ту же витрину машин — страница их не читает', async () => {
    carriers.load.mockResolvedValueOnce([{ partnerId: 'p-1', name: 'Шатун' }]);
    expect(TransfersRoute.length).toBe(0);
    render(await TransfersRoute());
    expect(screen.getByText('Карточка: Шатун')).toBeTruthy();
  });
});
