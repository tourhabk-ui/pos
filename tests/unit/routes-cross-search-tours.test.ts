/**
 * Поиск по каталогу маршрутов находит и туры операторов (жалоба владельца 02.08).
 *
 * /routes ищет только места/маршруты (agent_route_knowledge). Тур по Быстрой
 * живёт в operator_tours и по запросу «сплав» не находился вовсе — турист видел
 * вулканы/реки, у которых слово есть в описании, но не сам тур. Теперь клиент
 * дополнительно ищет туры через существующий marketplace-API и показывает их
 * отдельной секцией. Карточка тура ведёт в /marketplace/tours/[id] (другой
 * корпус), а не в /routes/[id]. Это сторожа исходника, чтобы разрыв не вернулся.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const client = readFileSync(join(process.cwd(), 'app/routes/_RoutesPageClient.tsx'), 'utf-8');
const card = readFileSync(join(process.cwd(), 'components/routes/TourResultCard.tsx'), 'utf-8');

describe('каталог маршрутов подмешивает туры операторов', () => {
  it('клиент запрашивает туры по тому же тексту через marketplace-API', () => {
    expect(client).toMatch(/\/api\/hub\/marketplace\/tours\?search=/);
  });
  it('есть секция «Туры операторов» и рендер TourResultCard', () => {
    expect(client.includes('Туры операторов')).toBe(true);
    expect(client.includes('TourResultCard')).toBe(true);
  });
  it('пустой результат маршрутов не противоречит найденным турам', () => {
    // Когда мест/маршрутов нет, но туры есть — не показываем голое «Ничего не найдено».
    expect(client).toMatch(/tours\.length > 0[\s\S]{0,120}туры операторов выше/i);
  });
  it('карточка тура ведёт в каталог туров, а не в маршруты', () => {
    expect(card).toMatch(/href=\{`\/marketplace\/tours\/\$\{tour\.id\}`\}/);
    // href не должен указывать в /routes/ (это другой корпус) — проверяем сам href.
    expect(card).not.toMatch(/href=\{`\/routes\//);
  });
  it('цена приводится к числу (NUMERIC из БД может быть строкой)', () => {
    expect(card).toMatch(/Number\(tour\.base_price\)/);
  });
});
