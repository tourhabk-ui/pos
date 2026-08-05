/**
 * Кнопка отзыва работает, снасти не сдаются в аренду.
 *
 * Два замечания владельца 05.08 по живой карточке.
 *
 * 1. «Оставить отзыв не работает». Так и было: `<span>`, стилизованный под
 *    кнопку, без обработчика и без ссылки. Элемент выглядел как действие и не
 *    делал ничего — тот же класс, что мёртвая ссылка `/hub/tour/{id}` в фиде
 *    Авито: интерфейс обещает то, чего за ним нет.
 *
 * 2. «Снасти ты так и не убрал аренду». Миграция 819 не сработала на живых
 *    данных: она выбирала ОДИН «канонический» тур через `ORDER BY ... LIMIT 1`,
 *    а такой выбор молча промахивается — ноль изменённых строк неотличим от
 *    успеха. 821 правит все туры оператора, без выбора.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const CARD = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
const FORM = read('components/marketplace/TourReviewForm.tsx');
const M821 = read('migrations/821_bystraya_tackle_by_operator.sql');

/** SQL без строк-комментариев: пояснения не должны считаться кодом. */
const sql = M821.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

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

describe('миграция 821: снасти, повторный заход', () => {
  it('правит все туры оператора, без выбора одного', () => {
    // 819 выбирала канонический тур через LIMIT 1 и промахнулась молча.
    expect(sql).not.toMatch(/LIMIT 1/);
    expect(sql).toMatch(/p\.slug = 'kamchatka-rafting'/);
  });

  it('чужого оператора не трогает', () => {
    // У «Камчатской Рыбалки» аренда снастей — их настоящие условия.
    expect(sql).toMatch(/FROM partners p/);
    expect(sql).toMatch(/p\.id = ot\.operator_id/);
  });

  it('убирает аренду в любой формулировке и с любой ценой', () => {
    expect(sql).toMatch(/\(аренд\|прокат\)/);
    expect(sql).toMatch(/\(снаст\|удоч\|спиннинг\)/);
  });

  it('массивы не переписываются целиком, порядок сохраняется', () => {
    expect(sql).not.toMatch(/SET not_included = ARRAY\[/);
    expect(sql).toMatch(/WITH ORDINALITY/);
    expect(sql).toMatch(/array_agg\(x ORDER BY ord\)/);
  });

  it('идемпотентна: срабатывает, только пока есть что чинить', () => {
    expect(sql).toMatch(/EXISTS/);
    expect(sql).toMatch(/NOT EXISTS/);
  });
});
