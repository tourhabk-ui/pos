/**
 * Офлайн-QR с координатами на SOS-экранах.
 *
 * Смысл (31.07, разбор связи на маршрутах): у терпящего бедствие экран с
 * координатами есть, а у спасателя/попутчика — глаза и свой телефон. QR с
 * geo:-точкой переносит координаты без сети, без диктовки и без ошибок в
 * пятом знаке. Генерация обязана быть полностью офлайн: вендоренный энкодер
 * лежит в public/safety/ и живёт в precache service worker'а.
 *
 * Сторож держит: работоспособность самого энкодера (функционально, не
 * сканом), офлайн-чистоту вендоренного файла, подключение обеих SOS-поверхностей,
 * честный гейт «QR только при реальных координатах» и precache.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const require_ = createRequire(import.meta.url);

describe('вендоренный энкодер работает и чист', () => {
  it('кодирует geo:-точку в валидный SVG (функционально, офлайн)', () => {
    const qrcode = require_(join(process.cwd(), 'public/safety/qrcode.js')) as (
      t: number, e: string,
    ) => { addData: (d: string) => void; make: () => void; createSvgTag: (o: object) => string };
    const qr = qrcode(0, 'M');
    qr.addData('geo:53.02417,158.64361');
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 0 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
  });

  it('не ходит в сеть: ни fetch, ни XHR, ни внешних URL в коде', () => {
    const src = read('public/safety/qrcode.js')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(src).not.toMatch(/fetch\s*\(/);
    expect(src).not.toMatch(/XMLHttpRequest/);
    // Единственный допустимый URL — обязательный XML-неймспейс SVG-разметки
    // (строка-константа, не сетевой вызов). Всё прочее — запрещено.
    const urls = src.match(/https?:\/\/[^\s"'<)]+/g) ?? [];
    expect(urls.filter((u) => u !== 'http://www.w3.org/2000/svg')).toEqual([]);
  });
});

describe('обе SOS-поверхности подключены', () => {
  it('/emergency грузит энкодер и рисует QR при координатах', () => {
    const html = read('public/emergency.html');
    expect(html).toContain('/safety/qrcode.js');
    // Рендер — внутри onGPSSuccess (только реальные координаты) и под
    // защитой typeof: не загрузился энкодер — экран не страдает.
    expect(html).toContain("typeof qrcode!=='undefined'");
    expect(html).toMatch(/qr\.addData\('geo:'\+lat\+','\+lng\)/);
  });

  it('/sos грузит энкодер тем же паттерном и рендерит только при coords', () => {
    const src = read('app/sos/page.tsx')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(src).toContain('ensureQrModule');
    expect(src).toContain("'/safety/qrcode.js'");
    // Гейт честности: QR не рисуется без реальных координат — на last-known
    // или при ошибке сканирующий получил бы не то место, где человек стоит.
    // Свежесть — через ключ координат: SVG прежней точки с новой не совпадёт.
    expect(src).toMatch(/qrState\.key === qrKey/);
    expect(src).toMatch(/\{qrSvg && coords && \(/);
  });
});

describe('офлайн-гарантия: precache', () => {
  const sw = read('public/sw.js');

  it('энкодер в CRITICAL_URLS — без него QR не появится в поле', () => {
    expect(sw).toContain("'/safety/qrcode.js'");
    const critical = sw.slice(sw.indexOf('const CRITICAL_URLS'), sw.indexOf('];', sw.indexOf('const CRITICAL_URLS')));
    expect(critical).toContain('/safety/qrcode.js');
  });

  it('CACHE_NAME бампнут: старый SW не знает про новый файл', () => {
    const m = sw.match(/kamchatour-v(\d+)/);
    expect(Number(m?.[1] ?? 0)).toBeGreaterThanOrEqual(20);
  });
});
