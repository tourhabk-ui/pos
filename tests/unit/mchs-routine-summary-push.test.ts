import { describe, expect, it } from 'vitest';
import { classifyMchsItem, classifyMchsItems, isRoutineDailySummary } from '@/lib/services/safety/seismic-parser';

// Случай 20.10: пуш «Ограничение проезда — Камчатка» с телом про техногенные пожары.
const STAT = 'За прошедшие сутки к тушению техногенных пожаров сотрудники МЧС России привлекались 1 раз.';
const PUB = new Date().toISOString();
const run = (text: string) => classifyMchsItems('vk.com/mchs_kamchatka/1', '', text, PUB, 'https://vk.com/wall-1_1', 'vk_mchs');

describe('рутинная суточная сводка МЧС', () => {
  it('сама фраза о пожарах — не тревога', () => {
    expect(isRoutineDailySummary(STAT)).toBe(true);
    expect(run(STAT)).toEqual([]);
  });

  it('сводка без дороги, но со словом «ограничен» — не «Ограничение проезда» и не пуш', () => {
    const text = `${STAT}\nНа территории края ограничений, связанных с пожарами, не закрыто ни одного объекта.`;
    for (const ev of run(text)) {
      expect(ev.alert_type).not.toBe('road_closure');
      expect(ev.severity).toBeLessThan(2);
    }
  });

  it('сводка с явным перекрытием дороги — в ленту под фразой о дороге, но без пуша', () => {
    const text = `${STAT}\nВ связи с ремонтом моста временно закрыто движение на автодороге Мильково — Ключи.`;
    const out = run(text);
    const road = out.find((e) => e.alert_type === 'road_closure');
    expect(road).toBeTruthy();
    expect(road!.title).not.toMatch(/техногенных пожаров/);
    expect(road!.title).toMatch(/автодороге/);
    expect(road!.severity).toBeLessThan(2);
    expect(out.every((e) => e.severity < 2)).toBe(true);
  });

  it('обычный пост о перекрытии дороги по-прежнему красный', () => {
    const ev = classifyMchsItem('vk.com/mchs_kamchatka/2', '', 'Внимание! Перекрыт проезд к Вилючинскому перевалу из-за размыва дороги.', PUB, '', 'vk_mchs');
    expect(ev?.alert_type).toBe('road_closure');
    expect(ev?.severity).toBe(2);
  });
});
