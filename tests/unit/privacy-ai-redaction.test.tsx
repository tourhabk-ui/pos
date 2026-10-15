/**
 * Политика конфиденциальности говорит о внешних моделях правду (аудит 15.10,
 * W2-5).
 *
 * Прежний абзац обещал: «Имя, телефон и иные прямые идентификаторы во внешний
 * сервис не передаются». Код при этом отправлял текст туриста в зарубежные
 * модели как есть. Теперь чат Кузьмича режет телефон и почту на границе
 * (kuzmich-pii-boundary.test.ts), а имя по тексту не распознаётся — и
 * политика говорит ровно это.
 *
 * Сторож — рендером страницы: что прочтёт человек.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/components/shared/PageShell', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import PrivacyPage from '@/app/legal/privacy/page';

function pageText(): string {
  const { container } = render(<PrivacyPage />);
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

describe('политика о внешних AI-сервисах', () => {
  it('говорит, что телефоны и почта из сообщений Кузьмичу удаляются до отправки', () => {
    const text = pageText();
    expect(text).toContain('автоматически удаляются номера телефонов и адреса электронной почты');
    expect(text).toContain('на сайте, в Telegram и MAX, в окне чата на сайте партнёра');
  });

  it('не обещает того, чего код не делает: имя не распознаётся и может уйти', () => {
    const text = pageText();
    expect(text).toContain('Имя и другие сведения о себе, написанные словами, эта чистка не распознаёт');
    expect(text).not.toContain('Имя, телефон и иные прямые идентификаторы во внешний сервис не передаются');
  });
});
