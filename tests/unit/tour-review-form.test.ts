/**
 * Кнопка отзыва — действие, а не картинка кнопки.
 *
 * Замечание владельца 05.08: «оставить отзыв не работает». Так и было: в
 * карточке стоял `<span>`, стилизованный под кнопку, без обработчика и без
 * ссылки. Элемент выглядел как действие и не делал ничего — тот же класс, что
 * мёртвая ссылка `/hub/tour/{id}` в фиде Авито: интерфейс обещает то, чего за
 * ним нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const CARD = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
const FORM = read('components/marketplace/TourReviewForm.tsx');

describe('отзыв: действие, а не картинка кнопки', () => {
  it('в карточке нарисованной кнопки больше нет', () => {
    // Именно этот <span> и «не работал».
    expect(CARD).not.toMatch(/<span[^>]*>\s*<PenLine[^>]*\/>\s*Оставить отзыв\s*<\/span>/);
    expect(CARD).toMatch(/<TourReviewForm tourId=/);
  });

  it('форма отправляет отзыв на существующий эндпоинт', () => {
    expect(FORM).toMatch(/\/api\/reviews\/tour\/\$\{tourId\}/);
    expect(FORM).toMatch(/method: 'POST'/);
  });

  it('кнопка — настоящая кнопка с обработчиком', () => {
    expect(FORM).toMatch(/<button[\s\S]*onClick=/);
  });

  it('отказ сервера показывается его словами', () => {
    // «Отзыв только после завершения тура» — это правило платформы, а не сбой:
    // человек должен его прочитать, а не гадать про «что-то пошло не так».
    expect(FORM).toMatch(/data\.error \?\?/);
  });

  it('правило про завершённую поездку названо вслух', () => {
    expect(FORM).toMatch(/после завершённой поездки/);
  });

  it('зоны нажатия не меньше 44 px — это мобильная карточка', () => {
    const targets = FORM.match(/minHeight: 44/g) ?? [];
    expect(targets.length).toBeGreaterThanOrEqual(3);
  });
});
