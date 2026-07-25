import { describe, it, expect } from 'vitest';
import {
  reattestationStatus,
  deadlinePassed,
  REGISTRY_CUTOFF,
  REATTESTATION_DEADLINE,
  FEDERATIONS,
} from '@/lib/guides/reattestation';

// Расчёт «нужна ли переаттестация до 1 октября» — чистый и консервативный:
// судим только по датам выдачи, без дат честно говорим «нет данных».

describe('reattestationStatus', () => {
  it('нет сертификатов — требование не про этого гида', () => {
    expect(reattestationStatus([])).toBe('not_applicable');
  });

  it('все сертификаты без дат — судить не по чему', () => {
    expect(reattestationStatus([{ issue_date: null }, { issue_date: null }])).toBe('unknown');
  });

  it('все датированные — до порога: переаттестация нужна', () => {
    expect(
      reattestationStatus([{ issue_date: '2022-05-10' }, { issue_date: '2024-06-30' }])
    ).toBe('needed');
  });

  it('смесь «без даты» и «до порога» не превращает needed в unknown', () => {
    expect(
      reattestationStatus([{ issue_date: null }, { issue_date: '2023-01-01' }])
    ).toBe('needed');
  });

  it('хотя бы одна аттестация после порога закрывает требование', () => {
    expect(
      reattestationStatus([{ issue_date: '2022-05-10' }, { issue_date: '2025-03-01' }])
    ).toBe('done');
  });

  it('дата ровно в порог считается «после» (аттестация уже по новым правилам)', () => {
    expect(reattestationStatus([{ issue_date: REGISTRY_CUTOFF }])).toBe('done');
  });
});

describe('deadlinePassed', () => {
  it('до дедлайна — false, в день дедлайна и после — true', () => {
    expect(deadlinePassed('2026-09-30')).toBe(false);
    expect(deadlinePassed(REATTESTATION_DEADLINE)).toBe(true);
    expect(deadlinePassed('2026-10-02')).toBe(true);
  });
});

describe('константы из разъяснения', () => {
  it('порог и дедлайн — валидные ISO-даты в правильном порядке', () => {
    expect(REGISTRY_CUTOFF).toBe('2024-07-01');
    expect(REATTESTATION_DEADLINE > REGISTRY_CUTOFF).toBe(true);
    for (const d of [REGISTRY_CUTOFF, REATTESTATION_DEADLINE]) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(`${d}T00:00:00`).getTime())).toBe(false);
    }
  });

  it('три федерации из разъяснения, без выдуманных ссылок', () => {
    expect(FEDERATIONS).toHaveLength(3);
    for (const f of FEDERATIONS) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.scope.length).toBeGreaterThan(0);
      // URL федераций в разъяснении не было — выдумывать их запрещено
      expect(`${f.name} ${f.scope}`).not.toMatch(/https?:/);
    }
  });
});
