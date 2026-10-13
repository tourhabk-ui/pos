/**
 * Номер в реестре туроператоров — строкой реквизитов, с тем, чего он стоит
 * (владелец 13.10: «где у операторов номер в реестре?»).
 *
 * Номер лежал в partners.registry_number, а страница показывала его только
 * подсказкой над значком «В официальном реестре» и только после сверки,
 * которой не прошёл ни один оператор: номер не видел никто. Сторож — рендером
 * (правило 13.10: поведение, не текст исходника): что видит человек.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OperatorLegalInfo } from '@/components/operator/OperatorLegalInfo';

const MESTECHKO = {
  companyName: 'ООО «Местечко Камчатка»',
  inn: '4100046246',
  ogrn: '1234100001079',
  address: '683009, Камчатский край, Петропавловск-Камчатский, ул. Академика Курчатова, д. 33, кв. 14',
};

/** Пары «подпись — значение» реквизитов в порядке документа. */
function rows(container: HTMLElement): Array<[string, string]> {
  return Array.from(container.querySelectorAll('dl > div')).map((d) => [
    d.querySelector('dt')?.textContent ?? '',
    d.querySelector('dd')?.textContent ?? '',
  ]);
}

describe('реквизиты оператора и номер в реестре', () => {
  it('номер не сверен — виден строкой реквизитов с пометкой «с реестром не сверен»', () => {
    const { container } = render(
      <OperatorLegalInfo legal={MESTECHKO} registryNumber="РТО В031-00161-00/04108813" registryStatus="unknown" registryCheckedAt={null} />,
    );
    expect(screen.getByRole('heading', { name: 'Юридическая информация' })).toBeTruthy();
    expect(rows(container)).toEqual([
      ['Компания', 'ООО «Местечко Камчатка»'],
      ['ИНН', '4100046246'],
      ['ОГРН', '1234100001079'],
      ['Адрес', MESTECHKO.address],
      ['Реестровый номер туроператора', 'РТО В031-00161-00/04108813с реестром не сверен'],
    ]);
  });

  it('сверен — с датой сверки; расхождение и «не найден» — названы, а не спрятаны', () => {
    const verified = render(<OperatorLegalInfo legal={null} registryNumber="РТО 018339" registryStatus="verified" registryCheckedAt="12.10.2026" />);
    expect(rows(verified.container)).toEqual([['Реестровый номер туроператора', 'РТО 018339сверен с реестром 12.10.2026']]);
    verified.unmount();

    const mismatch = render(<OperatorLegalInfo legal={null} registryNumber="РТО 018339" registryStatus="mismatch" registryCheckedAt={null} />);
    expect(screen.getByText('расходится с данными реестра')).toBeTruthy();
    mismatch.unmount();

    render(<OperatorLegalInfo legal={null} registryNumber="РТО 018339" registryStatus="not_found" registryCheckedAt={null} />);
    expect(screen.getByText('в реестре не найден')).toBeTruthy();
  });

  it('номера нет — строки нет; нет ни реквизитов, ни номера — нет и блока', () => {
    const { container } = render(<OperatorLegalInfo legal={MESTECHKO} registryNumber="  " registryStatus="unknown" registryCheckedAt={null} />);
    expect(rows(container).map(([label]) => label)).not.toContain('Реестровый номер туроператора');
    const empty = render(<OperatorLegalInfo legal={null} registryNumber={null} registryStatus="verified" registryCheckedAt={null} />);
    expect(empty.container.innerHTML).toBe('');
  });

  it('реквизиты свободным текстом — абзац, номер — строкой под ним', () => {
    const { container } = render(
      <OperatorLegalInfo legal="ИП Иванов, ИНН 410100000000" registryNumber="РТО 000001" registryStatus={null} registryCheckedAt={null} />,
    );
    expect(screen.getByText('ИП Иванов, ИНН 410100000000')).toBeTruthy();
    expect(rows(container)).toEqual([['Реестровый номер туроператора', 'РТО 000001с реестром не сверен']]);
  });
});
