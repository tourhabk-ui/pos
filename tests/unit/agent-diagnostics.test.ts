/**
 * Диагностика молчания агентов: классификация LLM-ответа в явную причину.
 * Отличает «AI упал» / «невалидный JSON» / «модель честно вернула пусто».
 */
import { describe, it, expect } from 'vitest';
import { parseProposalArray, classifyIntelResponse, emptyDomainBreakdown } from '@/lib/agents/agent-diagnostics';

describe('parseProposalArray', () => {
  it('ok — валидный непустой массив', () => {
    const r = parseProposalArray('[{"title":"X"},{"title":"Y"}]');
    expect(r.reason).toBe('ok');
    expect(r.proposals).toHaveLength(2);
  });

  it('снимает markdown-обёртку ```json', () => {
    const r = parseProposalArray('```json\n[{"title":"X"}]\n```');
    expect(r.reason).toBe('ok');
    expect(r.proposals).toHaveLength(1);
  });

  it('ai_empty_array — валидный [] (модель: триггеров нет)', () => {
    expect(parseProposalArray('[]').reason).toBe('ai_empty_array');
  });

  it('ai_empty — пустой/пробельный текст (провайдер молчит)', () => {
    expect(parseProposalArray('').reason).toBe('ai_empty');
    expect(parseProposalArray('   ').reason).toBe('ai_empty');
    expect(parseProposalArray(null).reason).toBe('ai_empty');
  });

  it('parse_error — текст есть, но не JSON', () => {
    expect(parseProposalArray('извините, не могу').reason).toBe('parse_error');
  });

  it('not_array — распарсилось, но объект, не массив', () => {
    expect(parseProposalArray('{"title":"X"}').reason).toBe('not_array');
  });
});

describe('classifyIntelResponse', () => {
  it('found — валидный finding', () => {
    const r = classifyIntelResponse('{"summary":"Новая модель","urgency":"notable","action_items":["[высокий] внедрить"]}');
    expect(r.status).toBe('found');
    expect(r.summary).toBe('Новая модель');
    expect(r.urgency).toBe('notable');
    expect(r.actionItems).toEqual(['[высокий] внедрить']);
  });

  it('no_relevant — summary "null" (модель: ничего релевантного)', () => {
    expect(classifyIntelResponse('{"summary":"null","urgency":"informational","action_items":[]}').status).toBe('no_relevant');
    expect(classifyIntelResponse('{"summary":"","action_items":[]}').status).toBe('no_relevant');
  });

  it('ai_empty — пустой ответ провайдера', () => {
    expect(classifyIntelResponse('').status).toBe('ai_empty');
    expect(classifyIntelResponse(null).status).toBe('ai_empty');
  });

  it('parse_error — не JSON', () => {
    expect(classifyIntelResponse('провайдер вернул текст').status).toBe('parse_error');
  });

  it('невалидный urgency → informational, action_items обрезаются до 3', () => {
    const r = classifyIntelResponse('{"summary":"S","urgency":"мусор","action_items":["a","b","c","d"]}');
    expect(r.urgency).toBe('informational');
    expect(r.actionItems).toHaveLength(3);
  });
});

describe('emptyDomainBreakdown', () => {
  it('все счётчики нулевые', () => {
    const b = emptyDomainBreakdown();
    expect(b).toEqual({ found: 0, no_signals: 0, ai_empty: 0, parse_error: 0, no_relevant: 0 });
  });
});
