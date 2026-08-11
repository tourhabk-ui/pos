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
    expect(SRC).toMatch(/verdict:\s*'unjudged',\s*reason:\s*'модель не ответила'/);
    expect(SRC).not.toMatch(/verdict:\s*'noise'[^\n]*не ответила/);
  });

  it('ответ не в заданной форме — тоже «не разобрана»', () => {
    // Догадываться о вердикте по свободному тексту значит выдать
    // неуверенность за вывод.
    expect(SRC).toMatch(/ответ не в заданной форме/);
    expect(SRC).toMatch(/if \(!v\)/);
  });

  it('нет ключа — падаем, а не отдаём пустой разбор', () => {
    expect(SRC).toMatch(/ANTHROPIC_API_KEY[\s\S]{0,120}throw new Error/);
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

  it('ключ Anthropic не появляется в шаге, который ходит на прод', () => {
    const fetchStep = WF.slice(WF.indexOf('Fetch findings'), WF.indexOf('Judge with Claude'));
    expect(fetchStep).not.toContain('ANTHROPIC_API_KEY');
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
