import { describe, expect, it } from 'vitest';
import {
  aviationColorChanged,
  buildKvertColorAlert,
  isAccColor,
} from '@/lib/services/safety/kvert-color-alerts';

describe('isAccColor', () => {
  it('принимает коды KVERT и отвергает пустое и чужое', () => {
    expect(isAccColor('green')).toBe(true);
    expect(isAccColor('unassigned')).toBe(true);
    expect(isAccColor('blue')).toBe(false);
    expect(isAccColor(null)).toBe(false);
    expect(isAccColor('')).toBe(false);
  });
});

describe('aviationColorChanged', () => {

  it('не пишет повтор того же кода', () => {
    expect(aviationColorChanged('orange', 'orange')).toBe(false);
  });
  it('не пишет первый зелёный и unassigned', () => {
    expect(aviationColorChanged(null, 'green')).toBe(false);
    expect(aviationColorChanged('yellow', 'unassigned')).toBe(false);
  });
  it('пишет смену и первый повышенный код', () => {
    expect(aviationColorChanged('yellow', 'orange')).toBe(true);
    expect(aviationColorChanged('orange', 'green')).toBe(true);
    expect(aviationColorChanged(null, 'red')).toBe(true);
  });
});

describe('buildKvertColorAlert', () => {
  const base = {
    slug: 'sheveluch',
    volcanoName: 'Шивелуч',
    sourceUrl: 'http://kvert.febras.net/van/?vn=123&lend=en',
    observedAt: new Date('2026-11-22T03:00:00Z'),
    summary: 'Пепел на 10 км.',
    ashHeightM: 10000,
  };

  it('для повышения до красного — ash_cloud, severity 3, в заголовке оба цвета', () => {
    const ev = buildKvertColorAlert({ ...base, prev: 'orange', next: 'red' });
    expect(ev).not.toBeNull();
    expect(ev!.alert_type).toBe('ash_cloud');
    expect(ev!.severity).toBe(3);
    expect(ev!.title).toContain('красный');
    expect(ev!.title).toContain('оранжевый');
    expect(ev!.source_id).toBe('kvert-acc/sheveluch/red/2026-11-22');
    expect(ev!.volcano_scope).toBe('named');
    expect(ev!.ash_height_m).toBe(10000);
  });

  it('для снижения до зелёного — info, не ash_cloud', () => {
    const ev = buildKvertColorAlert({ ...base, prev: 'yellow', next: 'green', ashHeightM: null, summary: null });
    expect(ev).not.toBeNull();
    expect(ev!.alert_type).toBe('info');
    expect(ev!.severity).toBe(0);
  });

  it('первый зелёный и отсутствие смены — null', () => {
    expect(buildKvertColorAlert({ ...base, prev: null, next: 'green' })).toBeNull();
    expect(buildKvertColorAlert({ ...base, prev: 'yellow', next: 'yellow' })).toBeNull();
  });
});
