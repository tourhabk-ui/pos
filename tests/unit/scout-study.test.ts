/**
 * Сторож изучателя источников (lib/agents/scout-study.ts).
 *
 * Главное, что здесь закрепляется, — РАЗЛИЧЕНИЕ ТРЁХ ИСХОДОВ. «Модель не
 * ответила» и «в источнике этого нет» ведут к разным действиям человека, и
 * подмена одного другим уже стоила платформе двадцати одного дня тишины
 * разведчика (заглушка отказа провайдеров читалась как ответ модели —
 * см. шапку app/api/cron/scout-diagnose/route.ts).
 *
 * Второе: ответ без цитат не принимается. Инструмент существует ради
 * первоисточника; пересказ по памяти — ровно то, чего он должен избегать.
 */
import { describe, it, expect } from 'vitest';
import {
  sourceHtmlToText, clipForModel, buildStudyMessages, parseStudyVerdict, describeOutcome,
  SOURCE_CHARS_LIMIT,
} from '@/lib/agents/scout-study';

describe('sourceHtmlToText: разбор канонический, не свой', () => {
  it('тело скрипта не доезжает до промпта даже при `</script >` с пробелом', () => {
    // Причина, по которой своего разбора здесь нет: точное `</script>`
    // оставило бы тело чужого скрипта в тексте, уходящем модели.
    const text = sourceHtmlToText('<p>Частота</p><script>var x = "868.7 не отсюда";</script >>><p>868,7 МГц</p>');
    expect(text).toContain('Частота');
    expect(text).toContain('868,7 МГц');
    expect(text).not.toContain('var x');
  });

  it('строки таблицы не слипаются — числа в них и нужны', () => {
    const html = '<table><tr><td>864-865</td><td>25 мВт</td></tr><tr><td>868,7-869,2</td><td>100 мВт</td></tr></table>';
    const text = sourceHtmlToText(html);
    // Две полосы обязаны остаться различимыми: склеенные в одну строку,
    // они не дают понять, какой предел мощности к какой полосе относится.
    expect(text.split('\n').length).toBeGreaterThan(1);
    expect(text).toContain('25 мВт');
    expect(text).toContain('100 мВт');
  });

  it('html-сущности раскрываются каноническим декодером', () => {
    expect(sourceHtmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>')).toContain('a & b <c> "d"');
  });
});

describe('clipForModel: обрезка не рвёт строку пополам', () => {
  it('короткий текст не трогается', () => {
    expect(clipForModel('короткий', 100)).toBe('короткий');
  });

  it('режет по границе строки, а не по символу', () => {
    const text = 'первая строка\nвторая строка\nтретья строка';
    const out = clipForModel(text, 20);
    expect(out.endsWith('строка')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it('лимит по умолчанию задан одним числом', () => {
    expect(SOURCE_CHARS_LIMIT).toBeGreaterThan(1000);
    expect(clipForModel('x'.repeat(SOURCE_CHARS_LIMIT + 500)).length).toBeLessThanOrEqual(SOURCE_CHARS_LIMIT);
  });
});

describe('промпт: запрет выдумывать — принцип, а не перечень случаев', () => {
  const msgs = buildStudyMessages('https://example.org', 'какая частота?', 'текст источника');

  it('системная часть требует отвечать только из текста и разрешает «нет»', () => {
    const system = msgs[0].content;
    expect(system).toMatch(/ТОЛЬКО тем, что есть в поданном тексте/);
    expect(system).toMatch(/Это нормальный исход/);
    expect(system).toMatch(/цитатой/);
  });

  it('источник, вопрос и текст доезжают до модели', () => {
    expect(msgs[1].content).toContain('https://example.org');
    expect(msgs[1].content).toContain('какая частота?');
    expect(msgs[1].content).toContain('текст источника');
  });
});

describe('parseStudyVerdict: три исхода, и они не смешиваются', () => {
  it('найденный ответ с цитатами принимается', () => {
    const out = parseStudyVerdict(JSON.stringify({
      found: true, answer: '868,7-869,2 МГц, 100 мВт', quotes: ['RDEF(RU, 868.7f, 869.2f'],
    }));
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') throw new Error('unreachable');
    expect(out.answer).toContain('868,7');
    expect(out.quotes).toHaveLength(1);
  });

  it('markdown-обёртка ```json снимается', () => {
    const out = parseStudyVerdict('```json\n{"found":true,"answer":"ответ","quotes":["цитата"]}\n```');
    expect(out.kind).toBe('answered');
  });

  it('found=false — это ФАКТ об источнике, а не сбой', () => {
    const out = parseStudyVerdict(JSON.stringify({
      found: false, answer: '', quotes: [], missing: 'мощности в тексте нет',
    }));
    expect(out.kind).toBe('not_in_source');
    if (out.kind !== 'not_in_source') throw new Error('unreachable');
    expect(out.note).toContain('мощности');
  });

  it('молчание модели — failed, а НЕ «в источнике нет»', () => {
    for (const raw of [null, '', '   ']) {
      const out = parseStudyVerdict(raw);
      expect(out.kind, `на ${JSON.stringify(raw)} исход обязан быть failed`).toBe('failed');
    }
  });

  it('неразобранный ответ — failed с началом ответа в причине', () => {
    const out = parseStudyVerdict('Извините, я не могу помочь с этим запросом.');
    expect(out.kind).toBe('failed');
    if (out.kind !== 'failed') throw new Error('unreachable');
    expect(out.reason).toContain('не похож на JSON');
    expect(out.reason).toContain('Извините');
  });

  it('битый JSON — failed, а не молчаливое «ничего не нашли»', () => {
    const out = parseStudyVerdict('{"found": true, "answer": ');
    expect(out.kind).toBe('failed');
  });

  it('ответ БЕЗ цитат не принимается — это пересказ по памяти', () => {
    const out = parseStudyVerdict(JSON.stringify({ found: true, answer: 'что-то', quotes: [] }));
    expect(out.kind).toBe('failed');
    if (out.kind !== 'failed') throw new Error('unreachable');
    expect(out.reason).toContain('без цитат');
  });

  it('found=true с пустым ответом не принимается', () => {
    const out = parseStudyVerdict(JSON.stringify({ found: true, answer: '   ', quotes: ['ц'] }));
    expect(out.kind).toBe('failed');
  });

  it('found=false без объяснения всё равно называет, что причина не названа', () => {
    const out = parseStudyVerdict(JSON.stringify({ found: false }));
    expect(out.kind).toBe('not_in_source');
    if (out.kind !== 'not_in_source') throw new Error('unreachable');
    expect(out.note).toMatch(/не назвала/);
  });
});

describe('describeOutcome: исход читается без раскрытия JSON', () => {
  it('каждый исход даёт непустую строку, и они различаются', () => {
    const lines = [
      describeOutcome({ kind: 'answered', answer: 'a', quotes: ['q'] }),
      describeOutcome({ kind: 'not_in_source', note: 'нет мощности' }),
      describeOutcome({ kind: 'failed', reason: 'модель не ответила' }),
    ];
    expect(new Set(lines).size).toBe(3);
    for (const l of lines) expect(l.length).toBeGreaterThan(0);
    expect(lines[2]).toContain('не смог');
  });
});
