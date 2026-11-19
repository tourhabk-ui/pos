// @vitest-environment jsdom
/**
 * #3467: календарь клёва не молчит о расхождении с сезоном тура.
 *
 * «Зимняя рыбалка: ноябрь — январь» называет хариуса и кунжу, а календарь той
 * же карточки даёт им июнь–сентябрь и июль–сентябрь. Кто прав, Ведар не знает:
 * календарь — общий справочник, улов тура называет оператор. Поэтому под
 * календарём — строка о расхождении. Судится рендером и вызовом.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FishSeasonCalendar from '@/components/tours/FishSeasonCalendar';
import { detectFishSpecies, seasonMonthsBetween, speciesOutsideMonths } from '@/lib/fish-species';

// Дословно из описания тура (миграция 1106).
const WINTER_TEXT = 'Подлёдная рыбалка на реке Камчатке: микижа (радужная форель), хариус, кунжа и голец.';

describe('seasonMonthsBetween', () => {
  it('сезон через Новый год переходит через декабрь', () => {
    expect(seasonMonthsBetween('2026-11-15', '2027-01-15')).toEqual([11, 12, 1]);
  });
  it('сезон внутри года', () => {
    expect(seasonMonthsBetween('2027-06-18', '2027-07-20')).toEqual([6, 7]);
  });
  it('сезон в год и дольше — все месяцы', () => {
    expect(seasonMonthsBetween('2026-05-01', '2027-04-30')).toHaveLength(12);
  });
  it('нет даты, мусор или конец раньше начала — сезона не знаем (null)', () => {
    expect(seasonMonthsBetween(null, '2027-01-15')).toBeNull();
    expect(seasonMonthsBetween('зима', '2027-01-15')).toBeNull();
    expect(seasonMonthsBetween('2027-03-01', '2027-01-15')).toBeNull();
  });
});

describe('speciesOutsideMonths', () => {
  it('зимой вне календаря — хариус и кунжа; голец круглый год остаётся', () => {
    const ids = speciesOutsideMonths(detectFishSpecies(WINTER_TEXT), [11, 12, 1]).map(s => s.id);
    expect(ids).toContain('kharius');
    expect(ids).toContain('kundzha');
    expect(ids).not.toContain('golets');
  });
  it('сезон не записан — сверять не с чем, расхождения нет', () => {
    expect(speciesOutsideMonths(detectFishSpecies(WINTER_TEXT), null)).toEqual([]);
  });
});

describe('FishSeasonCalendar: строка о расхождении', () => {
  it('зимний тур: названы хариус и кунджа, сезон тура и кто говорит об улове', () => {
    render(<FishSeasonCalendar species={detectFishSpecies(WINTER_TEXT)} tourMonths={[11, 12, 1]} />);
    const note = screen.getByText(/календарь в сезон тура/);
    expect(note.textContent).toContain('хариус');
    expect(note.textContent).toContain('кунджа');
    expect(note.textContent).toContain('ноя, дек, янв');
    expect(note.textContent).toContain('уточняйте у него');
    expect(note.textContent).not.toContain('голец');
  });

  it('летний тур в сезон вида — строки нет', () => {
    render(<FishSeasonCalendar species={detectFishSpecies('Ловим хариуса')} tourMonths={[7, 8]} />);
    expect(screen.queryByText(/календарь в сезон тура/)).toBeNull();
  });

  it('сезон тура не записан — строки нет', () => {
    render(<FishSeasonCalendar species={detectFishSpecies(WINTER_TEXT)} />);
    expect(screen.queryByText(/календарь в сезон тура/)).toBeNull();
  });
});
