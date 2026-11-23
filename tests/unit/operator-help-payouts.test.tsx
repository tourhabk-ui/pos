// @vitest-environment jsdom
/**
 * Справка в кабинете оператора не зовёт к выплатам, которых нет (план
 * готовности 23.11, этап 1).
 *
 * Раздел «Финансы» в этой справке был под выключателем оплаты давно, а три
 * строки рядом — нет: «Статус „Выполнено“ запускает выплату», «Заполните
 * реквизиты… до первой выплаты», «Укажите реквизиты для выплат». Оператор
 * читал их при выключенном приёме оплаты и ждал денег от платформы.
 * Судится рендером в обоих положениях выключателя.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const { flag } = vi.hoisted(() => ({ flag: { accepts: false } }));
vi.mock('@/lib/payments/accepting', () => ({
  get PLATFORM_ACCEPTS_PAYMENTS() { return flag.accepts; },
  platformAcceptsPayments: () => flag.accepts,
}));

import OperatorHelpClient from '@/app/hub/operator/help/_OperatorHelpClient';

afterEach(() => cleanup());

const helpText = (accepts: boolean) => {
  flag.accepts = accepts;
  return render(<OperatorHelpClient />).container.textContent ?? '';
};

describe('справка кабинета оператора: выплаты', () => {
  it('оплата выключена: слов о выплате нет нигде, сказано про оплату напрямую', () => {
    const t = helpText(false);
    expect(t).not.toMatch(/выплат/i);
    expect(t).toContain('Турист платит вам напрямую');
    expect(t).toContain('платежи платформа не принимает');
  });

  it('оплата включена: строки о выплате и реквизитах на месте', () => {
    const t = helpText(true);
    for (const line of [
      'Статус «Выполнено» запускает выплату',
      'Заполните реквизиты в разделе Финансы до первой выплаты',
      'Укажите реквизиты для выплат в разделе Финансы',
      'Выплаты, реквизиты и история транзакций',
    ]) expect(t, line).toContain(line);
  });

  it('остальной чек-лист от выключателя не зависит', () => {
    for (const accepts of [false, true]) {
      const t = helpText(accepts);
      expect(t).toContain('Создайте первый тур в разделе Туры');
      expect(t).toContain('Подключите MAX: кнопка «Подключить MAX» вверху кабинета');
      cleanup();
    }
  });
});
