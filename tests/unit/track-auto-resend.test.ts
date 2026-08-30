/**
 * Недописанный трек досылается сам, как и наблюдение — а не только по
 * второму заходу человека.
 *
 * Живой скрин владельца 30.08: записал трек до Зеленовских озерков в поле,
 * нажал «Остановить» без сети. Кнопка честно сказала «отправится при
 * связи» — но фактически ждала, что человек САМ ещё раз откроет запись
 * (кнопка «есть недописанная») и остановит её повторно. У наблюдений
 * (`useTrailObservationQueue`, ObservationSheet.tsx) автодожим по событию
 * `online` уже существовал; у трека — нет. Один и тот же полевой экран,
 * два похожих обещания «отправится само», и только одно было правдой.
 *
 * Фикс: `useTrackRecorder` умеет пакетировать лежащий на диске черновик
 * без запуска записи (`packageDraft`), а экран слушает `online` и тихо
 * пробует отправить — без баннера ошибки на фоновой попытке, которую
 * никто не нажимал (дальше пробует на следующее `online`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const HOOK = read('hooks/useTrackRecorder.ts');
const TRAIL = read('app/planning/_PlanningClient.tsx');

describe('useTrackRecorder: черновик можно упаковать без запуска записи', () => {
  it('packageDraft не трогает watch/recording — просто читает stateRef', () => {
    const fn = HOOK.slice(HOOK.indexOf('const packageDraft ='), HOOK.indexOf('return { recording'));
    expect(fn).toMatch(/stateRef\.current/);
    expect(fn).not.toMatch(/setRecording\(true\)/);
    expect(fn).not.toMatch(/watchPosition/);
  });

  it('меньше двух точек — пакетировать нечего (null, не пустой gpx)', () => {
    const fn = HOOK.slice(HOOK.indexOf('const packageDraft ='), HOOK.indexOf('return { recording'));
    expect(fn).toMatch(/st\.points\.length < 2\) return null/);
  });

  it('экспортируется в публичном API хука', () => {
    expect(HOOK).toMatch(/packageDraft: \(\) => \{ gpx: string; summary: TrackSummary \} \| null;/);
    expect(HOOK).toMatch(/return \{ recording, summary, silent, error, start, stop, discard, restored, packageDraft \};/);
  });
});

/**
 * Границы блока автодожима: от разбора причины до конца эффектов, которые
 * его запускают. Внутренняя раскладка блока с тех пор поменялась (см.
 * track-draft-flush.test.ts: 30.08 добавили вторую точку входа — черновик,
 * найденный на диске, — и общую функцию `flushTrackDraft`), поэтому сторож
 * судит область целиком, а не конкретный список зависимостей useCallback:
 * иначе он ломается на каждой перестановке, ничего не говоря о поведении.
 */
const flushRegion = () => {
  const at = TRAIL.indexOf('Автодожим недописанного трека');
  expect(at, 'блок автодожима трека не найден').toBeGreaterThan(0);
  const end = TRAIL.indexOf('const fieldActions', at);
  expect(end, 'не найден конец блока автодожима').toBeGreaterThan(at);
  return TRAIL.slice(at, end);
};

describe('экран маршрута: трек досылается сам при возврате связи', () => {
  it('слушает online, как и очередь наблюдений', () => {
    const body = flushRegion();
    expect(body).toMatch(/addEventListener\('online'/);
    expect(body).toMatch(/recorder\.packageDraft\(\)/);
  });

  it('не мешает активной записи — там распоряжается явное «Остановить»', () => {
    // Проверка переехала из обработчика `online` в общую `flushTrackDraft`:
    // теперь она прикрывает ОБА входа, а не только событие связи.
    const at = TRAIL.indexOf('const flushTrackDraft');
    expect(at, 'нет общей функции дожима').toBeGreaterThan(0);
    const body = TRAIL.slice(at, at + 700);
    expect(body).toMatch(/recorder\.recording\) return;/);
  });

  it('успешная фоновая отправка снимает черновик — recorder.discard()', () => {
    const body = flushRegion();
    expect(body).toMatch(/if \(!fail\) \{/);
    expect(body).toMatch(/void recorder\.discard\(\);/);
  });

  it('явная отправка (stopAndSendTrack) и тихий автодожим шлют ОДНИМ и тем же путём', () => {
    // Регресс-гвард: если отправка снова продублируется в двух местах,
    // это ровно тот класс дефекта, из-за которого повторные фиксы
    // расходятся между собой (см. §12 CLAUDE.md про линии на карте —
    // тот же принцип, только про сетевой запрос, а не про геометрию).
    const sendFnAt = TRAIL.indexOf('const sendTrackGpx = useCallback');
    expect(sendFnAt).toBeGreaterThan(0);
    const usages = [...TRAIL.matchAll(/sendTrackGpx\(/g)];
    // Вызов в stopAndSendTrack + вызов в автодожиме = 2 (объявление —
    // `sendTrackGpx = useCallback(`, паттерн его не матчит).
    expect(usages.length).toBe(2);
  });
});
