/**
 * Карточка маршрута: дверь в контроль возвращения одна — форма `/register`.
 *
 * До 10.11 кнопка «Заполнить заявку» открывала своё окно. Оно писало в
 * контроль выхода, не говоря об этом, ставило возвращение «через три дня» и не
 * давало ссылки «Я вернулся» — человек получал тревогу своему контакту
 * (docs/safety/MCHS_PLAN.md, С2). Проверяется рендером.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('карточка маршрута — дверь одна', () => {
  it('кнопка ведёт на /register с маршрутом и говорит, кто подаёт заявку', async () => {
    const { default: MchsRegistrationBlock } = await import('@/components/safety/MchsRegistrationBlock');
    const { MCHS_WHO_SUBMITS } = await import('@/lib/safety/mchs-chat');
    render(<MchsRegistrationBlock formHref="/register?name=%D0%93%D0%BE%D1%80%D0%B5%D0%BB%D1%8B%D0%B9" />);
    const link = screen.getByRole('link', { name: /Собрать данные для заявки/ });
    expect(link.getAttribute('href')).toBe('/register?name=%D0%93%D0%BE%D1%80%D0%B5%D0%BB%D1%8B%D0%B9');
    expect(screen.queryByRole('button', { name: /Заполнить заявку/ })).toBeNull();
    expect(document.body.textContent).toContain(MCHS_WHO_SUBMITS);
    cleanup();
  });

  it('своего окна с записью в контроль больше нет', () => {
    expect(() => statSync(join(ROOT, 'components/safety/MchsRegistrationModal.tsx'))).toThrow();
    expect(read('app/routes/[id]/_RouteDetailClient.tsx')).not.toMatch(/MchsRegistrationModal/);
  });
});
