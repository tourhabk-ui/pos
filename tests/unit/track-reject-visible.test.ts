/**
 * Отказ приёма назван словами: «пишу» и «делаю вид, что пишу» — разные вещи.
 *
 * ── Что случилось 31.08 ───────────────────────────────────────────────────
 *
 * Владелец нажал «Записать трек», проехал до Раздолья, нажал «Остановить».
 * На сервере ноль. Отправка была ни при чём: рекордер не принял НИ ОДНОЙ
 * засечки, черновик на диск не лёг — сохранять было нечего.
 *
 * Улика лежала в его же полевых проверках, ушедших в тот же час с того же
 * телефона: точность 500, 1000 и 100 метров. Порог приёма — 50.
 *
 * Экран при этом выглядел как идущая запись: таймер шёл, `silent` не
 * загорался (он означает «засечек нет вовсе», а они приходили — просто ни
 * одна не годилась). Счётчики отброшенных считались исправно и не
 * показывались никому.
 *
 * Это §4.0 в чистом виде: у проверки приёма было два исхода вместо трёх —
 * «пишем» и «прибор молчит». Третьего, «прибор говорит, но негодное», не
 * существовало, и место, где нельзя сказать «не могу», заполнилось видом
 * нормальной работы.
 *
 * Сторож держит и слова, и то, что порог НЕ смягчён: 50 метров выбраны
 * потому, что этой линией мы заменяем геометрию платформы (§12). Лечится
 * не понижением планки, а тем, что человек узнаёт причину сразу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptFix, emptyRecorder, summarize, DROP_WORDS, ACCEPT_ACCURACY_M,
  type RawFix,
} from '@/lib/field/track-recorder';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const HOOK = strip(read('hooks/useTrackRecorder.ts'));
const TRAIL = strip(read('app/planning/_PlanningClient.tsx'));

/** Засечка на ходу: шаг заведомо больше MIN_STEP_M, скорость машинная. */
function fix(i: number, accuracy: number | null): RawFix {
  return {
    lat: 53.29 + i * 0.001,
    lng: 158.35,
    accuracy,
    altitude: 100 + i,
    t: 1_700_000_000_000 + i * 5_000,
  };
}

describe('живой прогон: телефон владельца 31.08', () => {
  it('точность 100-1000 м не принимается ни одной точкой', () => {
    // Ровно те числа, что стоят в его полевых проверках того утра.
    let st = emptyRecorder();
    [500, 1000, 100, 500, 1000, 100].forEach((acc, i) => {
      st = acceptFix(st, fix(i, acc)).state;
    });
    expect(st.points.length, 'порог смягчили — линия начнёт врать (§12)').toBe(0);
    expect(st.dropped.accuracy).toBe(6);
  });

  it('такая запись даёт пустой черновик, а не короткий', () => {
    let st = emptyRecorder();
    [500, 1000, 100].forEach((acc, i) => { st = acceptFix(st, fix(i, acc)).state; });
    // Меньше двух точек — сохранять и паковать нечего: отсюда и ноль на
    // сервере, а вовсе не из отправки.
    expect(summarize(st).points).toBeLessThan(2);
  });

  it('точность в пределах порога принимается — дело не в самих засечках', () => {
    let st = emptyRecorder();
    [10, 12, 8].forEach((acc, i) => { st = acceptFix(st, fix(i, acc)).state; });
    expect(st.points.length).toBe(3);
  });

  it('порог остался прежним: смягчение — не починка', () => {
    expect(ACCEPT_ACCURACY_M).toBe(50);
  });
});

describe('у каждой причины отказа есть слова', () => {
  it('назван каждый род отказа, без пустых строк', () => {
    for (const reason of
      ['accuracy', 'unknown_accuracy', 'jitter', 'jump', 'bad_number'] as const) {
      expect(DROP_WORDS[reason], `нет слов для ${reason}`).toBeTruthy();
      expect(DROP_WORDS[reason].length).toBeGreaterThan(10);
    }
  });

  it('слова про точность называют сам порог, а не «плохой сигнал»', () => {
    // «Плохой сигнал» человек не может ни проверить, ни поправить.
    expect(DROP_WORDS.accuracy).toContain(String(ACCEPT_ACCURACY_M));
  });
});

describe('третий исход есть в хуке и отделён от молчания', () => {
  it('состояние отказа приёма объявлено в публичном API', () => {
    expect(HOOK).toMatch(/rejecting: string \| null;/);
  });

  it('отказ и молчание не путаются: молчит — значит не отказывает', () => {
    const at = HOOK.indexOf('setRejecting(');
    expect(at, 'отказ приёма нигде не выставляется').toBeGreaterThan(0);
    const block = HOOK.slice(HOOK.indexOf('const quiet ='), at + 400);
    expect(block).toMatch(/!quiet/);
  });

  it('считается по последней ПРИНЯТОЙ засечке, а не по последней виденной', () => {
    // Иначе поток отброшенных выглядел бы как здоровая работа — ровно то,
    // что и случилось.
    expect(HOOK).toMatch(/lastAcceptRef/);
    const at = HOOK.indexOf('setRejecting(');
    expect(HOOK.slice(HOOK.indexOf('const quiet ='), at + 400))
      .toMatch(/lastAcceptRef\.current/);
  });

  it('новая запись начинается с чистого листа', () => {
    const at = HOOK.indexOf('const start = useCallback');
    const body = HOOK.slice(at, at + 900);
    expect(body).toMatch(/lastAcceptRef\.current = Date\.now\(\)/);
    expect(body).toMatch(/lastDropRef\.current = null/);
  });
});

describe('экран говорит это человеку, а не только себе', () => {
  it('подпись кнопки вытесняется отказом раньше счётчиков', () => {
    const at = TRAIL.indexOf('recorder.rejecting');
    expect(at, 'экран не читает отказ приёма').toBeGreaterThan(0);
    // Отказ проверяется ДО silent и до сборки цифр: «0 тчк» формально не
    // врёт, но читается как нормальный ход записи.
    const hint = TRAIL.indexOf('hint: recorder.recording');
    const body = TRAIL.slice(hint, hint + 500);
    expect(body.indexOf('recorder.rejecting'))
      .toBeLessThan(body.indexOf('recorder.silent'));
  });

  it('причина целой фразой уходит в баннер, а не теряется в подписи', () => {
    expect(TRAIL).toMatch(/setFieldBarError\(recorder\.rejecting\)/);
  });
});
