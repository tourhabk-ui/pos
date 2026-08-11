/**
 * Аудит данных маршрутов меряет теми же правилами, что показывает экран.
 *
 * Владелец просит перенести маршруты в единую базу. Переносить 421 маршрут
 * вслепую — это переписать данные, от которых зависит безопасность, не зная,
 * что именно сломано. Аудит существует, чтобы решение принималось по цифрам.
 *
 * Его единственная ценность в том, что он считает ТЕМ ЖЕ кодом: набросок
 * определяется той же trackFidelity, что рисует линию пунктиром, а отрыв
 * точки — той же проекцией, что считает путь в поле. Свои пороги сделали бы
 * аудит измерением самого себя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { geometryToTrack } from '@/lib/routes/geometry-audit';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const AUDIT = read('lib/routes/geometry-audit.ts');
const API = read('app/api/cron/route-data-audit/route.ts');

describe('геометрия читается так же, как её читает офлайн-пакет', () => {
  it('GeoJSON приходит парами [lng, lat] — порядок не путается', () => {
    // Перепутанный порядок увёл бы Камчатку в Индийский океан, и аудит
    // объявил бы конфликтом каждый маршрут.
    const t = geometryToTrack({ coordinates: [[158.65, 53.02], [158.70, 53.10]] });
    expect(t).toEqual([{ lat: 53.02, lng: 158.65 }, { lat: 53.10, lng: 158.70 }]);
  });

  it('мусор не роняет разбор и не превращается в точки', () => {
    expect(geometryToTrack(null)).toEqual([]);
    expect(geometryToTrack({})).toEqual([]);
    expect(geometryToTrack({ coordinates: 'нет' })).toEqual([]);
    expect(geometryToTrack({ coordinates: [[158.65], ['a', 'b'], [158.7, 53.1]] }))
      .toEqual([{ lat: 53.1, lng: 158.7 }]);
  });
});

describe('аудит считает чужими правилами, а не своими', () => {
  it('набросок определяется trackFidelity, а не собственным порогом', () => {
    expect(AUDIT).toMatch(/from '@\/lib\/routes\/track-fidelity'/);
    expect(AUDIT).toMatch(/trackFidelity\(/);
    expect(AUDIT).not.toMatch(/points[Pp]erKm\s*[<>]/);
  });

  it('отрыв точки считается той же проекцией, что и путь в поле', () => {
    expect(AUDIT).toMatch(/from '@\/lib\/on-route\/approach'/);
    expect(AUDIT).toMatch(/projectOnTrack\(/);
    expect(AUDIT).toMatch(/DATA_CONFLICT_KM/);
    // Свой порог в цифрах — это второе определение конфликта.
    expect(AUDIT).not.toMatch(/offTrackKm\s*>\s*\d/);
  });

  it('порог назван в ответе — иначе цифру не с чем сопоставить', () => {
    expect(AUDIT).toContain('conflict_km');
  });
});

describe('аудит ничего не портит и не приукрашивает', () => {
  it('только чтение', () => {
    expect(AUDIT).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  });

  it('классы не сливаются: нет линии, нет точек и конфликт — разные счётчики', () => {
    for (const k of ['no_geometry', 'no_waypoints', 'conflicting', 'consistent']) {
      expect(AUDIT).toContain(k);
    }
  });

  it('худшие расхождения названы поимённо — с них начинать разбор', () => {
    expect(AUDIT).toContain('worst');
    expect(AUDIT).toMatch(/sort\(\(a, b\) => b\.worstOffTrackKm - a\.worstOffTrackKm\)/);
  });

  it('урезанный счёт виден рядом с полным', () => {
    expect(AUDIT).toContain('routes_total');
    expect(AUDIT).toContain('routes_counted');
  });
});

describe('доступ к аудиту', () => {
  it('закрыт секретом до запуска', () => {
    expect(API).toMatch(/timingSafeCompare/);
    expect(API.indexOf('timingSafeCompare')).toBeLessThan(API.indexOf('runGeometryAudit('));
  });

  it('отказ отдаётся ошибкой, а не пустым аудитом', () => {
    // Пустой читался бы как «маршрутов нет», то есть как «всё хорошо».
    expect(API).toMatch(/status:\s*500/);
  });
});
