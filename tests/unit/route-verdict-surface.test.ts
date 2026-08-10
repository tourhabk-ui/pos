/**
 * Вердикт виден там, где принимают решение, и не исчезает при отказе.
 *
 * Ядро (go-verdict) и сбор сигналов (collect-signals) проверены отдельно.
 * Здесь стережётся доставка — место, где обычно и теряется вся честность
 * нижних слоёв:
 *
 *   `null` в сигналах обязан доехать до клиента как `null`. Стоит на границе
 *   подставить `[]` или `0`, и «не смогли узнать» снова станет «всё чисто».
 *
 *   Блок не имеет права исчезнуть. Соседний SafetyWarnings при неудачном
 *   запросе возвращает null, и экран выглядит спокойным — ровно тот дефект,
 *   который мы разбирали весь день. Здесь отказ сети даёт «Осторожно».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verdictLook, verdictInlineNote } from '@/lib/routes/verdict-presentation';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const API = read('app/api/routes/[id]/verdict/route.ts');
const BLOCK = read('components/routes/RouteVerdict.tsx');
const LOOK = read('lib/routes/verdict-presentation.ts');
const PAGE = read('app/routes/[id]/_RouteDetailClient.tsx');
// Поверхность вердикта — это компонент ПЛЮС модуль представления. Проверять
// надо их вместе: цвета и веса переехали из компонента в модуль, и гард,
// прибитый к одному файлу, не пустил правку, которая ничего не сломала.
const SURFACE = `${BLOCK}\n${LOOK}`;

describe('API отдаёт вердикт вместе с фактами', () => {
  it('считает правилами, а не заводит свои', () => {
    expect(API).toMatch(/from '@\/lib\/routes\/go-verdict'/);
    expect(API).toMatch(/from '@\/lib\/routes\/collect-signals'/);
    expect(API).toMatch(/goVerdict\(/);
  });

  it('сигналы уходят клиенту целиком — иначе факты под словом взять негде', () => {
    expect(API).toMatch(/signals/);
  });

  it('null не подменяется на границе', () => {
    // Любое из этих превращает «не смогли узнать» в «узнали, там пусто».
    expect(API).not.toMatch(/\?\?\s*\[\s*\]/);
    expect(API).not.toMatch(/\|\|\s*\[\s*\]/);
    expect(API).not.toMatch(/signals[^\n]*\?\?\s*0/);
  });

  it('идентификатор проверяется до запроса в базу', () => {
    expect(API).toMatch(/\[0-9a-f-\]\{36\}/i);
    // Сравнивать надо с ВЫЗОВОМ, а не с импортом: импорт стоит в шапке
    // файла и оказался бы «раньше» любой проверки.
    expect(API.indexOf('36}')).toBeLessThan(API.lastIndexOf('await collectRouteSignals('));
  });
});

describe('блок не исчезает', () => {
  it('отказ запроса даёт вердикт, а не пустоту', () => {
    // Проверяется поведение, а не текст: в catch должно ставиться состояние,
    // а не null. `setData(null)` или пустой catch вернули бы спокойный экран.
    expect(BLOCK).toMatch(/catch\([^)]*\)\s*=>\s*\{[^}]*setData\(/);
    expect(BLOCK).not.toMatch(/catch\([^)]*\)\s*=>\s*\{?\s*setData\(null\)/);
    expect(BLOCK).not.toMatch(/catch\s*\(\s*\)\s*=>\s*(null|undefined)\s*\)/);
  });

  it('запасной ответ — «Осторожно» с названной нехваткой, а не «Идти»', () => {
    const offline = BLOCK.slice(BLOCK.indexOf('const OFFLINE'), BLOCK.indexOf('const ACC_RU'));
    expect(offline).toMatch(/status:\s*'caution'/);
    expect(offline).not.toMatch(/status:\s*'go'/);
    expect(offline).toMatch(/unknown:\s*\[[^\]]+\]/);
    // Сигналы запасного ответа — именно null, а не пустые списки.
    expect(offline).toMatch(/alerts:\s*null/);
    expect(offline).toMatch(/volcanoes:\s*null/);
  });

  it('«не смогли узнать» показано словами, а не пропущено', () => {
    expect(BLOCK).toContain('не смогли узнать');
  });

  it('пустой список и незнание выглядят по-разному', () => {
    // Один и тот же текст на оба случая свёл бы различение к нулю на экране.
    const empty = BLOCK.match(/length === 0[\s\S]{0,220}/g)?.join('\n') ?? '';
    expect(empty).not.toContain('не смогли узнать');
  });
});

describe('блок стоит там, где решают', () => {
  it('подключён на карточке маршрута', () => {
    // Проверяется факт подключения, а не форма импорта: рядом с компонентом
    // из того же модуля теперь берётся общий хук, и прибитая к `import X from`
    // проверка не пустила бы эту правку.
    expect(PAGE).toMatch(/from '@\/components\/routes\/RouteVerdict'/);
    expect(PAGE).toMatch(/<RouteVerdict\s+routeId=/);
  });

  it('вердикт запрашивается один раз на страницу', () => {
    // Два fetch дали бы два источника правды об одном дне: блок наверху и
    // строка под кнопкой навигации могли бы разойтись.
    expect(PAGE).toMatch(/useRouteVerdict\(/);
    expect(PAGE).toMatch(/<RouteVerdict[^>]*data=/);
    expect((BLOCK.match(/fetch\(/g) ?? []).length).toBe(1);
  });

  it('выше подробностей маршрута, а не под ними', () => {
    // Человек приходит с одним вопросом; ответ не должен лежать под пятью
    // секциями. Точка отсчёта — блок оперативных ограничений.
    expect(PAGE.indexOf('<RouteVerdict')).toBeLessThan(PAGE.indexOf('ОПЕРАТИВНЫЕ ОГРАНИЧЕНИЯ'));
    expect(PAGE.indexOf('<RouteVerdict')).toBeLessThan(PAGE.indexOf('<SafetyWarnings'));
  });
});

describe('вес растёт с опасностью — правило одно, облик разный', () => {
  it('спокойный день тише осторожности, осторожность тише запрета', () => {
    // Соблазн «единого языка» — сделать три статуса одинакового веса, чтобы
    // смотрелись семейством. Тогда «Идти» тянуло бы внимание наравне с
    // запретом, и запрет перестал бы отличаться: тот же дефект, что у вечно
    // красного вердикта, только через типографику.
    expect(verdictLook('go').prominence).toBeLessThan(verdictLook('caution').prominence);
    expect(verdictLook('caution').prominence).toBeLessThan(verdictLook('no').prominence);
  });

  it('полоса — только у запрета', () => {
    expect(verdictLook('no').bar).toBe(true);
    expect(verdictLook('caution').bar).toBe(false);
    expect(verdictLook('go').bar).toBe(false);
  });

  it('спокойный день не предъявляет список проверенного', () => {
    // «Идти» — это «иди», а не «смотри, как я старался».
    expect(verdictLook('go').factsOpen).toBe(false);
    expect(verdictLook('caution').factsOpen).toBe(true);
    expect(verdictLook('no').factsOpen).toBe(true);
  });

  it('цвет каждого статуса — свой токен состояния', () => {
    expect(verdictLook('go').color).toBe('var(--success)');
    expect(verdictLook('caution').color).toBe('var(--warning)');
    expect(verdictLook('no').color).toBe('var(--danger)');
  });

  it('строка под кнопкой говорит только когда есть что сказать', () => {
    expect(verdictInlineNote('go', 'всё чисто')).toBeNull();
    expect(verdictInlineNote('no', 'МЧС: сход лавин')).toContain('лавин');
    expect(verdictInlineNote('caution', 'оранжевый код')).toContain('оранжевый');
  });
});

describe('вход в поле не запирается запретом', () => {
  it('кнопка навигации не получает disabled от вердикта', () => {
    // Кнопка ведёт на полевой экран — след, офлайн-карта, ступень связи. Он
    // нужен именно тому, кто уже вышел и как раз узнал про запрет; бан
    // адресован тому, кто ещё дома. Сказать обязаны, отобрать инструменты нет.
    const nav = PAGE.slice(PAGE.indexOf('handleStartNavigation'));
    expect(nav).not.toMatch(/disabled=\{[^}]*verdict/);
    expect(PAGE).toMatch(/verdictInlineNote\(/);
  });

  it('строка стоит ПОД кнопкой, а не вместо неё', () => {
    const btn = PAGE.indexOf('Начать навигацию');
    const note = PAGE.indexOf('verdictInlineNote(verdictData.verdict.status');
    expect(btn).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(btn);
  });
});

describe('дизайн-система соблюдена', () => {
  it('цвета — токенами, без хардкода hex', () => {
    expect(SURFACE).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(SURFACE).toContain('var(--success)');
    expect(SURFACE).toContain('var(--warning)');
    expect(SURFACE).toContain('var(--danger)');
  });

  it('стекла на сплошном фоне нет', () => {
    expect(SURFACE).not.toMatch(/backdrop-blur/);
  });

  it('иконки только lucide, эмодзи нет', () => {
    expect(BLOCK).toMatch(/from 'lucide-react'/);
    expect(SURFACE).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('вердикт не подменяет собой кнопку СОС', () => {
    // СОС — только components/shared/EmergencyAction. Копия расходится
    // поведением, это уже случалось (#887).
    expect(SURFACE).not.toMatch(/SOS|СОС/);
  });

  it('дисплейный шрифт — только Playfair', () => {
    expect(SURFACE).not.toMatch(/font-(black|mono)/);
    expect(SURFACE).toContain('font-playfair');
  });
});
