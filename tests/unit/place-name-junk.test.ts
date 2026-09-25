/**
 * Сторож правила «это не место, а экскурсия» (сверка MCP 25.09). Признаки
 * узкие, каждый назван словами: подозрение, а не приговор.
 */
import { describe, it, expect } from 'vitest';
import { nameJunkSuspect, sentenceParts, typeMismatch } from '@/lib/places/name-junk';

describe('несколько объектов в одном названии', () => {
  it('находка 25.09 — подозрение с частями и несовпадением вида', () => {
    const s = nameJunkSuspect('Долина гейзеров. Курильское озеро. Вулканы Горелый и Авача', 'volcano')!;
    expect(s.reasons.join(' ')).toContain('3 части через точку');
    expect(s.reasons.join(' ')).toContain('«долина», а вид записан «volcano»');
  });

  it('точка-сокращение — не конец предложения', () => {
    expect(sentenceParts('Бухта Буян (о. Беринга)')).toHaveLength(1);
    expect(sentenceParts('Устье р. Камчатка')).toHaveLength(1);
    expect(nameJunkSuspect('Мыс Лопатка', 'cape')).toBeNull();
  });

  it('обычные места не подозреваются', () => {
    expect(nameJunkSuspect('Вулкан Мутновский', 'volcano')).toBeNull();
    expect(nameJunkSuspect('Курильское озеро', 'lake')).toBeNull();
    // «Кальдера…» и «Гора…» по первому слову вид не выдают — не судим.
    expect(nameJunkSuspect('Кальдера Курильское озеро', 'volcano')).toBeNull();
  });

  it('вид по первому слову — только однозначные слова', () => {
    expect(typeMismatch('Озеро Толмачёва', 'lake')).toBeNull();
    expect(typeMismatch('Озеро Толмачёва', 'volcano')).toContain('«озеро»');
    expect(typeMismatch('Сопка Любви', 'mountain')).toBeNull();
  });
});
