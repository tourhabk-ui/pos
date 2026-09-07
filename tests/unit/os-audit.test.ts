/**
 * Сторож аудита ОС и эволюции (08.09, «может мы тоже упустили что-то»).
 *
 * ── Зачем аудит ────────────────────────────────────────────────────────────
 *
 * Платформа судит себя по кусочкам: сторож проверяет своё, перепись считает
 * своё, ревью смотрит диф. Никто не держит перед глазами ПРАВИЛА и
 * ИСПОЛНЕНИЕ одновременно, а расхождение живёт именно между ними.
 *
 * За 07-08.09 нашлось четыре таких, и ни одно не поймал ни один сторож:
 * `search_text` как `NULL::tsvector` при живом поиске Кузьмича; девять
 * разошедшихся копий правила старшинства линии; ожидание выкладки, молча
 * отчитавшееся успехом; сторож с уехавшим якорем, проверявший пустоту.
 *
 * ── Что защищает этот сторож ───────────────────────────────────────────────
 *
 * Аудит делает модель, а модели на слово не верят. Здесь держится ровно то,
 * что отличает замер от красивого текста.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(process.cwd(), 'scripts/os-audit-runner.ts'), 'utf8');
const WF = readFileSync(join(process.cwd(), '.github/workflows/os-audit.yml'), 'utf8');

describe('находка проверяется, а не принимается на слово', () => {
  it('путь вне выданного набора — выдумка, и она считается', () => {
    expect(SRC).toContain('known.has(p)');
    expect(SRC).toContain('invented');
  });

  it('промпт запрещает сочинять пути и требует дословную улику', () => {
    expect(SRC).toContain('Не сочиняй путей');
    expect(SRC).toContain('ДОСЛОВНЫЕ');
    // Файлов вне набора модель не видела — предполагать их содержимое нельзя.
    expect(SRC).toContain('которых в наборе нет');
  });

  it('безопасность туриста поднята выше прочего', () => {
    expect(SRC).toContain('Безопасность туриста важнее всего');
  });
});

describe('три исхода, а не два', () => {
  it('пустой набор — отказ, а не «нарушений нет»', () => {
    expect(SRC).toContain('Набор пуст');
    expect(SRC).toMatch(/отказ, а не «нарушений нет»/);
  });

  it('ноль находок краснеет: «чисто» и «не справилась» неразличимы', () => {
    expect(SRC).toContain('неразличимы');
    expect(SRC).toMatch(/good\.length === 0[\s\S]{0,300}process\.exit\(1\)/);
  });

  it('оборванный ответ спасается общим модулем, а не своим разбором', () => {
    // Урок прогона 2 разбора маршрутов: 8000 токенов не хватило, и находки
    // с уликами пропали целиком. Правило спасения одно на репозиторий.
    expect(SRC).toContain("from '../lib/ai/json-salvage'");
    expect(SRC).toContain('ОБОРВАН');
  });
});

describe('аудит ничего не меняет и никуда не ходит', () => {
  it('в базу не пишет и прод не спрашивает', () => {
    expect(SRC).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(SRC).not.toContain('vedarai.ru');
    // Прод весь день был блокером — аудит намеренно от него не зависит.
    expect(WF).not.toContain('vedarai.ru');
    expect(WF).not.toContain('wait-for-deploy');
  });

  it('сказано вслух, что решает человек', () => {
    expect(SRC).toContain('Решает человек');
  });

  it('цена прохода считается из usage, а не из памяти', () => {
    expect(SRC).toContain('usage');
    expect(SRC).toContain('цена прохода');
  });

  it('подпись OpenRouter — из общего модуля', () => {
    expect(SRC).toContain("from '../lib/ai/attribution'");
  });
});

describe('нацеливание', () => {
  it('модель и набор задаются маркером, а не правкой workflow', () => {
    expect(WF).toContain('.github/triggers/os-audit.json');
    expect(WF).toContain("get('model')");
    expect(WF).toContain("get('targets')");
  });

  it('по умолчанию читаются правила, исполнение и сторожа агентов', () => {
    expect(SRC).toContain("'CLAUDE.md'");
    expect(SRC).toContain("'lib/agents'");
    expect(SRC).toContain('GUARD_PATTERN');
  });
});
