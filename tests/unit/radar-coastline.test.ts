/**
 * Контур берега на радаре безопасности — местность, а не рисунок.
 *
 * История в трёх запросах владельца:
 *   «контур где?» — берег был почти прозрачным (strokeOpacity 0.25), а
 *   замыкание полигона (Z) тянуло хорду между крайними точками через весь скоп;
 *   «радар сломан» (09.08) — контур был ломаной из двух десятков узлов на весь
 *   полуостров, и прямые между ними резали скоп диагоналями через воду;
 *   «теперь контур Камчатки нужно постараться но сделать» — отсюда конвейер из
 *   Natural Earth и эти тесты.
 *
 * Стерегут инвариант, а не вёрстку: берег приходит из источника, куски не
 * сшиваются, упрощение не добавляет форм.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COASTLINE, coastPaths } from '@/lib/geo/coastline';

const src = readFileSync(join(process.cwd(), 'components/safety/LiveStatus.tsx'), 'utf-8');
const KM_LAT = 111.32;

function project(center: { lat: number; lng: number }) {
  const kmLng = KM_LAT * Math.cos((center.lat * Math.PI) / 180);
  return (lat: number, lng: number): [number, number] => [
    100 + (((lng - center.lng) * kmLng) / 200) * 92,
    100 - (((lat - center.lat) * KM_LAT) / 200) * 92,
  ];
}

describe('данные контура', () => {
  it('пришли из Natural Earth, а не из головы', () => {
    expect(COASTLINE.source).toMatch(/Natural Earth/i);
    expect(COASTLINE.parts.length).toBeGreaterThan(0);
  });

  it('накрывают Камчатку целиком, а не одну Авачинскую бухту', () => {
    const lats = COASTLINE.parts.flat().map((p) => p[1]);
    const lngs = COASTLINE.parts.flat().map((p) => p[0]);
    expect(Math.min(...lats)).toBeLessThan(52);
    expect(Math.max(...lats)).toBeGreaterThan(60);
    expect(Math.min(...lngs)).toBeLessThan(156);
    expect(Math.max(...lngs)).toBeGreaterThan(163);
  });

  it('точек хватает на форму, но не столько, чтобы грузить каждого посетителя', () => {
    const total = COASTLINE.parts.reduce((n, p) => n + p.length, 0);
    expect(total).toBeGreaterThan(300);
    expect(total).toBeLessThanOrEqual(1500);
  });

  it('звенья короче 400 км — иначе отсечение дальних кусков резало бы форму', () => {
    // coastPaths выбрасывает точки дальше 400 км от центра. Это безопасно,
    // только пока звено не может дотянуться от такой дали до 200-км скопа:
    // точка на отрезке отстоит от ближнего конца не больше чем на половину
    // его длины. Ломается инвариант — падает этот тест, а не радар.
    let max = 0;
    for (const part of COASTLINE.parts) {
      for (let i = 1; i < part.length; i++) {
        const [aLng, aLat] = part[i - 1];
        const [bLng, bLat] = part[i];
        const km = Math.hypot(
          (bLat - aLat) * KM_LAT,
          (bLng - aLng) * KM_LAT * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180),
        );
        max = Math.max(max, km);
      }
    }
    expect(max).toBeLessThan(400);
  });
});

describe('построение путей', () => {
  const ppk = { lat: 53.02, lng: 158.65 };

  it('из Петропавловска берег виден', () => {
    const paths = coastPaths(ppk, project(ppk));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.join('')).toMatch(/^M/);
  });

  it('куски не сшиваются: каждый путь начинается своим M и внутри только L', () => {
    // Одна строка на все куски провела бы берег там, где его нет, — ровно та
    // ложная диагональ, из-за которой радар и был назван сломанным.
    for (const d of coastPaths(ppk, project(ppk))) {
      expect(d.startsWith('M')).toBe(true);
      expect(d.slice(1)).not.toContain('M');
    }
  });

  it('путь не замыкается: берег — линия, а не блоб', () => {
    expect(coastPaths(ppk, project(ppk)).join(' ')).not.toMatch(/\bZ\b/);
  });

  it('центр уехал — берег уехал вместе с ним', () => {
    const other = { lat: 56.5, lng: 160.5 };
    const a = coastPaths(ppk, project(ppk)).join(' ');
    const b = coastPaths(other, project(other)).join(' ');
    expect(a).not.toEqual(b);
  });

  it('вдали от Камчатки берега нет, а не выдуманная линия', () => {
    const far = { lat: 20, lng: 100 };
    expect(coastPaths(far, project(far))).toEqual([]);
  });
});

describe('радар пользуется этим контуром', () => {
  it('своих координат берега в компоненте не осталось', () => {
    expect(src).toMatch(/coastPaths\(/);
    expect(src).not.toMatch(/const COASTLINE: Array<\[number, number\]>/);
  });

  it('временного порога длины звена больше нет — он был затычкой к выдуманным узлам', () => {
    expect(src).not.toContain('MAX_SEGMENT_KM');
  });

  it('куски рисуются отдельными путями', () => {
    expect(src).toMatch(/coastSegments\.map\(/);
  });

  it('контур видимый: без заливки-блоба, заметный штрих', () => {
    const i = src.indexOf('coastSegments.map(');
    const path = src.slice(i, i + 320);
    expect(path).toContain('fill="none"');
    expect(path).toMatch(/strokeOpacity="0\.5[0-9]?"/);
  });

  it('кольца подписаны расстоянием — единственное, что радар знает точно', () => {
    expect(src).toMatch(/\{Math\.round\(MAX_KM \* k\)\} км/);
  });

  it('подпись кольца — сноска, а не заголовок', () => {
    // Владелец 09.08 о скрине: подписи колец кричали крупнее самих данных.
    const rk = src.slice(src.indexOf('.kh-live .radar .rk{'), src.indexOf('.kh-live .radar .rk{') + 140);
    const size = Number(/font:\d+ ([\d.]+)px/.exec(rk)?.[1] ?? 99);
    expect(size).toBeLessThanOrEqual(5.5);
  });

  it('пустое состояние не заслоняет центр радара', () => {
    const clean = src.slice(src.indexOf('.kh-live .radar .clean{'), src.indexOf('.kh-live .radar .clean{') + 160);
    expect(clean).not.toMatch(/top:50%/);
  });
});
