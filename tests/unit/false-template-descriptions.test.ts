/**
 * Описания-подмены сняты (миграция 853).
 *
 * Проба 86: у четырёх термальных источников описание целиком скопировано с
 * Верхне-Паратунских — «70 км от Петропавловска, купальни и турбазы» про
 * места, куда добираются вертолётом. Рецензии Кузьмича были сгенерированы из
 * этих же фальшивых текстов: ложь в данных становится ложью агента.
 *
 * Сторож held: замены не наследуют шаблон, каждая правка гейтится маркером
 * подмены, отравленные рецензии снимаются (перегенерирует ночной крон).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/853_false_template_descriptions.sql'),
  'utf-8',
);
const CODE = SQL.replace(/^\s*--.*$/gm, '');

const NEW_TEXTS = [...CODE.matchAll(/SET description =\s*'([^']+)'/g)].map(m => m[1]);

describe('замены честные', () => {
  it('четыре описания заменяются', () => {
    expect(NEW_TEXTS.length).toBe(4);
  });

  it('ни одна замена не наследует шаблон подмены', () => {
    for (const t of NEW_TEXTS) {
      expect(t).not.toMatch(/Паратунск/);
      expect(t).not.toMatch(/70 килом/);
      expect(t).not.toMatch(/сопк[аи] Горяча/);
      expect(t).not.toMatch(/шаман/);
    }
  });

  it('каждая замена честна про термальную опасность', () => {
    // hazard_types у всех четырёх — thermal/chemical; текст обязан это нести,
    // а не продавать купальни.
    for (const t of NEW_TEXTS) {
      expect(t).toMatch(/кипени|горяча|опасн|осторожн/i);
    }
  });

  it('длина замен не проваливает норму каталога (≥300 символов)', () => {
    for (const t of NEW_TEXTS) {
      expect(t.length).toBeGreaterThanOrEqual(300);
    }
  });

  it('внутри строковых литералов нет точки с запятой', () => {
    // Сплиттер миграций режет по «;» — миграция 843 так упала на проде из-за
    // «;» в комментарии. Точка с запятой внутри текста описания разрезала бы
    // UPDATE пополам. Сторож поймал это здесь ДО деплоя.
    for (const m of SQL.matchAll(/'([^']*)'/g)) {
      expect(m[1]).not.toContain(';');
    }
  });
});

describe('прицельность', () => {
  it('каждый UPDATE описания гейтится маркером подмены', () => {
    // Резать по «;» здесь можно ровно потому, что сторож выше гарантирует:
    // внутри строковых литералов точек с запятой нет.
    const updates = CODE.match(/UPDATE places SET description[^;]+;/g) ?? [];
    expect(updates.length).toBe(4);
    for (const u of updates) {
      expect(u).toMatch(/description LIKE '%Паратунск%'/);
    }
  });

  it('отравленные рецензии Кузьмича снимаются с гейтом по содержимому', () => {
    expect(CODE).toMatch(/SET kuzmich_review = NULL/);
    expect(CODE).toMatch(/kuzmich_review LIKE '%Горяч%'/);
  });

  it('ничего не удаляется и не прячется', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/);
    expect(CODE).not.toMatch(/is_visible/);
  });
});
