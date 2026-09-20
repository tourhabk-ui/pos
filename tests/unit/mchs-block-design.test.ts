/**
 * Вид блока регистрации МЧС: красный на странице один, и это SOS.
 *
 * ── Что чинилось 20.09 ────────────────────────────────────────────────────
 *
 * Блок регистрации был карточкой в красной рамке в два пикселя, с красной
 * шапкой, красной кнопкой телефона и сплошной красной кнопкой заявки. Рядом,
 * на той же странице, живёт настоящая красная кнопка — SOS. Когда красным
 * покрашена и подготовка к походу, цвет перестаёт значить опасность: глаз
 * привыкает, и в нужный момент тревога не отличается от рутины.
 *
 * Язык Ведара говорит это прямо (§7): красный — тревога и SOS, и ничего
 * больше. Регистрация в МЧС — обязанность, но не происшествие; строгость
 * несут слово «обязательна» и срок в шапке, а не яркость рамки.
 *
 * Сторож держит три вещи: цвет, вес (простыня из девяти строк ушла под
 * раскрытие) и то, что факты по-прежнему берутся из модуля, а не вписаны
 * руками. Проверяются ИСХОДНИКИ: до браузера тест не ходит, а покрашенная
 * рамка видна в разметке.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const block = readFileSync(join(ROOT, 'components/safety/MchsRegistrationBlock.tsx'), 'utf-8');
const routeCard = readFileSync(join(ROOT, 'app/routes/[id]/_RouteDetailClient.tsx'), 'utf-8');
const permit = readFileSync(join(ROOT, 'components/safety/ParkPermitAction.tsx'), 'utf-8');

describe('красный отдан тревоге', () => {
  it('в блоке регистрации нет --danger ни в одном виде', () => {
    expect(block).not.toMatch(/--danger/);
    expect(block).not.toMatch(/bg-red|text-red|border-red/);
  });

  it('строгость несёт текст: «обязательна» и срок остались', () => {
    expect(block).toMatch(/Регистрация в МЧС обязательна/);
    expect(block).toMatch(/MCHS_DEADLINE_SHORT/);
  });

  it('кнопка действия не заливается сплошным цветом состояния', () => {
    // Тот же разбор, что у блока разрешения парка: сплошная заливка делает
    // подготовку громче тревоги. Разбавленная — допустима.
    expect(block).not.toMatch(/background:\s*'var\(--warning\)'/);
    expect(block).toMatch(/color-mix\(in srgb, var\(--warning\) \d+%/);
  });

  it('карточка маршрута больше не рисует красную рамку вокруг регистрации', () => {
    // Раньше это жило прямо в карточке: borderColor: 'var(--danger)'.
    expect(routeCard).not.toMatch(/borderColor:\s*'var\(--danger\)'/);
    expect(routeCard).not.toMatch(/Заполнить заявку онлайн/);
  });
});

describe('вес блока', () => {
  it('каналы подачи и состав данных — под раскрытием, а не простынёй', () => {
    expect(block).toMatch(/<details\s+className=/);
    expect(block).toMatch(/<summary\s+className=[\s\S]{0,400}Как подать заявку/);
    // Индекс берётся по РАЗМЕТКЕ: `block.indexOf('<details')` ловил слово из
    // комментария выше и пропускал мутацию, в которой список вынесен наружу.
    const det = block.indexOf('<details className=');
    expect(block.indexOf('MCHS_CHANNELS.map')).toBeGreaterThan(det);
    expect(block.indexOf('MCHS_REQUIRED_DATA.map')).toBeGreaterThan(det);
  });

  it('свёрнуто не значит спрятано: почтовый и очный путь остаются в блоке', () => {
    // Если онлайн-форма недоступна, «зарегистрируйтесь» без второго способа
    // — совет, который нечем исполнить.
    expect(block).toMatch(/MCHS_CHANNELS/);
  });

  it('тач-цели не меньше 44px', () => {
    const targets = block.match(/min-h-\[44px\]/g) ?? [];
    expect(targets.length).toBeGreaterThanOrEqual(2);
  });
});

describe('два блока-близнеца', () => {
  it('регистрация и разрешение парка собраны одинаково', () => {
    // Одна обязанность перед спасателями, вторая перед парком. Разный вид у
    // одинаковых по смыслу блоков читался бы как разная важность.
    for (const [name, src] of [['мчс', block], ['парк', permit]] as const) {
      expect(src, `${name}: рамка блока`).toMatch(/rounded-lg border border-\[var\(--border\)\] bg-\[var\(--bg-card\)\]/);
      expect(src, `${name}: раскрытие`).toMatch(/<details\s+className=/);
      expect(src, `${name}: стекла нет`).not.toMatch(/backdrop-blur/);
      expect(src, `${name}: хардкод цвета`).not.toMatch(/#[0-9a-fA-F]{6}/);
      expect(src, `${name}: эмодзи`).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });

  it('карточка маршрута показывает оба и в этом порядке', () => {
    const mchs = routeCard.indexOf('<MchsRegistrationBlock');
    const park = routeCard.indexOf('<ParkPermitAction');
    expect(mchs).toBeGreaterThan(0);
    expect(park).toBeGreaterThan(mchs);
  });
});
