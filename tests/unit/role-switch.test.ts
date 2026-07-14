/**
 * Логика переключения ролей: admin — god-mode (любая роль + бутстрап возврата),
 * обычный пользователь — только свои роли.
 */
import { describe, it, expect } from 'vitest';
import {
  ownedRoles, availableForSwitch, canSwitchTo, nextOwnedRoles, isSwitchableRole,
} from '@/lib/auth/role-switch';

describe('ownedRoles', () => {
  it('объединяет preferences.roles с активной ролью, отсеивает мусор', () => {
    expect(ownedRoles(['operator', 'guide'], 'operator').sort()).toEqual(['guide', 'operator']);
    expect(ownedRoles(['guide'], 'operator').sort()).toEqual(['guide', 'operator']);
    expect(ownedRoles(['bogus', 'stay'], 'gear').sort()).toEqual(['gear', 'stay']);
    expect(ownedRoles(null, 'tourist')).toEqual(['tourist']);
    expect(ownedRoles('not-array', null)).toEqual([]);
  });
});

describe('availableForSwitch', () => {
  it('admin видит все роли (god-mode)', () => {
    expect(availableForSwitch('admin', ['admin']).length).toBe(8);
    expect(availableForSwitch('admin', ['admin'])).toContain('tourist');
    expect(availableForSwitch('admin', ['admin'])).toContain('gear');
  });

  it('обычный пользователь — только свои', () => {
    expect(availableForSwitch('operator', ['operator', 'guide']).sort()).toEqual(['guide', 'operator']);
    expect(availableForSwitch('tourist', ['tourist'])).toEqual(['tourist']);
  });
});

describe('canSwitchTo', () => {
  it('admin может в любую валидную роль', () => {
    expect(canSwitchTo('admin', ['admin'], 'stay')).toBe(true);
    expect(canSwitchTo('admin', ['admin'], 'guide')).toBe(true);
  });

  it('обычный пользователь только в свои', () => {
    expect(canSwitchTo('operator', ['operator', 'guide'], 'guide')).toBe(true);
    expect(canSwitchTo('operator', ['operator', 'guide'], 'admin')).toBe(false);
    expect(canSwitchTo('tourist', ['tourist'], 'operator')).toBe(false);
  });

  it('невалидная роль — нельзя', () => {
    expect(canSwitchTo('admin', ['admin'], 'superuser')).toBe(false);
  });
});

describe('nextOwnedRoles', () => {
  it('admin бутстрапит admin+target в owned (чтобы вернуться назад)', () => {
    const next = nextOwnedRoles('admin', ['admin'], 'tourist').sort();
    expect(next).toContain('admin');
    expect(next).toContain('tourist');
  });

  it('после «войти как турист» из admin — admin остаётся, можно вернуться', () => {
    const afterFirst = nextOwnedRoles('admin', ['admin'], 'tourist');
    // теперь активная роль tourist, owned содержит admin → доступен возврат
    expect(canSwitchTo('tourist', afterFirst, 'admin')).toBe(true);
  });

  it('обычный пользователь — owned не расширяется', () => {
    expect(nextOwnedRoles('operator', ['operator', 'guide'], 'guide').sort()).toEqual(['guide', 'operator']);
  });
});

describe('isSwitchableRole', () => {
  it('распознаёт валидные роли', () => {
    expect(isSwitchableRole('admin')).toBe(true);
    expect(isSwitchableRole('gear')).toBe(true);
    expect(isSwitchableRole('nope')).toBe(false);
  });
});
