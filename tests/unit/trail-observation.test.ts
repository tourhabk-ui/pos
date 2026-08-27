/**
 * Наблюдение живёт на экране маршрута, а не на главной (владелец 27.08).
 *
 * Прежняя форма на главной (TrailReportSheet) без сети ТЕРЯЛА текст и не
 * умела фото — а наблюдение рождается в поле, где сети чаще всего нет.
 * Контракт переноса:
 *  - создание — только с полевого экрана: ObservationSheet, сначала диск
 *    (IndexedDB), потом отправка; слушатель online дожимает очередь;
 *  - фото не блокирует наблюдение и уходит отдельным запросом — тем же
 *    порядком, что у полевых проверок (/api/field-check/photo);
 *  - на главной — ссылка на экран маршрута, не кнопка создания;
 *  - панель полевых действий в trail: место · трек · наблюдение; SOS в
 *    неё не входит (красный — только тревога, №887: копии расходятся);
 *  - миграция 917 расширяет типы, не выбрасывая старые (радар жив).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const SHEET = read('components/field/ObservationSheet.tsx');
const TRAIL = read('app/planning/_PlanningClient.tsx');
const HOME = read('app/_home/_HomeV8Client.tsx');
const DB = read('lib/offline/db.ts');
const M = read('migrations/917_trail_observations_from_route_screen.sql');
const REPORTS_API = read('app/api/safety/reports/route.ts');
const PHOTO_API = read('app/api/safety/reports/photo/route.ts');

describe('ObservationSheet: сначала диск, потом сеть', () => {
  it('наблюдение кладётся в очередь ДО попытки отправки', () => {
    const submit = SHEET.slice(SHEET.indexOf('const submit'));
    const queueAt = submit.indexOf('queueTrailObservation');
    const flushAt = submit.indexOf('flushTrailObservations()');
    expect(queueAt, 'очередь не найдена в submit').toBeGreaterThan(0);
    expect(flushAt, 'отправка не найдена в submit').toBeGreaterThan(0);
    expect(queueAt).toBeLessThan(flushAt);
  });

  it('очередь дожимается при появлении сети', () => {
    expect(SHEET).toContain("addEventListener('online'");
  });

  it('фото шлётся отдельным запросом после текста — не блокирует наблюдение', () => {
    const flush = SHEET.slice(SHEET.indexOf('export async function flushTrailObservations'));
    const textPost = flush.indexOf("'/api/safety/reports'");
    const photoPost = flush.indexOf("'/api/safety/reports/photo'");
    expect(textPost).toBeGreaterThan(0);
    expect(photoPost).toBeGreaterThan(textPost);
  });

  it('кнопка честна о судьбе записи без сети', () => {
    expect(SHEET).toContain('отправится, когда появится сеть');
  });

  it('сжатие фото — общее с полевыми проверками, не своя копия', () => {
    expect(SHEET).toContain("from '@/lib/images/shrink-photo'");
    expect(read('app/field-check/_FieldCheckClient.tsx')).toContain("from '@/lib/images/shrink-photo'");
  });
});

describe('панель полевых действий в trail', () => {
  it('место · трек · наблюдение подключены через общий FieldActionBar', () => {
    expect(TRAIL).toContain('FieldActionBar');
    expect(TRAIL).toContain("id: 'place'");
    expect(TRAIL).toContain("id: 'track'");
    expect(TRAIL).toContain("id: 'observation'");
    expect(TRAIL).toContain('ObservationSheet');
  });

  it('SOS в панель не входит — остаётся отдельным EmergencyAction', () => {
    const actions = TRAIL.slice(
      TRAIL.indexOf('const fieldActions'),
      TRAIL.indexOf('// ─── Render'),
    );
    expect(actions).not.toContain('EmergencyAction');
    expect(actions.toLowerCase()).not.toContain('sos');
    expect(TRAIL).toContain('<EmergencyAction variant="field"');
  });

  it('трек уходит тем же приёмником, что у /field-check', () => {
    expect(TRAIL).toContain("'/api/field-check/track'");
  });

  it('панель доступна и без выбранного маршрута — регрессия 27.08', () => {
    // Ссылка с главной обещает наблюдение «с экрана маршрута», не «после
    // выбора маршрута». До фикса FieldActionBar рендерился только в ветке
    // hasRoute, и переход с главной упирался в экран «Выбрать маршрут» —
    // до формы наблюдения без активного маршрута нельзя было добраться.
    // Ищем именно JSX-условие (с ведущей `{`), а не любое вхождение этой
    // фразы: она встречается ещё и в useEffect авто-загрузки рекомендаций
    // (destination-first, 27.08).
    const condAt = TRAIL.indexOf('{!hasRoute && !isLoadingRoute ? (');
    const emptyState = TRAIL.slice(condAt, TRAIL.indexOf(') : (', condAt));
    expect(emptyState).toContain('<FieldActionBar actions={fieldActions} error={fieldBarError} />');
  });

  it('ObservationSheet смонтирован вне обеих веток hasRoute', () => {
    const sheetAt = TRAIL.lastIndexOf('<ObservationSheet');
    const elseBranchEnd = TRAIL.indexOf('// ─── Планирование tab');
    expect(sheetAt).toBeGreaterThan(0);
    // Монтирование — после конца обеих JSX-веток компонента OnTrailTab,
    // не внутри одной из них.
    expect(sheetAt).toBeLessThan(elseBranchEnd);
    const between = TRAIL.slice(sheetAt, elseBranchEnd);
    expect(between).not.toContain('function PlanningTab');
  });
});

describe('главная: ссылка вместо кнопки создания', () => {
  it('TrailReportSheet с главной удалён, компонента больше нет', () => {
    expect(HOME).not.toContain('TrailReportSheet');
    expect(existsSync(join(ROOT, 'components/homepage/TrailReportSheet.tsx'))).toBe(false);
  });

  it('на главной — жёсткая ссылка на экран маршрута (офлайн-контур)', () => {
    const at = HOME.indexOf('Сообщить о наблюдении');
    expect(at).toBeGreaterThan(0);
    const around = HOME.slice(Math.max(0, at - 400), at);
    expect(around).toContain('href="/planning?mode=trail"');
  });
});

describe('хранилище и API', () => {
  it('IndexedDB: store trailObservations заведён с подъёмом версии', () => {
    expect(DB).toContain("createObjectStore('trailObservations'");
    expect(DB).toMatch(/DB_VERSION = 7/);
  });

  it('миграция 917 расширяет типы, не выбрасывая старые', () => {
    for (const t of ['bear', 'rockfall', 'weather', 'other', 'animal', 'plant', 'hazard', 'trail']) {
      expect(M).toContain(`'${t}'`);
    }
    expect(M).toContain('trail_report_photos');
    expect(M).toContain('ON DELETE CASCADE');
  });

  it('Zod у /api/safety/reports принимает полевые категории и старые', () => {
    expect(REPORTS_API).toMatch(/'bear', 'rockfall', 'weather', 'other', 'animal', 'plant', 'hazard', 'trail'/);
  });

  it('приёмник фото держит тот же потолок, что у field-check', () => {
    expect(PHOTO_API).toContain('MAX_BYTES = 1_200_000');
    expect(PHOTO_API).toContain('trail_report_photos');
    expect(read('app/api/field-check/photo/route.ts')).toContain('MAX_BYTES = 1_200_000');
  });
});
