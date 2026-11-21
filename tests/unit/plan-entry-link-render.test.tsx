// @vitest-environment jsdom
/**
 * «Собрать план» рендером (21.11): пока вход не проверен и у гостя — ссылка в
 * чат Кузьмича с готовым вопросом; вошедшему — /planner.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

let authed: boolean | null = false;
vi.mock('@/lib/auth/session-state', () => ({ sessionState: vi.fn(async () => authed) }));

import { PlanEntryLink } from '@/components/planner/PlanEntryLink';
import { planEntryHref } from '@/lib/planner/plan-entry';

afterEach(cleanup);

describe('PlanEntryLink', () => {
  it('гость — чат Кузьмича', async () => {
    authed = false;
    render(<PlanEntryLink>Собрать план</PlanEntryLink>);
    const link = screen.getByRole('link', { name: 'Собрать план' });
    expect(link.getAttribute('href')).toBe(planEntryHref(null));
    await waitFor(() => expect(link.getAttribute('href')).toBe(planEntryHref(false)));
    expect(link.getAttribute('href')?.startsWith('/kuzmich?ask=')).toBe(true);
  });

  it('вошедший — планер', async () => {
    authed = true;
    render(<PlanEntryLink>Собрать план</PlanEntryLink>);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Собрать план' }).getAttribute('href')).toBe('/planner'));
  });
});
