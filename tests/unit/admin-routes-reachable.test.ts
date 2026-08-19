/**
 * Действие, до которого нельзя дотянуться, — это отсутствующее действие.
 *
 * 18.08 владелец сообщил: «почему я не могу ничего редактировать в админке».
 * Права были в порядке, API отвечал, кнопки существовали и работали.
 *
 * Причина — в разметке: девять колонок таблицы стояли в контейнере с
 * `overflow-hidden`, и на телефоне две последние — «Видимость» и «Правка» —
 * обрезались за краем экрана. Владелец работает с телефона (все полевые
 * скрины оттуда), то есть управление контентом было недоступно ему целиком.
 *
 * Прокрутки для этого мало: тыкать в переключатель шириной сорок пикселей,
 * отмотав таблицу вбок, — не работа. Поэтому на узком экране список идёт
 * карточками, где действия стоят первыми.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = readFileSync(join(process.cwd(), 'app/hub/admin/content/routes/page.tsx'), 'utf-8');

describe('управление маршрутами доступно с телефона', () => {
  it('таблица не обрезает колонки молча', () => {
    // `overflow-hidden` на девяти колонках прятал действия без единого
    // признака, что что-то скрыто.
    const table = PAGE.slice(PAGE.indexOf('{/* Table */}'), PAGE.indexOf('</table>'));
    expect(table).not.toMatch(/overflow-hidden/);
    expect(table).toMatch(/overflow-x-auto/);
  });

  it('на узком экране список идёт карточками, а не таблицей', () => {
    expect(PAGE).toMatch(/md:hidden/);
    const table = PAGE.slice(PAGE.indexOf('{/* Table */}'), PAGE.indexOf('</table>'));
    expect(table).toMatch(/hidden md:block/);
  });

  it('в карточке есть оба действия — видимость и правка', () => {
    // Показ без правки оставил бы владельца зрителем собственных данных.
    const cards = PAGE.slice(PAGE.indexOf('md:hidden space-y-2'), PAGE.indexOf('{/* Table */}'));
    expect(cards).toMatch(/toggle\(r\.id, r\.isVisible\)/);
    expect(cards).toMatch(/openEdit\(r\.id\)/);
  });

  it('карточка показывает, чем запись плоха — иначе решать нечем', () => {
    // Скрыто 998 записей; чтобы разбирать очередь, надо видеть не только имя.
    const cards = PAGE.slice(PAGE.indexOf('md:hidden space-y-2'), PAGE.indexOf('{/* Table */}'));
    expect(cards).toMatch(/трек/);
    expect(cards).toMatch(/без точек/);
  });

  it('массовый выбор работает и с карточек', () => {
    const cards = PAGE.slice(PAGE.indexOf('md:hidden space-y-2'), PAGE.indexOf('{/* Table */}'));
    expect(cards).toMatch(/selected\.has\(r\.id\)/);
  });
});
