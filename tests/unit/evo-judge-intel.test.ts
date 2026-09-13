/**
 * Сторож: судья разбирает и РАЗВЕДДАННЫЕ — другим вопросом (задание владельца
 * 13.09: «пусть судья и разведку разбирает на полезность»).
 *
 * До этого дня разведданные не судились вовсе, и решение 22.08 было верным:
 * судье КОДА они задавали вопрос, ответ на который известен заранее — его
 * промпт прямо велит считать шумом предложения «изучить» и «внедрить».
 * Платили за известный ответ токенами флагмана, а цифра «шум 34» читалась как
 * точность сканера кода, которой не являлась.
 *
 * Поменялся вопрос — значит, поменялись промпт, вердикты и цена. Теперь
 * спрашивается не «сломано ли это», а «чему это служит».
 *
 * Два места, где легко соврать, и оба здесь стережены:
 *
 *  1. СУДЬЯ ВИДИТ ТОЛЬКО ЗАГОЛОВКИ — ни кода, ни базы. Спросить его «есть ли
 *     у нас данные о медведях» значило бы заказать выдумку (§4.0: промпт не
 *     требует того, чего нет в данных). Поэтому вердикты назначены так, чтобы
 *     каждый выводился из текста и объявленной цели платформы.
 *  2. ОТВЕТ НЕ НА ВСЕ ПОЗИЦИИ — это ответ не на все. Позиция без строки
 *     становится «не разобрана», а не пропадает и не считается решённой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseIntelAnswer, buildIntelPrompt, renderReport, countActionable,
  hashJudgeOutput, hashOwnerDecisions, JUDGE_CONTRACT_VERSION,
  type JudgedIntel,
} from '@/scripts/evo-judge';

const ITEMS = [
  { id: 'a', title: 'Слой медвежьей активности на карте' },
  { id: 'b', title: 'Слой предупреждений о медведях на карте' },
  { id: 'c', title: 'Голосовой режим для ИИ-помощника Кузьмича' },
  { id: 'd', title: 'Семантический кэш для ответов Кузьмича' },
];

describe('промпт разведки', () => {
  it('нумерация 1-based и общая с разбором ответа', () => {
    const p = buildIntelPrompt(ITEMS);
    expect(p.split('\n')[0]).toBe('1. Слой медвежьей активности на карте');
    expect(p.split('\n')[3]).toBe('4. Семантический кэш для ответов Кузьмича');
  });
});

describe('разбор ответа модели', () => {
  it('вердикт и причина ложатся на свои позиции', () => {
    const out = parseIntelAnswer(
      [
        '1 | worth | относится к безопасности туриста в поле',
        '2 | duplicate:1 | та же идея, что позиция 1',
        '3 | product | удобство, не безопасность',
        '4 | internal | про нашу инфраструктуру',
      ].join('\n'),
      ITEMS,
    );
    expect(out.map((x) => x.verdict)).toEqual(['worth', 'duplicate', 'product', 'internal']);
    expect(out[1].duplicateOf).toBe(1);
    expect(out[0].reason).toBe('относится к безопасности туриста в поле');
  });

  it('позиция без строки — «не разобрана», а не пропажа', () => {
    const out = parseIntelAnswer('1 | worth | про безопасность', ITEMS);
    expect(out).toHaveLength(4);
    expect(out.slice(1).every((x) => x.verdict === 'unjudged')).toBe(true);
    expect(out[3].reason).toContain('строки на эту позицию в ответе не было');
  });

  it('дубль без пригодного номера не принимается', () => {
    // «Это дубль чего-то» непроверяемо и человеку бесполезно; принять такую
    // строку значило бы вычесть позицию из очереди, не показав замены.
    const out = parseIntelAnswer(
      ['1 | duplicate | дубль', '2 | duplicate:2 | сам себя', '3 | duplicate:99 | мимо списка'].join('\n'),
      ITEMS,
    );
    expect(out.slice(0, 3).every((x) => x.verdict === 'unjudged')).toBe(true);
    expect(out[0].reason).toContain('без пригодного номера');
  });

  it('мусор вокруг строк не ломает разбор, номер вне списка игнорируется', () => {
    const out = parseIntelAnswer(
      ['Вот разбор:', '1 | worth | про безопасность', '7 | off | такой позиции нет', ''].join('\n'),
      ITEMS,
    );
    expect(out[0].verdict).toBe('worth');
    expect(out.slice(1).every((x) => x.verdict === 'unjudged')).toBe(true);
  });

  it('пустой ответ — всё не разобрано, а не «всё чисто»', () => {
    const out = parseIntelAnswer('', ITEMS);
    expect(out.every((x) => x.verdict === 'unjudged')).toBe(true);
  });

  it('пустой список идей — пустой разбор, без выдуманных строк', () => {
    expect(parseIntelAnswer('1 | worth | что-то', [])).toEqual([]);
  });
});

describe('счёт того, что требует решения', () => {
  const judged = (v: JudgedIntel['verdict'], id: string): JudgedIntel =>
    ({ id, title: id, verdict: v, reason: 'r', ...(v === 'duplicate' ? { duplicateOf: 1 } : {}) });

  it('вычитаются ТОЛЬКО дубли и «мимо» — там у судьи есть улика', () => {
    const intel = [judged('worth', 'a'), judged('duplicate', 'b'), judged('off', 'c'), judged('internal', 'd')];
    // worth + internal = 2; дубль и «мимо» решения не требуют.
    expect(countActionable([], intel)).toBe(2);
  });

  it('«про нас» и «не разобрана» считаются: вычитать их было бы вкусом, а не уликой', () => {
    expect(countActionable([], [judged('internal', 'a')])).toBe(1);
    expect(countActionable([], [judged('unjudged', 'a')])).toBe(1);
  });

  it('до 13.09 счёт не мог дойти до нуля: считались ВСЕ разведданные', () => {
    // Разведчик производит идеи каждый день; пока все они были actionable,
    // выпуск не закрывался никогда независимо от работы.
    const allDupes = [judged('duplicate', 'a'), judged('duplicate', 'b'), judged('off', 'c')];
    expect(countActionable([], allDupes)).toBe(0);
  });
});

describe('отпечатки', () => {
  const base: JudgedIntel[] = [{ id: 'a', title: 'A', verdict: 'worth', reason: 'про безопасность' }];

  it('смена вердикта идее меняет отпечаток вывода', () => {
    const other: JudgedIntel[] = [{ id: 'a', title: 'A', verdict: 'off', reason: 'мимо' }];
    expect(hashJudgeOutput([], base)).not.toBe(hashJudgeOutput([], other));
  });

  it('смена причины меняет вывод, но не решение владельца', () => {
    const reworded: JudgedIntel[] = [{ id: 'a', title: 'A', verdict: 'worth', reason: 'иначе сказано' }];
    expect(hashJudgeOutput([], base)).not.toBe(hashJudgeOutput([], reworded));
    expect(hashOwnerDecisions([], base)).toBe(hashOwnerDecisions([], reworded));
  });

  it('решённые идеи не попадают в отпечаток решений', () => {
    const settled: JudgedIntel[] = [
      ...base,
      { id: 'b', title: 'B', verdict: 'duplicate', reason: 'копия', duplicateOf: 1 },
    ];
    expect(hashOwnerDecisions([], settled)).toBe(hashOwnerDecisions([], base));
  });

  it('контракт судьи поднят — иначе прогон закоротит дедуп на старом входе', () => {
    expect(JUDGE_CONTRACT_VERSION).toBe('judge-v2');
  });
});

describe('отчёт', () => {
  const intel: JudgedIntel[] = [
    { id: 'a', title: 'Слой медвежьей активности', verdict: 'worth', reason: 'безопасность в поле' },
    { id: 'b', title: 'Слой предупреждений о медведях', verdict: 'duplicate', reason: 'то же', duplicateOf: 1 },
    { id: 'c', title: 'Голос Кузьмича', verdict: 'product', reason: 'удобство' },
  ];

  it('дубль собран ПОД своим оригиналом, а не выброшен', () => {
    const md = renderReport([], undefined, intel);
    expect(md).toContain('Слой медвежьей активности');
    // «19 стало 12» без показа склейки читалось бы как потеря семи позиций.
    expect(md).toContain('то же самое: Слой предупреждений о медведях');
  });

  it('сказано, сколько требует решения — и это не то же, что «сколько всего»', () => {
    expect(renderReport([], undefined, intel)).toContain('Разведданных: **3**, из них требуют решения **2**');
  });

  it('оговорка о границах суждения стоит в отчёте', () => {
    // Читающий обязан видеть, что судья не проверял выполнимость.
    expect(renderReport([], undefined, intel)).toContain('без кода и базы');
  });

  it('безопасность идёт первой — порядок по объявленной цели платформы', () => {
    const md = renderReport([], undefined, intel);
    expect(md.indexOf('служит безопасности')).toBeLessThan(md.indexOf('польза туристу'));
  });

  it('без разведданных раздела нет', () => {
    expect(renderReport([], undefined, [])).not.toContain('Разведданные');
  });
});

describe('промпт не заказывает выдумку', () => {
  const text = readFileSync(join(process.cwd(), 'scripts/evo-judge.ts'), 'utf-8');

  it('судье прямо сказано, что он не знает состояния репозитория', () => {
    expect(text).toContain('ни кода, ни базы');
    expect(text).toMatch(/не утверждай, есть\s*\n?\s*ли у платформы нужные данные/);
  });

  it('критерий взят из объявленной цели платформы, а не из вкуса модели', () => {
    expect(text).toContain('БЕЗОПАСНОСТЬ ТУРИСТОВ');
  });

  it('разведка судится ОДНИМ вызовом: иначе дубли не видны в принципе', () => {
    expect(text).toMatch(/export async function judgeIntel/);
    // Один callAIDecisionDetailed на весь список, не вызов в цикле по идеям.
    const fn = text.slice(text.indexOf('export async function judgeIntel'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect((body.match(/callAIDecisionDetailed/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/for \(|\.map\(async/);
  });

  it('ПД чистятся и на этом пути тоже', () => {
    const fn = text.slice(text.indexOf('export async function judgeIntel'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('redactPII');
  });
});
