/**
 * Разведка не показывает одно и то же дважды.
 *
 * Живой случай 28.07: владелец открыл дайджест и сказал «это повтор» —
 * сюжет про антимонопольное дело Trip.com был в выпуске накануне. Межпрогонный
 * фильтр сравнивал только URL, а та же история пришла назавтра другой ссылкой
 * и прошла как свежая. Повтор в дайджесте — не косметика: он учит пролистывать,
 * и однажды пролистают настоящий сигнал.
 *
 * Тест чистый: filterUnseen не ходит ни в сеть, ни в память агента.
 */
import { describe, it, expect } from 'vitest';
import { filterUnseen, type SeenEntry } from '@/lib/agents/scout-digest';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 28, 1, 0, 0);

const item = (title: string, url: string) => ({ title, url, source: 'Skift' });

describe('filterUnseen — межпрогонный отсев повторов', () => {
  it('та же ссылка не проходит второй раз', () => {
    const seen: SeenEntry[] = [{ u: 'https://skift.com/a', t: NOW - DAY, h: 'Trip.com shuts down tool' }];
    const r = filterUnseen([item('Trip.com shuts down tool', 'https://skift.com/a')], seen, NOW);
    expect(r.fresh).toHaveLength(0);
    expect(r.repeatsByUrl).toBe(1);
  });

  it('та же история под другой ссылкой тоже не проходит — ради этого и делалось', () => {
    const seen: SeenEntry[] = [{
      u: 'https://skift.com/trip-com-antitrust',
      t: NOW - DAY,
      h: 'Trip.com отключила инструмент в центре антимонопольного дела в Китае',
    }];
    // Другое издание, другая ссылка, тот же сюжет чуть иными словами.
    const items = [item('Trip.com отключила инструмент, ставший центром антимонопольного дела', 'https://phocuswire.com/trip-com')];
    const r = filterUnseen(items, seen, NOW);
    expect(r.fresh).toHaveLength(0);
    expect(r.repeatsByTitle).toBe(1);
  });

  it('через три недели тот же сюжет проходит — это уже развитие, а не перепечатка', () => {
    const seen: SeenEntry[] = [{
      u: 'https://skift.com/trip-com-antitrust',
      t: NOW - 21 * DAY,
      h: 'Trip.com отключила инструмент в центре антимонопольного дела в Китае',
    }];
    const items = [item('Trip.com отключила инструмент, ставший центром антимонопольного дела', 'https://phocuswire.com/trip-com')];
    const r = filterUnseen(items, seen, NOW);
    // URL другой, окно сравнения заголовков (7 суток) истекло.
    expect(r.fresh).toHaveLength(1);
    expect(r.repeatsByTitle).toBe(0);
  });

  it('чужая новость того же источника проходит', () => {
    const seen: SeenEntry[] = [{
      u: 'https://skift.com/trip-com-antitrust',
      t: NOW - DAY,
      h: 'Trip.com отключила инструмент в центре антимонопольного дела в Китае',
    }];
    const items = [item('Airbnb добавила аренду автомобилей', 'https://skift.com/airbnb-cars')];
    const r = filterUnseen(items, seen, NOW);
    expect(r.fresh).toHaveLength(1);
    expect(r.repeatsByUrl + r.repeatsByTitle).toBe(0);
  });

  it('старые записи без заголовка не ломают фильтр (память от прошлых версий)', () => {
    // До этой правки в seen_urls писали только { u, t } — записи переживут деплой.
    const seen: SeenEntry[] = [{ u: 'https://skift.com/old', t: NOW - DAY }];
    const items = [item('Совсем другая новость про отели', 'https://skift.com/new')];
    const r = filterUnseen(items, seen, NOW);
    expect(r.fresh).toHaveLength(1);
  });

  it('пустая память пропускает всё', () => {
    const items = [item('Новость раз', 'https://a.example/1'), item('Новость два', 'https://a.example/2')];
    expect(filterUnseen(items, [], NOW).fresh).toHaveLength(2);
  });
});
