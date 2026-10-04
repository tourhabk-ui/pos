/**
 * Единая медвежья доктрина — вердикт экспертов проекта «Земля медведя»
 * (Фонд защитников природы; охотовед Кроноцкого заповедника), 01.08.2026.
 *
 * До этого дня платформа спорила сама с собой: AI Спасатель говорил
 * «притворись мёртвым», офлайн-протоколы — «бей в нос и глаза, не ложись —
 * только активное сопротивление». Второе — миф из доктрины чёрных медведей,
 * которых на Камчатке нет. Экспертный вердикт для бурого: контакта не
 * избежать → сгруппироваться, защитить голову/шею/живот, НЕ сопротивляться.
 *
 * Сторож держит все поверхности с тактикой на одном вердикте: разъезжались
 * уже дважды, это safety-контент — расхождение стоит жизни.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SURFACES = [
  'app/_home/_HomeV8Client.tsx',
  'app/safety/offline/page.tsx',
  'app/api/safety/rescue-chat/route.ts',
  // Офлайн-протоколы радара, хаба и /sos — один список с 04.10.
  'lib/safety/rescue-protocols.ts',
  'public/emergency.html',
];

/** Экраны, которые раньше держали СВОЮ копию протоколов (и копии разошлись). */
const PROTOCOL_CONSUMERS = [
  'app/safety/_SafetyClient.tsx',
  'app/hub/safety/_SafetyHubClient.tsx',
  'components/safety/RescueChat.tsx',
];

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
/** Только код/контент: комментарии цитируют старые формулировки как историю. */
const code = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l) && !/^\s+.*-->\s*$/.test(l)).join('\n');

describe('медвежья тактика едина на всех поверхностях', () => {
  it.each(SURFACES)('%s: мифическая доктрина не вернулась', (p) => {
    const src = code(read(p));
    expect(src, '«бей в нос» вернулся — это миф чёрных медведей, на Камчатке их нет')
      .not.toMatch(/бей (антизверем )?в нос/i);
    expect(src, '«только активное сопротивление» вернулось — для бурого это опасный совет')
      .not.toMatch(/только активное сопротивление/i);
    expect(src, '«притворись мёртвым» — формулировка-миф; вердикт: сгруппироваться и не сопротивляться')
      .not.toMatch(/притвор(ись|яйся) мёртвым/i);
  });

  it.each(SURFACES)('%s: экспертный вердикт присутствует', (p) => {
    const src = code(read(p));
    expect(src, 'пропал вердикт «сгруппируйся»').toMatch(/сгруппир/i);
    expect(src, 'пропало «не сопротивляйся»').toMatch(/не сопротивля/i);
  });

  it.each(PROTOCOL_CONSUMERS)('%s: протоколы из общего списка, своей копии нет', (p) => {
    const src = read(p);
    expect(src).not.toMatch(/const LOCAL_PROTOCOLS/);
    expect(src).toMatch(/from '@\/lib\/safety\/rescue-protocols'|from '@\/components\/safety\/RescueChat'/);
  });

  it('офлайн-копия дойдёт до людей: CACHE_NAME поднят минимум до v21', () => {
    // emergency.html прекэширован: без бампа телефон в тайге хранит старый
    // протокол с «бей и не ложись» до следующего онлайн-визита.
    const m = /const CACHE_NAME = 'kamchatour-v(\d+)'/.exec(read('public/sw.js'));
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(21);
  });
});
