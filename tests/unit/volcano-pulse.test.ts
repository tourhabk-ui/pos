/**
 * «Пульс вулканов» — график по образу сейсмического, но из данных KVERT.
 *
 * Владелец 02.09, после того как вулканы попали на радар: «нужен график
 * вулканов как у сейсмики». Сторож держит то, чем этот график отличается от
 * рисунка: столбики — настоящие вулканы с кодом, зелёные не выброшены,
 * устаревшее наблюдение названо, сбой запроса не выдаётся за спокойствие.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const DATA = strip(read('app/_home/data.ts'));
const LIVE = strip(read('components/safety/LiveStatus.tsx'));
const SAFETY = strip(read('app/safety/_SafetyClient.tsx'));

describe('данные', () => {
  it('столбики — строки volcano_status, привязанные к месту', () => {
    const at = DATA.indexOf('async function fetchVolcanoPulse');
    expect(at).toBeGreaterThan(0);
    const fn = DATA.slice(at, at + 1500);
    expect(fn).toMatch(/FROM volcano_status vs/);
    expect(fn).toMatch(/JOIN places p ON vs\.place_ark_id = p\.ark_id/);
  });

  it('зелёные не выброшены — только unassigned', () => {
    // Пульс из одних повышенных в спокойный день пуст, а пустота на слое
    // безопасности неотличима от «не дошло».
    const at = DATA.indexOf('async function fetchVolcanoPulse');
    const fn = DATA.slice(at, at + 1500);
    expect(fn).toMatch(/aviation_color_code <> 'unassigned'/);
    expect(fn).not.toMatch(/IN \('yellow','orange','red'\)/);
  });

  it('сбой запроса — degraded, а не пустой спокойный пульс', () => {
    const at = DATA.indexOf('async function fetchVolcanoPulse');
    const fn = DATA.slice(at, at + 2000);
    expect(fn).toMatch(/console\.error\('\[home\] пульс вулканов не выбрался/);
    expect(fn).toMatch(/degraded: true/);
  });

  it('пульс едет тем же снимком, что радар и сейсмика', () => {
    expect(DATA).toMatch(/volcanoes: VolcanoSnapshot;/);
    expect(DATA).toMatch(/return \{ safety, seismic, radar, volcanoes \}/);
  });
});

describe('компонент', () => {
  const at = LIVE.indexOf('export function VolcanoPulse');
  const comp = LIVE.slice(at, at + 4000);

  it('есть и стоит на /safety', () => {
    expect(at).toBeGreaterThan(0);
    expect(SAFETY).toMatch(/<VolcanoPulse items=\{live\.volcanoes\.items\} degraded=\{live\.volcanoes\.degraded\}/);
  });

  it('высота и цвет — по коду KVERT, а не по чему-то выдуманному', () => {
    expect(comp).toMatch(/ACC_BAR_H\[v\.acc\]/);
    expect(comp).toMatch(/meta\(v\.acc\)\.token/);
    expect(LIVE).toMatch(/const ACC_BAR_H: Record<string, number> = \{ green: 28, yellow: 52, orange: 76, red: 100 \}/);
  });

  it('ось названа честно: не время, а активность', () => {
    // Истории кодов нет — одна строка на вулкан. Подпись «старее → сейчас»
    // обещала бы хронологию, которой в данных нет.
    expect(comp).toMatch(/спокойнее/);
    expect(comp).toMatch(/активнее →/);
    expect(comp).not.toMatch(/старее/);
  });

  it('устаревшее наблюдение названо словами', () => {
    expect(comp).toMatch(/isVolcanoObservationStale/);
    expect(comp).toMatch(/сверьте на KVERT/);
  });

  it('degraded с пустым списком — не «тихо», а «не получены»', () => {
    expect(comp).toMatch(/Коды вулканов не получены — считать спокойным нельзя/);
  });

  it('повышенные названы поимённо под графиком, а не только счётом', () => {
    // Владелец, увидев пульс: «только Шивелуч?». В шапке — один самый
    // активный; кто ещё с повышенным кодом, должно читаться без тапа.
    expect(comp).toMatch(/повышенный код у \$\{elevated\.length\}: /);
    expect(comp).toMatch(/elevated\s*\.map\(\(v\) => `\$\{v\.name/);
    expect(comp).toMatch(/повышенных кодов нет/);
  });

  it('тап ведёт на карточку места', () => {
    expect(comp).toMatch(/href=\{`\/places\/\$\{selected\.placeId\}`\}/);
  });
});
