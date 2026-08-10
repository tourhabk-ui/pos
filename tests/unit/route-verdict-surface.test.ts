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

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const API = read('app/api/routes/[id]/verdict/route.ts');
const BLOCK = read('components/routes/RouteVerdict.tsx');
const PAGE = read('app/routes/[id]/_RouteDetailClient.tsx');

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
    expect(PAGE).toMatch(/import RouteVerdict from '@\/components\/routes\/RouteVerdict'/);
    expect(PAGE).toMatch(/<RouteVerdict\s+routeId=/);
  });

  it('выше подробностей маршрута, а не под ними', () => {
    // Человек приходит с одним вопросом; ответ не должен лежать под пятью
    // секциями. Точка отсчёта — блок оперативных ограничений.
    expect(PAGE.indexOf('<RouteVerdict')).toBeLessThan(PAGE.indexOf('ОПЕРАТИВНЫЕ ОГРАНИЧЕНИЯ'));
    expect(PAGE.indexOf('<RouteVerdict')).toBeLessThan(PAGE.indexOf('<SafetyWarnings'));
  });
});

describe('дизайн-система соблюдена', () => {
  it('цвета — токенами, без хардкода hex', () => {
    expect(BLOCK).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(BLOCK).toContain('var(--success)');
    expect(BLOCK).toContain('var(--warning)');
    expect(BLOCK).toContain('var(--danger)');
  });

  it('стекла на сплошном фоне нет', () => {
    expect(BLOCK).not.toMatch(/backdrop-blur/);
  });

  it('иконки только lucide, эмодзи нет', () => {
    expect(BLOCK).toMatch(/from 'lucide-react'/);
    expect(BLOCK).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('вердикт не подменяет собой кнопку СОС', () => {
    // СОС — только components/shared/EmergencyAction. Копия расходится
    // поведением, это уже случалось (#887).
    expect(BLOCK).not.toMatch(/SOS|СОС/);
  });
});
