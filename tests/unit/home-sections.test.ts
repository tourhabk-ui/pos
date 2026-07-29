/**
 * Композиция гостевой главной: одна дверь в каталог, а не три.
 *
 * Было: «Куда сегодня», «Стихии» и «Разделы» — три самостоятельные секции со
 * своими заголовками, ведущие в один и тот же каталог. Плюс «Собрать поездку»
 * дублировала обещание блока Кузьмича. Это не богатство выбора, а
 * нерешительность: человеку предлагали выбрать между несколькими входами в
 * одну комнату.
 *
 * Сторож следит, чтобы двери не разъехались обратно при следующей правке, —
 * и чтобы при схлопывании ничего не пропало: плитки стихий, разделы платформы
 * и лид-форма остались на месте, просто перестали быть отдельными дверями.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/_home/_HomeV8Client.tsx'), 'utf-8');
/** Только разметка: пояснения в комментариях цитируют старые заголовки. */
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Заголовки секций, которые реально увидит человек. */
function headings(): string[] {
  return [...CODE.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1].trim());
}

describe('двери в каталог схлопнуты', () => {
  const h = headings();

  it.each(['Куда сегодня', 'Стихии', 'Разделы', 'Собрать поездку'])(
    'секция «%s» больше не самостоятельная дверь',
    (title) => {
      expect(h, `«${title}» снова стала отдельной секцией`).not.toContain(title);
    },
  );

  it('вход в каталог ровно один — «Исследовать»', () => {
    expect(h).toContain('Исследовать');
    expect(h.filter((x) => x === 'Исследовать')).toHaveLength(1);
  });

  it('заголовков на главной немного — иначе это снова лендинг из дверей', () => {
    expect(h.length).toBeLessThanOrEqual(5);
  });
});

describe('при схлопывании ничего не потерялось', () => {
  it('плитки стихий на месте', () => {
    expect(CODE).toMatch(/elements\.map/);
    expect(CODE).toMatch(/ELEMENT_ICON/);
  });

  it('разделы платформы на месте', () => {
    expect(CODE).toMatch(/className="hubline"/);
    expect(CODE).toMatch(/href="\/gear"/);
    expect(CODE).toMatch(/href="\/accommodations"/);
  });

  it('лид-форма и её POST не тронуты, якорь #lead жив', () => {
    // «Собрать поездку» перестала быть секцией, но форма — рабочая воронка,
    // и ссылка «Подобрать тур» у Кузьмича по-прежнему ведёт сюда.
    expect(CODE).toMatch(/id="lead"/);
    expect(CODE).toMatch(/submitLead/);
    expect(CODE).toMatch(/leadRef/);
  });
});

describe('живой блок обстановки честен', () => {
  it('свежесть считается общим модулем, а не своей формулой', () => {
    expect(CODE).toMatch(/dataFreshness/);
    expect(CODE).toMatch(/freshnessDot/);
  });

  it('когда точки нет — не подставляется зелёный по умолчанию', () => {
    // freshnessDot возвращает null для «недоступно». Если бы здесь стоял
    // фолбэк на --success, недоступный источник выглядел бы как «всё хорошо».
    expect(CODE).not.toMatch(/freshnessDot\([^)]*\)\s*\|\|\s*['"]var\(--success\)/);
  });
});
