/**
 * Первый экран отвечает «с чего начать», а не пересказывает ленту МЧС.
 *
 * Стратегия 14.08 (слово владельца «го»): заголовок героя — конверсионный
 * посыл с одним главным шагом «Собрать план» (/planner), статус дня остаётся
 * строкой-доказательством ниже. До этого заголовком первого экрана стояла
 * необрезанная простыня из ленты МЧС — склеенные два предложения на четыре
 * строки (проба 100 сняла это с прода дословно).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'components/homepage/HeroStatus.tsx'),
  'utf-8',
);

describe('план — первым действием', () => {
  it('заголовок героя — посыл, а не topTitle из ленты', () => {
    expect(SRC).toMatch(/Соберите безопасную поездку на Камчатку/);
    // topTitle не может быть содержимым h2: он живёт только в alertLine.
    expect(SRC).not.toMatch(/<h2[^>]*>[^<]*\{headline\}/);
  });

  it('главная кнопка ведёт в планировщик', () => {
    expect(SRC).toMatch(/href="\/planner"/);
    expect(SRC).toMatch(/Собрать план/);
  });

  it('поиск остаётся второй ролью — «я уже знаю маршрут»', () => {
    expect(SRC).toMatch(/action="\/routes"/);
    expect(SRC).toMatch(/Я уже знаю маршрут/);
  });
});

describe('статус дня — строка-доказательство, не заголовок', () => {
  it('заголовок предупреждения режется ОБЩИМ clip, а не своим', () => {
    // Две поверхности об одном предупреждении обязаны говорить одинаково —
    // тот же резак, что в ленте /safety (LiveStatus.clip).
    expect(SRC).toMatch(/import \{ clip \} from '@\/components\/safety\/LiveStatus'/);
    expect(SRC).toMatch(/clip\(safety\.topTitle/);
  });

  it('строка ведёт на /safety — главная не подменяет ленту', () => {
    expect(SRC).toMatch(/href="\/safety"/);
  });

  it('нет предупреждений — нет блока (пустое «всё спокойно» не обещаем)', () => {
    expect(SRC).toMatch(/\{alertLine && \(/);
  });
});
