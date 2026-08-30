/**
 * Записанный трек доходит до сервера, а не оседает на диске молча.
 *
 * ── Что случилось 30.08 ───────────────────────────────────────────────────
 *
 * Владелец записал реальный трек от 5 стройки. В `route_track_imports` на
 * проде — НОЛЬ строк за всё время (перепись track-import-queue: total 0).
 * Трек не дошёл, и об этом никто не сказал.
 *
 * Корень: автодожим висел ТОЛЬКО на событии `online`, а оно возникает лишь
 * на ПЕРЕХОДЕ офлайн→онлайн. Человек останавливает запись без сети,
 * возвращается в город и открывает приложение УЖЕ при связи — перехода нет,
 * события нет, черновик лежит на диске навсегда. Единственным следом была
 * подпись «есть недописанная» на кнопке, которая не говорила главного:
 * запись цела и ждёт отправки.
 *
 * Это тот же отказ, что в тот же день чинили у фото: работа сделана,
 * результат не доехал, предупреждения нет (CLAUDE.md 4.0).
 *
 * Сторож держит обе половины починки: вторую точку входа (черновик найден
 * на диске) и замки, без которых она превращается в цикл отправок.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/planning/_PlanningClient.tsx'),
  'utf-8',
);

/** Судим код, а не комментарии: разбор рядом с правкой вправе её называть. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('дожим черновика трека', () => {
  it('срабатывает не только по событию online', () => {
    // Событие online — переход, а не состояние. Одного его мало.
    const at = CODE.indexOf('recorder.restored');
    expect(at, 'нет ветки «черновик найден на диске»').toBeGreaterThan(0);
    const block = CODE.slice(at - 200, at + 300);
    expect(block).toMatch(/flushTrackDraft\(\)/);
  });

  it('событие online по-прежнему дожимает', () => {
    expect(CODE).toMatch(/addEventListener\('online'/);
  });

  it('отправка идёт через одну общую функцию, а не двумя копиями', () => {
    // Две копии логики отправки разойдутся поведением — тот же урок, что у
    // SOS (#887) и у карточки тура.
    expect(CODE).toMatch(/const flushTrackDraft = useCallback/);
    const calls = [...CODE.matchAll(/sendTrackGpx\(/g)];
    // Ровно два вызова: явная остановка кнопкой и общий дожим.
    expect(calls.length).toBe(2);
  });
});

describe('замки против повторной и одновременной отправки', () => {
  it('замок от одновременной отправки — событие и монтирование могут совпасть', () => {
    expect(CODE).toMatch(/trackFlushInFlightRef/);
    const at = CODE.indexOf('const flushTrackDraft');
    const block = CODE.slice(at, at + 700);
    expect(block).toMatch(/if \(trackFlushInFlightRef\.current/);
    expect(block).toMatch(/finally\(/);
  });

  it('замок от цикла: recorder пересоздаётся на каждом рендере', () => {
    // Без него эффект по recorder.restored слал бы трек снова и снова.
    expect(CODE).toMatch(/trackAutoTriedRef/);
    const at = CODE.indexOf('recorder.restored');
    const block = CODE.slice(at - 300, at + 300);
    expect(block).toMatch(/trackAutoTriedRef\.current/);
  });

  it('возвращение связи снимает замок повтора — это новый повод', () => {
    // Якорь — по САМОМУ снятию замка, а не по первому `online` в файле:
    // слушателей связи здесь несколько, и первый принадлежит давнему
    // эффекту про isOffline.
    const at = CODE.indexOf('trackAutoTriedRef.current = false');
    expect(at, 'замок повтора не снимается при возвращении связи').toBeGreaterThan(0);
    const block = CODE.slice(Math.max(0, at - 300), at + 300);
    expect(block).toMatch(/addEventListener\('online'|const onOnline/);
    expect(block).toMatch(/flushTrackDraft\(\)/);
  });

  it('явный офлайн не тратит попытку', () => {
    const at = CODE.indexOf('const flushTrackDraft');
    const block = CODE.slice(at, at + 700);
    expect(block).toMatch(/navigator\.onLine === false/);
  });
});

describe('застрявшая запись названа словами, а не шёпотом', () => {
  it('подпись говорит, что запись цела и ждёт отправки', () => {
    // Прежнее «есть недописанная» читалось как «что-то недоделано», и человек
    // шёл дальше, не зная, что трек ещё можно спасти.
    expect(CODE).toMatch(/запись сохранена/);
    expect(CODE).toMatch(/отправим при связи/);
    expect(CODE).not.toMatch(/'есть недописанная'/);
  });
});
