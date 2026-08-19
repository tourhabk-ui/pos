/**
 * Разбор находок: тишина не считается ответом.
 *
 * Инструмент, который судит находки, опаснее обычного кода в одном месте:
 * если он молча выдаёт пустой разбор, эволюция выглядит чистой именно тогда,
 * когда разбор не состоялся. Это тот же дефект, что зелёная плашка из нуля
 * данных, только этажом выше.
 *
 * Отсюда все проверки ниже: нет ответа — «не разобрана», а не «шум»; форма
 * ответа не угадывается; потолок прогона назван вслух; ПД чистятся до
 * отправки во внешнюю модель.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport, type Judged } from '@/scripts/evo-judge';

const SRC = readFileSync(join(process.cwd(), 'scripts/evo-judge.ts'), 'utf-8');
const WF = readFileSync(join(process.cwd(), '.github/workflows/evo-judge.yml'), 'utf-8');

const finding = (title: string) => ({
  id: 'x', category: 'bug', severity: 'high', file_path: 'lib/a.ts',
  line_number: 10, title, description: null, suggestion: null,
});

describe('провал разбора не выдаётся за вердикт', () => {
  it('модель не ответила — «не разобрана», не «шум»', () => {
    // Проверяется СМЫСЛ, а не написание: пустой ответ ведёт к `unjudged`, и
    // причина говорит про отсутствие ответа. Прежняя редакция сторожа ловила
    // точную строку и покраснела на правке, которая добавила к причине разбор
    // по ступеням, — то есть на улучшении.
    const mute = /if \(!answer\)[\s\S]{0,600}?verdict: 'unjudged'/;
    expect(SRC).toMatch(mute);
    expect(SRC.match(mute)?.[0]).toBeTruthy();
    expect(SRC).toMatch(/не ответила/);
    expect(SRC).not.toMatch(/verdict:\s*'noise'[^\n]*не ответила/);
  });

  it('ответ не в заданной форме — тоже «не разобрана»', () => {
    // Догадываться о вердикте по свободному тексту значит выдать
    // неуверенность за вывод.
    expect(SRC).toMatch(/ответ не в заданной форме/);
    expect(SRC).toMatch(/if \(!v\)/);
  });

  it('нет ни одного ключа — падаем, а не отдаём пустой разбор', () => {
    expect(SRC).toMatch(/ANTHROPIC_API_KEY[\s\S]{0,120}throw new Error/);
  });

  it('судья зовёт водопад решателя, а не голый callAnthropic', () => {
    // 12-14.08 Anthropic три дня отдавал пустой ответ, и каждый отчёт выходил
    // с «не разобрано: 30+» — при живых DeepSeek/Qwen, которые водопад
    // решателя пробует сам. Голый вызов одного провайдера здесь запрещён.
    expect(SRC).toMatch(/callAIDecisionDetailed/);
    expect(SRC).not.toMatch(/callAnthropic\(/);
  });

  it('модель судьи едет в отчёт — атрибуция, как у находок', () => {
    expect(SRC).toMatch(/model\?: string/);
    expect(SRC).toMatch(/Судья: /);
  });

  it('потолок прогона назван вслух', () => {
    expect(SRC).toMatch(/за потолком в 40 находок/);
  });
});

describe('отчёт не прячет неразобранное', () => {
  const judged: Judged[] = [
    { finding: finding('Утечка соединений'), verdict: 'real', reason: 'pool.connect без release' },
    { finding: finding('Ложное совпадение'), verdict: 'noise', reason: 'санкционированный вызов' },
    { finding: finding('Непонятная'), verdict: 'unjudged', reason: 'модель не ответила' },
  ];

  it('счётчики разделены: «не разобрана» — свой столбец', () => {
    const md = renderReport(judged);
    expect(md).toContain('| по делу | 1 |');
    expect(md).toContain('| шум | 1 |');
    expect(md).toContain('| не разобрана | 1 |');
  });

  it('о неразобранном сказано ДО подробностей и прямым текстом', () => {
    const md = renderReport(judged);
    expect(md).toContain('Это не «чисто» — это отсутствие ответа');
    expect(md.indexOf('Это не «чисто»')).toBeLessThan(md.indexOf('## По делу'));
  });

  it('пустых разделов в отчёте нет', () => {
    const md = renderReport([judged[0]]);
    expect(md).not.toContain('## Шум');
  });

  it('«по делу» идёт первым — с него начинают работу', () => {
    const md = renderReport(judged);
    expect(md.indexOf('## По делу')).toBeLessThan(md.indexOf('## Шум'));
  });
});

describe('152-ФЗ и путь провайдера', () => {
  it('ПД чистятся до отправки во внешнюю модель', () => {
    expect(SRC).toMatch(/redactPII\(/);
    // Именно вокруг тела запроса, а не где-нибудь.
    expect(SRC).toMatch(/const body = redactPII\(/);
  });

  it('модель зовётся санкционированным путём, а не сырым fetch', () => {
    // Прямые вызовы провайдеров разрешены только в lib/ai/providers.ts —
    // иначе новый хост минует замороженный реестр compliance.
    expect(SRC).toMatch(/from '@\/lib\/ai\/providers'/);
    expect(SRC).not.toMatch(/fetch\(['"`]https:\/\/api\.anthropic/);
  });
});

describe('workflow не разбрасывается секретами', () => {
  it('CRON_SECRET уходит только на свой крон-роут', () => {
    expect(WF).toMatch(/https:\/\/vedarai\.ru\/api\/cron\/evo-issues/);
    const cronUses = WF.match(/Authorization: Bearer \$\{CRON_SECRET\}/g) ?? [];
    expect(cronUses.length).toBe(1);
  });

  it('ключи моделей не появляются в шаге, который ходит на прод', () => {
    const fetchStep = WF.slice(WF.indexOf('Fetch findings'), WF.indexOf('Judge with strong model'));
    expect(fetchStep).not.toContain('ANTHROPIC_API_KEY');
    expect(fetchStep).not.toContain('DEEPSEEK_API_KEY');
    expect(fetchStep).not.toContain('DASHSCOPE_API_KEY');
  });

  it('у судьи есть запасные пути: DeepSeek и Qwen рядом с Anthropic', () => {
    const judgeStep = WF.slice(WF.indexOf('Judge with strong model'));
    expect(judgeStep).toContain('ANTHROPIC_API_KEY');
    expect(judgeStep).toContain('DEEPSEEK_API_KEY');
    expect(judgeStep).toContain('DASHSCOPE_API_KEY');
  });

  it('прод не отдал находки — падаем, а не считаем это пустотой', () => {
    expect(WF).toMatch(/exit 1/);
    expect(WF).toContain('это не «чисто»');
  });

  it('разбор идёт на раннере, а не через curl в прод', () => {
    // Весь смысл: раннер вне РФ, гео-блока нет, релей не нужен.
    expect(WF).toMatch(/npx tsx scripts\/evo-judge\.ts/);
  });
});

/**
 * Немой решатель называет, почему молчит.
 *
 * Разбор 18.08 вышел «41 из 41 не разобрана: модель не ответила». Среди этих
 * находок была critical SQL-инъекция, и восемь суток никто не знал, что
 * чинить: отсутствующий ключ, гео-блок, исчерпанная квота и таймаут давали
 * одну и ту же строку.
 *
 * Водопад решателя ЗНАЕТ причину по ступеням и кладёт её в `error`. Отчёт эту
 * причину выбрасывал — то есть прибор измерял, а шкала не показывала.
 */
describe('полная немота решателя названа причиной', () => {
  const mute = (reason: string): Judged => ({
    finding: { id: '1', category: 'bug', severity: 'critical', title: 'Находка' } as Judged['finding'],
    verdict: 'unjudged',
    reason,
  });

  it('причина по ступеням доходит до отчёта', () => {
    const md = renderReport([mute('модель не ответила: deepseek: ключа нет; qwen: HTTP 401')]);
    expect(md).toContain('deepseek: ключа нет');
    expect(md).toContain('Разобрать не удалось НИ ОДНОЙ находки');
  });

  it('одинаковые причины не печатаются сорок раз', () => {
    const many = Array.from({ length: 40 }, () => mute('модель не ответила: deepseek: ключа нет'));
    const md = renderReport(many);
    // Причина названа в блоке один раз; в перечне находок она стоит у каждой,
    // и это нормально — здесь проверяется, что БЛОК не размножился.
    expect((md.match(/Разобрать не удалось НИ ОДНОЙ находки/g) ?? []).length).toBe(1);
    const bullets = md.split('Причины по ступеням решателя:')[1]?.split('\n\n')[0] ?? '';
    expect((bullets.match(/^- /gm) ?? []).length).toBe(1);
  });

  it('блок не появляется, когда часть находок разобрана', () => {
    const judged: Judged[] = [
      mute('модель не ответила: deepseek: ключа нет'),
      { finding: { id: '2', category: 'bug', severity: 'low', title: 'Вторая' } as Judged['finding'],
        verdict: 'noise', reason: 'санкционированная конструкция' },
    ];
    const md = renderReport(judged);
    expect(md).not.toContain('Разобрать не удалось НИ ОДНОЙ находки');
  });

  it('код берёт причину из водопада, а не выдумывает свою', () => {
    expect(SRC).toMatch(/res\.error/);
  });
});
