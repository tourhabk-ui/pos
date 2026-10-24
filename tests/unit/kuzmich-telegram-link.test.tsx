/**
 * На /kuzmich ссылка на бота видна человеку, не только в JSON-LD шапки.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

vi.mock('next/image', () => ({
  default: (props: { alt?: string }) => <span role="img" aria-label={props.alt ?? ''} />,
}));

import KuzmichClient from '@/app/kuzmich/_KuzmichClient';
import { KUZMICH_TELEGRAM_URL } from '@/components/shared/KuzmichActions';

afterEach(() => {
  cleanup();
});

describe('/kuzmich', () => {
  it('показывает ссылку на Telegram-бота', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { messages: [] } }) }) as Response));
    Element.prototype.scrollIntoView = () => {};
    render(<KuzmichClient />);
    const link = await screen.findByRole('link', { name: 'Кузьмич в Telegram' });
    expect(link.getAttribute('href')).toBe(KUZMICH_TELEGRAM_URL);
    expect(link.textContent).toContain('Telegram');
  });
});
