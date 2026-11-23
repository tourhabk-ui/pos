import { describe, expect, it } from 'vitest';
import {
  aviationColorChanged,
  buildKvertColorAlert,
  isAccColor,
  kvertVolcanoZones,
} from '@/lib/services/safety/kvert-color-alerts';
import { alertPlaceKnown, unplacedAlertsOn } from '@/lib/trips/date-check';
import type { OfficialAlert } from '@/lib/agents/evo/rescue-judge';

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

/**
 * Аудит 23.11: событие о смене кода писалось с пустыми зонами. Зона самого
 * вулкана тревогу не получала, а проверка дат считала её «предупреждением с
 * неустановленным местом» и ставила «не проверено» каждому туру края на пять
 * суток — из-за кода у вулкана в четырёхстах километрах.
 */
describe('событие о коде KVERT несёт зону вулкана', () => {
  const base = {
    slug: 'sheveluch', sourceUrl: null, observedAt: new Date(), summary: null, ashHeightM: null,
    prev: 'yellow' as const, next: 'orange' as const,
  };

  it('зона — из общей карты «вулкан → зона»', () => {
    expect(kvertVolcanoZones('Шивелуч')).toEqual(['northern']);
    expect(kvertVolcanoZones('Ключевской')).toEqual(['northern']);
    expect(kvertVolcanoZones('Карымский')).toEqual(['eastern']);
    expect(kvertVolcanoZones('Авачинский')).toEqual(['avachinsky']);
    expect(kvertVolcanoZones('Жупановский').sort()).toEqual(['avachinsky', 'eastern']);
    // Северные Курилы — своя метка, ни с одной зоной края не совпадает.
    expect(kvertVolcanoZones('Эбеко')).toEqual(['kuril_north']);
  });

  it('вулкана нет в карте — зоны нет, она не выдумывается', () => {
    expect(kvertVolcanoZones('Кизимен')).toEqual([]);
    expect(buildKvertColorAlert({ ...base, volcanoName: 'Кизимен' })!.affected_zones).toEqual([]);
  });

  it('оранжевый код Шивелуча для проверки дат — тревога с известным местом, а не «место не установлено»', () => {
    const ev = buildKvertColorAlert({ ...base, volcanoName: 'Шивелуч' })!;
    expect(ev.affected_zones).toEqual(['northern']);
    const asOfficial: OfficialAlert = {
      id: 1, alert_type: ev.alert_type, severity: ev.severity, title: ev.title, description: ev.description,
      affected_zones: ev.affected_zones, expires_at: new Date(Date.now() + 86_400_000).toISOString(), source_url: ev.source_url,
    };
    expect(alertPlaceKnown(asOfficial)).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(unplacedAlertsOn([asOfficial], today)).toEqual([]);
    // То же событие без зон (как писалось до 23.11) — «место не установлено».
    expect(alertPlaceKnown({ ...asOfficial, affected_zones: [] })).toBe(false);
  });
});
