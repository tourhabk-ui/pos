/**
 * ZH-карточка тура показывает минимум группы (#3487, сверка 24.11): RU «5–14»,
 * ZH было «最多 14 人».
 */
import { describe, it, expect } from 'vitest';
import { groupZh } from '@/lib/zh/entry';

describe('groupZh: минимум группы', () => {
  it('минимум больше одного — диапазон, как на русской карточке', () => {
    expect(groupZh(14, false, 5)).toBe('5–14 人');
    expect(groupZh(30, null, '6')).toBe('6–30 人');
  });
  it('минимум равен пределу — одно число', () => {
    expect(groupZh(8, false, 8)).toBe('8 人');
  });
  it('минимум 1, не записан или больше предела — только предел', () => {
    expect(groupZh(12, false, 1)).toBe('最多 12 人');
    expect(groupZh(12, false, null)).toBe('最多 12 人');
    expect(groupZh(12)).toBe('最多 12 人');
    expect(groupZh(4, false, 6)).toBe('最多 4 人');
  });
  it('предел не записан — только минимум; ничего — null', () => {
    expect(groupZh(null, false, 5)).toBe('至少 5 人');
    expect(groupZh(null, false, null)).toBeNull();
  });
  it('группа не ограничена — минимум назван, потолок заявки прежний', () => {
    expect(groupZh(12, true)).toBe('人数不限（网站单次申请最多 12 人）');
    expect(groupZh(12, true, 5)).toBe('至少 5 人，人数上限不限（网站单次申请最多 12 人）');
  });
});
