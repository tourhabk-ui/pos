/**
 * Главная «Подходит вам сейчас» показывает РЕАЛЬНЫЕ туры операторов, а не
 * места/маршруты. Прежде тянули из agent_route_knowledge (места+маршруты, туров
 * там нет) и добивали маршрутами — на телефоне коммерция была спрятана. Теперь
 * источник — operator_tours (только опубликованные, фото-first), честная пустота
 * без мест-заглушек.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const data = readFileSync(join(process.cwd(), 'app/_home/data.ts'), 'utf-8');
const plates = data.slice(data.indexOf('async function fetchPlates'), data.indexOf('async function fetchFeed'));

describe('главная: платы = туры операторов', () => {
  it('fetchPlates берёт из operator_tours, а не из каталога мест/маршрутов', () => {
    expect(plates).toContain('FROM operator_tours');
    expect(plates).toContain('is_published = true');
    expect(plates).toContain("kind: 'tour'");
  });
  it('не добивает витрину маршрутами (queryCatalog убран)', () => {
    expect(data).not.toContain('queryCatalog');
    expect(plates).not.toMatch(/kind: 'route'/);
  });
  it('честная пустота: нет туров → пустой массив', () => {
    expect(plates).toMatch(/catch\s*\{\s*return \[\];\s*\}/);
  });
});
