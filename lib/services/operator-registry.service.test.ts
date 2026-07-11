import { describe, it, expect } from 'vitest';
import {
  normalizeOperatorName,
  normalizeDigits,
  isRegistryEntryActive,
  matchPartner,
  classifyStatus,
  summarizeStatuses,
  type RegistryEntry,
  type PartnerForMatch,
} from './operator-registry.service';

function entry(over: Partial<RegistryEntry> & { name: string }): RegistryEntry {
  return {
    id: over.id ?? 'e1',
    name: over.name,
    nameNormalized: over.nameNormalized ?? normalizeOperatorName(over.name),
    inn: over.inn ?? null,
    ogrn: over.ogrn ?? null,
    registryNumber: over.registryNumber ?? null,
    registryStatus: over.registryStatus ?? null,
  };
}

describe('normalizeOperatorName', () => {
  it('убирает орг-форму, кавычки и пунктуацию', () => {
    expect(normalizeOperatorName('ООО «Камчатка-Тур»')).toBe('камчатка тур');
    expect(normalizeOperatorName('ИП Иванов И.И.')).toBe('иванов и и');
  });

  it('одинаково нормализует записи с разной обёрткой', () => {
    expect(normalizeOperatorName('Туроператор "ВулканТур"')).toBe(
      normalizeOperatorName('ООО ВулканТур'),
    );
  });

  it('пустая строка → пусто', () => {
    expect(normalizeOperatorName('')).toBe('');
  });
});

describe('normalizeDigits', () => {
  it('оставляет только цифры', () => {
    expect(normalizeDigits('4101 123456')).toBe('4101123456');
    expect(normalizeDigits('ИНН: 4100000000')).toBe('4100000000');
  });
  it('пустое/буквы → null', () => {
    expect(normalizeDigits('')).toBeNull();
    expect(normalizeDigits(null)).toBeNull();
    expect(normalizeDigits('нет')).toBeNull();
  });
});

describe('isRegistryEntryActive', () => {
  it('пустой статус считается действующим', () => {
    expect(isRegistryEntryActive(entry({ name: 'X', registryStatus: null }))).toBe(true);
  });
  it('исключён/прекращена → неактивен', () => {
    expect(isRegistryEntryActive(entry({ name: 'X', registryStatus: 'Исключён из реестра' }))).toBe(false);
    expect(isRegistryEntryActive(entry({ name: 'X', registryStatus: 'прекращена деятельность' }))).toBe(false);
  });
  it('действующий → активен', () => {
    expect(isRegistryEntryActive(entry({ name: 'X', registryStatus: 'Действующий' }))).toBe(true);
  });
});

describe('matchPartner', () => {
  const entries = [
    entry({ id: 'a', name: 'ООО Камчатка-Тур', inn: '4100000001' }),
    entry({ id: 'b', name: 'ВулканТур', ogrn: '1234567890123' }),
    entry({ id: 'c', name: 'Медвежий Угол' }),
  ];

  it('матч по ИНН имеет приоритет', () => {
    const partner: PartnerForMatch = { id: 1, name: 'Другое имя', inn: '4100000001', ogrn: null };
    const m = matchPartner(partner, entries);
    expect(m?.method).toBe('inn');
    expect(m?.entry.id).toBe('a');
  });

  it('матч по ОГРН когда ИНН нет', () => {
    const partner: PartnerForMatch = { id: 2, name: 'Другое', inn: null, ogrn: '1234567890123' };
    const m = matchPartner(partner, entries);
    expect(m?.method).toBe('ogrn');
    expect(m?.entry.id).toBe('b');
  });

  it('матч по названию когда нет реквизитов', () => {
    const partner: PartnerForMatch = { id: 3, name: 'ООО «Медвежий угол»', inn: null, ogrn: null };
    const m = matchPartner(partner, entries);
    expect(m?.method).toBe('name');
    expect(m?.entry.id).toBe('c');
  });

  it('нет матча → null', () => {
    const partner: PartnerForMatch = { id: 4, name: 'Неизвестный', inn: '9999999999', ogrn: null };
    expect(matchPartner(partner, entries)).toBeNull();
  });
});

describe('classifyStatus', () => {
  const partner: PartnerForMatch = { id: 1, name: 'Камчатка-Тур', inn: '4100000001', ogrn: null };

  it('нет матча → not_found', () => {
    expect(classifyStatus(partner, null)).toBe('not_found');
  });

  it('матч по ИНН и запись действующая → verified', () => {
    const m = { entry: entry({ name: 'X', inn: '4100000001', registryStatus: 'действующий' }), method: 'inn' as const };
    expect(classifyStatus(partner, m)).toBe('verified');
  });

  it('матч по ИНН но запись исключена → mismatch', () => {
    const m = { entry: entry({ name: 'X', inn: '4100000001', registryStatus: 'исключён' }), method: 'inn' as const };
    expect(classifyStatus(partner, m)).toBe('mismatch');
  });

  it('матч по названию но ИНН расходится → mismatch', () => {
    const m = { entry: entry({ name: 'X', inn: '5200000009' }), method: 'name' as const };
    expect(classifyStatus(partner, m)).toBe('mismatch');
  });

  it('матч по названию без ИНН у нас → verified (best-effort)', () => {
    const noInn: PartnerForMatch = { id: 2, name: 'Медвежий угол', inn: null, ogrn: null };
    const m = { entry: entry({ name: 'Медвежий угол' }), method: 'name' as const };
    expect(classifyStatus(noInn, m)).toBe('verified');
  });
});

describe('summarizeStatuses', () => {
  it('считает по категориям', () => {
    const s = summarizeStatuses(['verified', 'verified', 'not_found', 'mismatch', 'unknown']);
    expect(s).toEqual({ verified: 2, notFound: 1, mismatch: 1, unknown: 1 });
  });
});
