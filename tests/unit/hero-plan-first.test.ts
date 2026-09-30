/**
 * Первый экран отвечает «с чего начать», а не пересказывает ленту МЧС.
 *
 * Стратегия 14.08 (слово владельца «го»): заголовок героя — конверсионный
 * посыл с одним главным шагом «Собрать план» (/planner). До этого заголовком
 * первого экрана стояла необрезанная простыня из ленты МЧС.
 *
 * С 30.09 десктопный герой — «сводка дня поверх фото» (DeskHero): новость дня
 * живёт в стеклянной карточке справа, а H1 остаётся посылом. Поиск «я уже
 * знаю маршрут» из героя снят: он дублировал поиск шапки (иконка → модалка,
 * §2 CLAUDE.md), а в сводке место занято приборами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'components/homepage/desk/DeskHero.tsx'), 'utf-8');

describe('план — первым действием', () => {
  it('заголовок героя — посыл, а не topTitle из ленты', () => {
    expect(SRC).toMatch(/<h1 [^>]*>\s*Соберите безопасную поездку на Камчатку\s*<\/h1>/);
    expect(SRC).not.toMatch(/<h[12][^>]*>[^<]*\{[^}]*topTitle/);
  });

  it('главная кнопка ведёт в планировщик, вторая — в витрину', () => {
    expect(SRC).toMatch(/href="\/planner"[\s\S]{0,700}Собрать план/);
    expect(SRC).toMatch(/href="\/catalog"[\s\S]{0,700}Смотреть туры/);
  });
});

describe('новость дня — карточка сводки, не заголовок', () => {
  it('заголовок предупреждения режется ОБЩИМ clip, а не своим', () => {
    expect(SRC).toMatch(/import \{ clip \} from '@\/lib\/safety\/alert-clip'/);
    expect(readFileSync(join(process.cwd(), 'components/safety/LiveStatus.tsx'), 'utf-8')).toMatch(/import \{ clip \} from '@\/lib\/safety\/alert-clip'/);
    expect(SRC).toMatch(/clip\(safety\.topTitle/);
  });

  it('карточка ведёт на /safety — главная не подменяет ленту', () => {
    expect(SRC).toMatch(/href="\/safety"/);
  });

  it('спокойствие — только из свежей ленты; иначе «обстановка неизвестна»', () => {
    // Прежний герой прятал блок при молчащем кроне; теперь сказано словами.
    expect(SRC).toMatch(/if \(!safety \|\| \(!hasTop && !brief\.safetyTrusted\)\)/);
    expect(SRC).toMatch(/Это не значит, что всё спокойно/);
  });

  it('тревога узнаётся кромкой предупреждения на стекле, а не заливкой (§2)', () => {
    expect(SRC).toMatch(/borderLeftColor: 'var\(--warning\)'/);
    expect(SRC).toMatch(/className="fx-glass-dense/);
  });
});
