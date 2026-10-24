/**
 * Кузьмич из корневого layout не едет в кабинет и в чужой iframe.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

const path = vi.hoisted(() => ({ value: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => path.value,
}));

vi.mock('@/components/kuzmich/KuzmichWidget', () => ({
  default: () => <div>кузьмич</div>,
}));

import HubKuzmich from '@/components/kuzmich/HubKuzmich';

describe('HubKuzmich', () => {
  it('в кабинете и в виджете кнопки нет, на витрине есть', () => {
    path.value = '/hub/operator/tours/new';
    const cabinet = render(<HubKuzmich />);
    expect(screen.queryByText('кузьмич')).toBeNull();
    cabinet.unmount();

    path.value = '/widget/fishingkam';
    const widget = render(<HubKuzmich />);
    expect(screen.queryByText('кузьмич')).toBeNull();
    widget.unmount();

    path.value = '/catalog';
    render(<HubKuzmich />);
    expect(screen.getByText('кузьмич')).toBeTruthy();
  });
});
