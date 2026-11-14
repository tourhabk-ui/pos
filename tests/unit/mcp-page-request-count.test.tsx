/**
 * Страница /mcp называет число заявок так же, как сервер (14.11).
 *
 * Внешний разбор 14.11: в разделе A2A стояло «Заявки те же четыре», а
 * инструкции initialize, раздел OpenAPI и китайское описание — «шесть», и
 * реестр пишущих инструментов — шесть. A2A зовёт тот же реестр
 * (runPublicTool). Судится отрисованная страница, а не исходник.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

import McpLandingPage from '@/app/mcp/page';
import { WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { requestCountClaims } from '@/lib/mcp/sister-repos';

afterEach(cleanup);

describe('/mcp: число заявок', () => {
  it('каждое названное на странице число заявок — число пишущих инструментов реестра', () => {
    const { container } = render(<McpLandingPage />);
    const text = container.textContent ?? '';
    const claims = requestCountClaims(text);
    expect(claims.length, 'страница не называет число заявок вовсе').toBeGreaterThan(0);
    expect([...new Set(claims)]).toEqual([WRITE_TOOL_NAMES.size]);
  });

  it('«заявки те же четыре» узнаётся как число заявок', () => {
    expect(requestCountClaims('Заявки те же четыре, подтверждает человек.')).toEqual([4]);
  });

  it('строка возможностей называет прокат машин и снаряжения', () => {
    const { container } = render(<McpLandingPage />);
    expect(container.textContent).toMatch(/Возможности:[^.]*прокат машин без водителя и снаряжения/);
  });
});
