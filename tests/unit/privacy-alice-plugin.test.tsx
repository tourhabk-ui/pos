/**
 * Политика конфиденциальности: раздел про Алису AI и платформу плагинов
 * Яндекса (#3573, 20.11). Каталог плагинов требует описать, какие данные
 * приходят через плагин, кто их получает, основание и срок хранения.
 *
 * Сторож — рендером обеих страниц (что прочтёт человек) и сверкой сроков,
 * которые раздел называет, с кодом, который их исполняет:
 *  - ссылка черновика — PENDING_REQUEST_TTL_MIN (lib/mcp/pending-request);
 *  - уборка сроков удаляет просроченный черновик (lib/legal/retention-purge);
 *  - журнал обращений обезличивается через TECH_LOG_DAYS.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/components/shared/PageShell', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import PrivacyRu from '@/app/legal/privacy/page';
import PrivacyEn from '@/app/en/legal/privacy/page';
import { PENDING_REQUEST_TTL_MIN } from '@/lib/mcp/pending-request';
import { PURGE_STEPS } from '@/lib/legal/retention-purge';
import { RETENTION_TARGETS, TECH_LOG_DAYS } from '@/lib/legal/retention-census';

function section(Page: () => JSX.Element): { heading: Element | null; text: string; h2InSection5: boolean } {
  const { container } = render(<Page />);
  const heading = container.querySelector('#alice');
  const sec = heading?.closest('section') ?? null;
  // Текст от заголовка раздела до конца его части страницы.
  let text = '';
  for (let n: Element | null = heading; n; n = n.nextElementSibling) text += ` ${n.textContent ?? ''}`;
  return {
    heading,
    text: text.replace(/\s+/g, ' '),
    h2InSection5: /^5\./.test(sec?.querySelector('h2')?.textContent ?? ''),
  };
}

describe('раздел «Алиса AI и платформа плагинов Яндекса»', () => {
  it('у раздела свой якорь #alice внутри раздела 5 — ссылку можно дать в форме каталога', () => {
    const ru = section(PrivacyRu);
    expect(ru.heading?.tagName).toBe('H3');
    expect(ru.heading?.textContent).toMatch(/Алиса AI и платформа плагинов Яндекса/);
    expect(ru.h2InSection5).toBe(true);
    const en = section(PrivacyEn);
    expect(en.heading?.tagName).toBe('H3');
    expect(en.heading?.textContent).toMatch(/Alice AI and the Yandex plugin platform/);
    expect(en.h2InSection5).toBe(true);
  });

  it('называет, что приходит, кто получает, основание и сроки', () => {
    const { text } = section(PrivacyRu);
    expect(text).toContain('https://vedarai.ru/api/mcp');
    expect(text).toContain('Что получает Ведар');
    expect(text).toContain('имя, телефон и комментарий');
    expect(text).toContain('ООО «Яндекс» — ответы Ведара');
    expect(text).toContain('только после того, как вы отправите заявку на странице Ведара');
    expect(text).toContain('Согласие, переданное ИИ-агентом, Ведар не принимает');
    expect(text).toContain('п. 5 ч. 1 ст. 6 152-ФЗ');
    expect(text).toContain('п. 1 ч. 1 ст. 6 152-ФЗ');
    expect(text).toContain('сам IP-адрес не записывается');
  });

  it('срок ссылки черновика — тот, что ставит код; на английской странице — тот же', () => {
    expect(section(PrivacyRu).text).toContain(`ссылка действует ${PENDING_REQUEST_TTL_MIN} минут`);
    expect(section(PrivacyEn).text).toContain(`the link is valid for ${PENDING_REQUEST_TTL_MIN} minutes`);
  });

  it('«ежедневной уборкой» — правда: просроченный черновик удаляет уборка сроков', () => {
    expect(RETENTION_TARGETS.find((t) => t.table === 'mcp_pending_requests'))
      .toMatchObject({ column: 'expires_at', term: 'own_expiry', days: 0 });
    expect(PURGE_STEPS.find((s) => s.table === 'mcp_pending_requests'))
      .toMatchObject({ column: 'expires_at', days: 0, action: { kind: 'delete' } });
  });

  it('журнал обращений: срок обезличивания — общий срок технических логов', () => {
    expect(section(PrivacyRu).text).toContain(`Через ${TECH_LOG_DAYS} дней хэш и значение параметра стираются`);
    expect(section(PrivacyEn).text).toContain(`After ${TECH_LOG_DAYS} days the hash and the parameter value are erased`);
    const log = PURGE_STEPS.find((s) => s.table === 'mcp_tool_calls');
    expect(log?.action).toMatchObject({ kind: 'anonymize', nullable: expect.arrayContaining(['caller_hash', 'arg_value']) });
    expect(PURGE_STEPS.find((s) => s.table === 'mcp_clients')?.action.kind).toBe('delete');
  });
});
