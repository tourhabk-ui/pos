/**
 * Полоса действий полевого экрана — сторож (владелец 22.08, образец MAPS.ME).
 *
 * Форма взята у навигатора, который люди уже держат в руках: ряд круглых
 * кнопок, одно касание — одно действие, ничего не спрятано под меню.
 *
 * Три черты, которых у образца НЕТ и которые здесь обязательны:
 *  1. Невозможное действие не показывается вовсе. Серая неактивная кнопка
 *     врёт не меньше работающей: человек в перчатке жмёт её и решает, что
 *     сломалось приложение.
 *  2. Идущая запись видна ЧИСЛАМИ. «Пишется» без цифр неотличимо от
 *     «делает вид».
 *  3. У действия есть исход «не смог», и он выводится словами (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptFix, emptyRecorder, summarize, toGpx,
  ACCEPT_ACCURACY_M, MIN_STEP_M,
} from '@/lib/field/track-recorder';

const bar = readFileSync(join(process.cwd(), 'components/field/FieldActionBar.tsx'), 'utf-8');
const hook = readFileSync(join(process.cwd(), 'hooks/useTrackRecorder.ts'), 'utf-8');
const client = readFileSync(join(process.cwd(), 'app/field-check/_FieldCheckClient.tsx'), 'utf-8');
const db = readFileSync(join(process.cwd(), 'lib/offline/db.ts'), 'utf-8');

describe('полоса действий', () => {
  it('пустая полоса не рендерится вовсе', () => {
    expect(bar).toMatch(/if \(actions\.length === 0\) return null/);
  });

  it('невозможное действие не попадает в состав, а не гасится', () => {
    // Кнопки строятся под условием, а не помечаются disabled.
    expect(client).toMatch(/if \(canGeo\) \{\s*list\.push/);
    expect(client).toMatch(/if \(fix !== null\) \{\s*list\.push/);
  });

  it('идущая запись показывает точки и километры', () => {
    expect(client).toContain('${recorder.summary.points} точек · ${recorder.summary.lengthKm} км');
  });

  it('молчание прибора говорится словом, а не скрывается', () => {
    expect(client).toContain("'сигнала нет'");
    expect(hook).toMatch(/setSilent\(Date\.now\(\) - lastFixRef\.current > SILENCE_MS\)/);
  });

  it('отказ действия выводится строкой', () => {
    expect(bar).toMatch(/\{error && \(/);
    expect(client).toContain('setBarError');
  });

  it('цель под палец в перчатке', () => {
    expect(bar).toMatch(/const TAP = 56/);
  });
});

describe('запись трека', () => {
  it('идущая запись живёт на диске, а не в памяти вкладки', () => {
    expect(db).toContain("db.createObjectStore('fieldTracks'");
    expect(hook).toContain('saveTrackDraft');
    // Недописанная запись предлагается, но НЕ продолжается сама.
    expect(hook).toMatch(/setRestored\(true\)/);
  });

  it('версия базы поднята вместе с новым хранилищем', () => {
    const m = /const DB_VERSION = (\d+)/.exec(db);
    expect(m).not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(6);
  });

  it('трек уходит ТЕМ ЖЕ приёмником, что и файл из навигатора', () => {
    expect(client).toContain("fetch('/api/field-check/track'");
    expect(hook).toContain('toGpx');
  });

  it('связи нет — запись не теряется, и об этом говорится', () => {
    expect(client).toContain('сохранён на телефоне');
    // Очистка черновика только ПОСЛЕ удачной отправки: порядок в коде, а
    // не форма записи — иначе сторож ломается от переносов строк.
    const failReturn = client.indexOf('трек не ушёл') >= 0
      ? client.indexOf('Трек не ушёл')
      : client.indexOf('setBarError(data?.error');
    const discardAt = client.indexOf('await recorder.discard()');
    expect(failReturn).toBeGreaterThan(0);
    expect(discardAt).toBeGreaterThan(failReturn);
  });

  it('меньше двух точек — трека нет, и это отказ словами', () => {
    expect(hook).toMatch(/st\.points\.length < 2/);
    expect(hook).toContain('Записано меньше двух точек');
  });
});

describe('правила приёма засечки', () => {
  const fix = (lat: number, lng: number, acc: number, t: number, alt: number | null = null) =>
    ({ lat, lng, accuracy: acc, altitude: alt, t });

  it('точность хуже порога — точка не идёт в путь', () => {
    const r = acceptFix(emptyRecorder(), fix(53, 158, ACCEPT_ACCURACY_M + 1, 0));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('accuracy');
  });

  it('приёмник промолчал о точности — это «не знаю», а не «хорошо»', () => {
    const r = acceptFix(emptyRecorder(), fix(53, 158, NaN, 0));
    expect(r.reason).toBe('unknown_accuracy');
  });

  it('дрожь стоящего не копится в путь', () => {
    let st = acceptFix(emptyRecorder(), fix(53, 158, 5, 0)).state;
    // Сдвиг меньше минимального шага — отброшен.
    const r = acceptFix(st, fix(53.00002, 158, 5, 10_000));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('jitter');
    expect(r.state.lengthM).toBe(0);
  });

  it('настоящий шаг принимается и меряется', () => {
    let st = acceptFix(emptyRecorder(), fix(53, 158, 5, 0)).state;
    const r = acceptFix(st, fix(53.0005, 158, 5, 30_000));
    expect(r.accepted).toBe(true);
    expect(r.state.lengthM).toBeGreaterThan(MIN_STEP_M);
  });

  it('прыжок приёмника отбрасывается', () => {
    let st = acceptFix(emptyRecorder(), fix(53, 158, 5, 0)).state;
    const r = acceptFix(st, fix(54, 158, 5, 1000));
    expect(r.reason).toBe('jump');
  });

  it('отказ съёмки краснеет, а не выдаётся за короткий трек', () => {
    let st = emptyRecorder();
    st = acceptFix(st, fix(53, 158, 5, 0)).state;
    st = acceptFix(st, fix(53.0005, 158, 5, 30_000)).state;
    for (let i = 0; i < 20; i++) st = acceptFix(st, fix(53, 158, 900, i)).state;
    const sum = summarize(st);
    expect(sum.quality).toBe('poor');
    expect(sum.reasons.join(' ')).toContain('приёмник');
  });

  it('GPX несёт время, а нулевую высоту не выдумывает', () => {
    let st = acceptFix(emptyRecorder(), fix(53, 158, 5, 1_700_000_000_000, null)).state;
    st = acceptFix(st, fix(53.0005, 158, 5, 1_700_000_030_000, 250)).state;
    const gpx = toGpx(st, 'Выход');
    expect(gpx).toContain('<time>');
    expect(gpx).toContain('<ele>250</ele>');
    // У точки без высоты тега нет вовсе — ноль прочитался бы как уровень моря.
    expect((gpx.match(/<ele>/g) ?? []).length).toBe(1);
  });
});
