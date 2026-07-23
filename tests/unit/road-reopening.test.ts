/**
 * Честное снятие дорожного ограничения по новости открытия. Ловит: открытие не
 * создаёт фантомное закрытие; «будет возобновлено» — ещё закрытие; снятие только
 * при совпадении зоны И топонима (русское склонение через стемы).
 */
import { describe, it, expect } from 'vitest';
import {
  detectRoadReopening,
  detectRoadRestriction,
  closureMatchesReopening,
} from '@/lib/services/safety/seismic-parser';

const PALANA = 'На Камчатке возобновлено движение на участке автодороги «Палана — строящийся аэропорт». Движение для всех видов транспорта возобновлено вечером 23 июля. Дорогу закрывали в связи с размывом земляного полотна.';

describe('detectRoadReopening', () => {
  it('«движение возобновлено» — открытие', () => {
    expect(detectRoadReopening(PALANA)).toBe(true);
    expect(detectRoadReopening('открыт проезд к Вачкажцу')).toBe(true);
    expect(detectRoadReopening('ограничение движения снято')).toBe(true);
  });

  it('закрытие — не открытие', () => {
    expect(detectRoadReopening('с 08:00 20 июля до 18:00 27 июля закрыт проезд к массиву')).toBe(false);
  });

  it('«будет возобновлено» — ещё закрытие (future-страж)', () => {
    expect(detectRoadReopening('проезд закрыт, движение будет возобновлено 27 июля')).toBe(false);
  });
});

describe('detectRoadRestriction — открытие не создаёт закрытие', () => {
  it('новость открытия → null (нет фантомного road_closure)', () => {
    expect(detectRoadRestriction(PALANA)).toBeNull();
  });
  it('реальное закрытие → severity', () => {
    expect(detectRoadRestriction('закрыт проезд к Вачкажцу')?.severity).toBe(2);
    expect(detectRoadRestriction('проезд по пропускам, пропускной режим')?.severity).toBe(1);
  });
});

describe('closureMatchesReopening — консервативное снятие', () => {
  it('та же зона + топоним (склонение через стем) → снять', () => {
    // Вачкажцу (открытие) ↔ Вачкажец (закрытие): общий стем «вачка»
    expect(closureMatchesReopening(
      'движение к Вачкажцу возобновлено', ['western'],
      'Вачкажец: проезд закрыт 20-27 июля', ['western'],
    )).toBe(true);
  });

  it('Палана ↔ Палана в той же зоне → снять', () => {
    expect(closureMatchesReopening(
      PALANA, ['northern'],
      'Палана — аэропорт: проезд закрыт (размыв)', ['northern'],
    )).toBe(true);
  });

  it('другая зона → не трогать', () => {
    expect(closureMatchesReopening(
      'движение к Вачкажцу возобновлено', ['western'],
      'Вачкажец: проезд закрыт', ['avachinsky'],
    )).toBe(false);
  });

  it('та же зона, но другой топоним → не гасить чужое', () => {
    expect(closureMatchesReopening(
      'движение к Вачкажцу возобновлено', ['western'],
      'Вилючинский перевал: проезд по пропускам', ['western'],
    )).toBe(false);
  });
});
