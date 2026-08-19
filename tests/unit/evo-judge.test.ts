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
import { renderReport, selectForJudging, type Judged } from '@/scripts/evo-judge';

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
    expect(SRC).toMatch(/за потолком в \$\{limit\}/);
  });
});

/**
 * Хвост, который не разбирают никогда.
 *
 * 18 и 19 августа отчёт вторые сутки подряд кончался строкой «ещё 8 находок
 * не разбирались». Те же восемь: прод отдаёт находки в неизменном порядке
 * (важность, затем дата), а разбор брал ровно первые сорок. Это не «не
 * успели» — это множество, до которого очередь не дойдёт никогда, и его
 * содержимое неизвестно по построению.
 */
describe('очередь разбора начинается с хвоста', () => {
  const many = (n: number, severity = 'low') =>
    Array.from({ length: n }, (_, i) => ({
      id: `f${i}`, category: 'bug', severity, file_path: null,
      line_number: null, title: `находка ${i}`, description: null, suggestion: null,
    }));

  it('всё влезает в потолок — не пропускается ничего', () => {
    const { picked, skipped } = selectForJudging(many(48), 100, 0);
    expect(picked).toHaveLength(48);
    expect(skipped).toHaveLength(0);
  });

  it('при переполнении первым идёт конец списка — кто ждал дольше всех', () => {
    // 18.08 за потолком осталось 3 находки, 19.08 — уже 8, и среди них ждала
    // с 16-го настоящая утечка секрета. Решение владельца: начинать с хвоста.
    // Проверяется при ЛЮБОМ сдвиге: правило, верное только при нулевом
    // сдвиге, — правило на словах, а прод передаёт номер прогона.
    const all = many(200);
    for (const offset of [0, 1, 13, 97, 1234]) {
      const { picked } = selectForJudging(all, 100, offset);
      expect(picked[0].id).toBe(all[all.length - 1].id);
      expect(picked[1].id).toBe(all[all.length - 2].id);
    }
  });

  it('critical и high не встают в общую очередь', () => {
    // Иначе «сначала старое» однажды отодвинет свежую инъекцию за сотню
    // заметок про чужие анонсы моделей.
    const severe = many(5, 'critical').map((f) => ({ ...f, id: `sev${f.id}` }));
    const all = [...severe, ...many(300)];
    for (const offset of [0, 1, 17, 299]) {
      const ids = selectForJudging(all, 100, offset).picked.map((f) => f.id);
      for (const s2 of severe) expect(ids).toContain(s2.id);
    }
  });

  it('окно едет: за несколько прогонов виден весь список', () => {
    const all = many(200);
    const seen = new Set<string>();
    for (let run = 0; run < 8; run++) {
      for (const f of selectForJudging(all, 100, run * 25).picked) seen.add(f.id);
    }
    expect(seen.size).toBe(all.length);
  });

  it('один и тот же прогон пропускает одно и то же — сдвиг детерминирован', () => {
    const all = many(200);
    expect(selectForJudging(all, 100, 3).skipped.map((f) => f.id))
      .toEqual(selectForJudging(all, 100, 3).skipped.map((f) => f.id));
  });

  it('разобранное не задваивается', () => {
    const { picked } = selectForJudging(many(200), 100, 42);
    expect(new Set(picked.map((f) => f.id)).size).toBe(picked.length);
  });

  it('пропущенное и разобранное вместе дают весь список', () => {
    const all = many(137);
    const { picked, skipped } = selectForJudging(all, 40, 11);
    expect(picked.length + skipped.length).toBe(all.length);
    expect(new Set([...picked, ...skipped].map((f) => f.id)).size).toBe(all.length);
  });

  it('потолок совпадает с тем, сколько находок вообще приходит с прода', () => {
    // Прод отдаёт до ста (LIMIT 100 в /api/cron/evo-issues). Потолок разбора
    // ниже этого числа означает, что часть находок не увидит никто.
    const api = readFileSync(join(process.cwd(), 'app/api/cron/evo-issues/route.ts'), 'utf-8');
    const apiLimit = Number(/LIMIT\s+(\d+)/.exec(api)?.[1]);
    const judgeDefault = Number(/EVO_JUDGE_LIMIT \?\? '', 10\);\s*\n\s*return[^;]*?:\s*(\d+)/.exec(SRC)?.[1]);
    expect(apiLimit).toBeGreaterThan(0);
    expect(judgeDefault).toBeGreaterThanOrEqual(apiLimit);
  });

  it('сдвиг окна берётся из прогона, а не из константы', () => {
    // Без номера прогона окно стоит на месте, и «ротация» — только на словах.
    expect(WF).toMatch(/EVO_JUDGE_OFFSET:\s*\$\{\{\s*github\.run_number\s*\}\}/);
  });

  it('падение на одной находке не уносит остальные', () => {
    expect(SRC).toMatch(/judgeOne\(f\)\.catch/);
    expect(SRC).toMatch(/разбор упал/);
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

/**
 * Прогон, разобравший ноль находок, не имеет права быть зелёным.
 *
 * 16, 18 и 19 августа отчёт выходил «все не разобраны», а джоб числился
 * успешным: скрипт отработал, issue завелась, галочка зелёная. Четверо суток
 * решатель молчал, и никто не узнал — среди неразобранного лежала
 * critical-инъекция.
 *
 * Причина немоты, как выяснилось по логу прогона: секретов DEEPSEEK_API_KEY и
 * DASHSCOPE_API_KEY в репозитории нет вовсе. Запасной путь водопада, заведённый
 * именно после такой же немоты 12-14.08, был написан и не подключён — правка
 * выглядела сделанной.
 */
describe('немой прогон краснеет', () => {
  it('в workflow есть шаг, который валит прогон при нулевом разборе', () => {
    expect(WF).toMatch(/не разобрано ничего/);
    expect(WF).toMatch(/exit 1/);
  });

  it('проверка стоит ПОСЛЕ публикации отчёта', () => {
    // Иначе, чиня немоту, мы потеряем и список находок.
    expect(WF.indexOf('Publish report')).toBeLessThan(WF.indexOf('не разобрано ничего'));
  });

  it('числа берутся из отчёта, а не из отдельного счётчика', () => {
    // Отдельный счётчик разошёлся бы с тем, что читает человек.
    expect(WF).toMatch(/report\.md/);
    expect(WF).toMatch(/Разобрано находок/);
  });
});

/**
 * Ключ, заведённый владельцем, обязан дойти до водопада.
 *
 * До 19.08 `OPENROUTER_API_KEY` — ПЕРВАЯ ступень водопада — в workflow не
 * передавалась вовсе. То есть ключ можно было завести в секретах и не
 * получить ничего: раннер его не видел. А проверка ключей в скрипте знала
 * только ANTHROPIC/DEEPSEEK/DASHSCOPE и на живом ключе OpenRouter отказала бы
 * со словами «нет ни одного ключа модели».
 *
 * Две ошибки одного рода: имена ключей в проверке и в передаче разошлись с
 * теми, что зовёт водопад. Разойтись им нельзя.
 */
describe('ключи доходят до решателя', () => {
  it('workflow передаёт ключ первой ступени водопада', () => {
    expect(WF).toMatch(/OPENROUTER_API_KEY:\s*\$\{\{\s*secrets\.OPENROUTER_API_KEY/);
  });

  it('релей на раннере не задаётся — он вне РФ, и это лишняя точка отказа', () => {
    expect(WF).not.toMatch(/OPENROUTER_BASE_URL:/);
  });

  it('проверка ключей знает те же имена, что зовёт водопад', () => {
    for (const k of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY']) {
      expect(SRC, `проверка ключей не знает про ${k}`).toContain(k);
    }
  });
});
