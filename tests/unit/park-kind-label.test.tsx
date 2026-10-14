/**
 * Подпись над заголовком карточки парка — по роду территории (14.10).
 *
 * До правки над «Кроноцким заповедником» стояло «Природный парк · Камчатка»:
 * подпись была одна на все записи справочника `parks`. Заповедник, заказник
 * и природный парк — разные режимы охраны, и человек, читающий карточку
 * перед поездкой, должен видеть, куда едет. Судит рендер.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/shared/EmergencyAction', () => ({ EmergencyAction: () => null }));

import ParkClient from '@/app/park/[slug]/_ParkClient';
import { parkKindLabel } from '@/lib/parks/park-kind';
import type { ParkPageData } from '@/lib/parks/park-page';

afterEach(cleanup);

function park(displayName: string): ParkPageData {
  return {
    slug: 'x', displayName, description: null, zone: null, permit_url: null,
    permitChannels: { email: null, officeAddress: null, officeHours: null, gosuslugiUrl: null, onlineUrl: null },
    routes: [], routesFailed: false,
  };
}

describe('род территории по имени справочника', () => {
  it('заповедник, заказник, природный парк', () => {
    expect(parkKindLabel('Кроноцкий заповедник')).toBe('Заповедник');
    expect(parkKindLabel('Южно-Камчатский федеральный заказник')).toBe('Заказник');
    expect(parkKindLabel('Природный парк «Налычево»')).toBe('Природный парк');
  });

  it('на карточке Кроноцкого — «Заповедник · Камчатка», не «Природный парк»', () => {
    render(<ParkClient park={park('Кроноцкий заповедник')} />);
    expect(screen.getByText('Заповедник · Камчатка')).toBeTruthy();
    expect(screen.queryByText('Природный парк · Камчатка')).toBeNull();
  });

  it('у природного парка подпись прежняя', () => {
    render(<ParkClient park={park('Природный парк «Налычево»')} />);
    expect(screen.getByText('Природный парк · Камчатка')).toBeTruthy();
  });
});
