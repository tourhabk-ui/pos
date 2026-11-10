/**
 * Строка о возвращении на карточке маршрута — рендером (ревью PR 3188).
 *
 * О сообщении в МЧС после возвращения забывают чаще всего, и цена — поиск.
 * Поэтому строка обязана быть видна сразу, а не под раскрытием «Как подать
 * заявку»: свёрнутый `<details>` человек с телефоном не откроет.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MchsRegistrationBlock from '@/components/safety/MchsRegistrationBlock';
import { MCHS_AFTER_RETURN, MCHS_DEADLINE_SHORT, MCHS_SOURCE } from '@/lib/safety/mchs-registration';

describe('блок регистрации МЧС на карточке маршрута', () => {
  it('строка о возвращении видна сразу — вне раскрытия', () => {
    render(<MchsRegistrationBlock formHref="/register" />);
    const line = screen.getByText(MCHS_AFTER_RETURN);
    expect(line.closest('details')).toBeNull();
    // Срок — тоже на виду, а каналы и состав данных остаются под раскрытием.
    expect(screen.getByText(MCHS_DEADLINE_SHORT).closest('details')).toBeNull();
    expect(screen.getByText(/Как подать заявку и что указать/).closest('details')).not.toBeNull();
  });

  it('источник назван датой памятки, а не месяцем чтения', () => {
    const { container } = render(<MchsRegistrationBlock formHref="/register" />);
    expect(container.textContent).toContain(`Источник: ${MCHS_SOURCE.authority}, ${MCHS_SOURCE.asOf}`);
    expect(container.textContent).toContain('памятка от 13.06.2024');
  });

  it('несверенных телефонов в блоке нет: звонок — только по номеру из записи маршрута', () => {
    const { container } = render(<MchsRegistrationBlock formHref="/register" />);
    expect(container.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/30-10-82/);
  });
});
