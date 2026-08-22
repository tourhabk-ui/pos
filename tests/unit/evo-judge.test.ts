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
import { renderReport, balanceLine, selectForJudging, readSnippet, type Judged } from '@/scripts/evo-judge';

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
/**
 * Судья видит код, а не только текст находки.
 *
 * 19.08 обе «инъекции» в lib/auth/tourist-helpers получили «по делу» через
 * несколько часов после того, как их починили: в запросе уже стоял параметр
 * `INTERVAL '1 day' * $2`. Судья этого не знал — ему передавали только текст
 * находки. Там же все три «мало данных» оказались просьбами показать файл,
 * который лежал на том же раннере, распакованный.
 *
 * Находка старше кода всегда. Значит судить надо по коду.
 */
describe('судья судит по коду, а не по тексту находки', () => {
  it('кусок кода уходит в промпт и назван кодом', () => {
    expect(SRC).toMatch(/КОД СЕЙЧАС/);
    expect(SRC).toMatch(/readSnippet\(f\.file_path, f\.line_number, identifiersFrom\(f\)\)/);
  });

  it('отсутствие кода названо прямо, а не пропущено молча', () => {
    // Пустое место читается как «кода не нужно». Судья должен знать разницу
    // между «файл назван, но не прочитан» и «файла находка не называет» —
    // это разные вещи, и вердикты у них разные.
    expect(SRC).toMatch(/Кода нет: файл \$\{f\.file_path\} не прочитан/);
    expect(SRC).toMatch(/Файла эта находка не называет/);
  });

  it('промпт велит судить по коду, потому что находка старше', () => {
    expect(SRC).toMatch(/суди ПО КОДУ/);
    expect(SRC).toMatch(/находка старше кода/);
  });

  it('«уже починено» — отдельный вердикт, не «шум» и не «по делу»', () => {
    // Починенное и выдуманное — разные вещи. Свалить их в «шум» значит
    // потерять счёт тому, что эволюция действительно нашла и мы закрыли.
    expect(SRC).toMatch(/fixed: 'уже починено'/);
    expect(SRC).toMatch(/\| уже починено \|/);
    const md = renderReport([
      { finding: finding('Инъекция в интервал'), verdict: 'fixed', reason: 'в коде параметр $2' },
    ]);
    expect(md).toMatch(/\| уже починено \| 1 \|/);
    expect(md).toMatch(/## Уже починено/);
    expect(md).not.toMatch(/## Шум/);
  });

  it('путь из базы проверяется как чужой', () => {
    const read = () => 'не должно быть прочитано';
    expect(readSnippet('../../etc/passwd', 1, [], read)).toBeNull();
    expect(readSnippet('/etc/passwd', 1, [], read)).toBeNull();
    expect(readSnippet('lib/a.ts/../../../x.ts', 1, [], read)).toBeNull();
    expect(readSnippet('.env.local', 1, [], read)).toBeNull();
    expect(readSnippet('secrets.pem', 1, [], read)).toBeNull();
  });

  it('небольшой файл уходит целиком — окно тут нечего угадывать', () => {
    const file = Array.from({ length: 120 }, (_, i) => `строка ${i}`).join('\n');
    const out = readSnippet('lib/a.ts', 3, [], () => file);
    expect(out).toBe(file);
    expect(out).not.toMatch(/кусок обрезан/);
  });

  it('место находят по имени из находки, а не по устаревшему номеру строки', () => {
    // Прогон 3: «приложенный код обрывается до getUpcomingTripsWithReminders» —
    // функция была в файле, но за краем окна вокруг номера от старой версии.
    const big = Array.from({ length: 4000 }, (_, i) =>
      i === 3500 ? 'export async function getUpcomingTripsWithReminders() {' : `// строка ${i}`,
    ).join('\n');
    const out = readSnippet('lib/a.ts', 10, ['getUpcomingTripsWithReminders'], () => big);
    expect(out).toContain('getUpcomingTripsWithReminders');
  });

  it('обрезка названа вслух: чего нет в куске, может быть в файле', () => {
    // Молчаливое окно читается как весь файл, и «в куске дефекта нет»
    // превращается в «дефекта нет».
    const big = Array.from({ length: 4000 }, (_, i) => `// строка ${i}`).join('\n');
    const out = readSnippet('lib/a.ts', 2000, [], () => big) ?? '';
    expect(out).toMatch(/кусок обрезан/);
    expect(out).toMatch(/может быть в файле/);
    expect(SRC).toMatch(/это needs_info, а не fixed/);
  });

  it('находка без файла — не о коде, и отсутствие кода ей не вменяется', () => {
    // Прогон 3 раздул «мало данных» с 3 до 20: заметки про чужие анонсы
    // моделей получали «кода нет, проверить нельзя» — а кода у них и не может
    // быть, они не утверждают ничего о коде.
    expect(SRC).toMatch(/Файла эта находка не называет/);
    expect(SRC).toMatch(/Находка БЕЗ файла/);
    expect(SRC).toMatch(/Отсутствие\s*\n?кода тут НЕ повод для needs_info/);
  });

  it('нет файла — нет куска, и это не роняет разбор', () => {
    expect(readSnippet('lib/нет-такого.ts', 10, [], () => { throw new Error('ENOENT'); })).toBeNull();
    expect(readSnippet(null, null, [], () => 'x')).toBeNull();
  });

  it('сорванная форма ответа переспрашивается один раз, а не теряется', () => {
    expect(SRC).toMatch(/if \(!retried\)/);
    expect(SRC).toMatch(/Вторая попытка не делается/);
  });
});

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

/**
 * Кто вынес вердикт — видно в строке вердикта.
 *
 * Разбор 19.08 шёл ТРЕМЯ моделями сразу: deepseek-v4-pro, deepseek-chat,
 * deepseek-v4-flash. Внутри водопада подмена тихая — сильнейшая молчит,
 * отвечает следующая, ответ приходит, отличить его нечем. Шапка «Судья: A,
 * B, C» это скрывала: какие именно находки судила запасная модель, из отчёта
 * узнать было нельзя.
 */
describe('сила суждения не прячется', () => {
  const j = (title: string, model: string): Judged => ({
    finding: finding(title), verdict: 'real', reason: 'причина', model,
    provenance: model === 'deepseek-chat' ? ['deepseek(v4-pro): пустой ответ'] : undefined,
  });

  it('один судья — просто назван, без лишней таблицы', () => {
    const md = renderReport([j('А', 'deepseek-v4-pro')]);
    expect(md).toMatch(/Судья: deepseek-v4-pro/);
    expect(md).not.toMatch(/Судьи разные/);
    expect(md).not.toMatch(/· deepseek-v4-pro/);
  });

  it('судей несколько — счёт по каждому и предупреждение', () => {
    const md = renderReport([j('А', 'deepseek-v4-pro'), j('Б', 'deepseek-chat')]);
    expect(md).toMatch(/Судьи разные — сила суждения неодинакова/);
    expect(md).toMatch(/\| deepseek-v4-pro \| 1 \|/);
    expect(md).toMatch(/\| deepseek-chat \| 1 \|/);
  });

  it('модель стоит в строке вердикта, а не только в шапке', () => {
    // Читающий решает по строке — знать, кто её вынес, надо в ней же.
    const md = renderReport([j('А', 'deepseek-v4-pro'), j('Б', 'deepseek-chat')]);
    expect(md).toMatch(/по делу · deepseek-chat: причина/);
  });

  it('причина отступления от первой ступени доходит до отчёта', () => {
    // Раньше provenance печатался только при ПОЛНОЙ немоте — то есть ровно
    // тогда, когда чинить уже поздно.
    const md = renderReport([j('А', 'deepseek-v4-pro'), j('Б', 'deepseek-chat')]);
    expect(md).toMatch(/Почему отвечала не первая ступень \(1 из 2\)/);
    expect(md).toMatch(/deepseek\(v4-pro\): пустой ответ — 1/);
  });

  it('код кладёт provenance в вердикт, а не выбрасывает', () => {
    expect(SRC).toMatch(/provenance: res\.provenance/);
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
/**
 * Очередь, где половина задач мертва, перестаёт быть очередью.
 *
 * Каждый прогон заводил новую задачу с отчётом, а старую не закрывал никто.
 * К 19.08 висело пять выпусков, четыре из них — про уже разобранное или про
 * немоту, устранённую в тот же день. Живое в такой очереди не отличить.
 */
describe('прошлые выпуски разбора закрываются сами', () => {
  it('новый выпуск закрывает предыдущие', () => {
    expect(WF).toMatch(/gh issue close .* --reason completed/);
    expect(WF).toMatch(/Заменено более свежим разбором/);
  });

  it('закрываются только выпуски разбора, а не всё с меткой evo', () => {
    // Под меткой evo живут находки другого рода — например #1155 про
    // расхождение каналов. Закрыть их автоматом значило бы потерять
    // настоящее вместе с отработавшим.
    expect(WF).toMatch(/startswith\("Разбор находок эволюции"\)/);
  });

  it('свежий выпуск себя не закрывает', () => {
    expect(WF).toMatch(/\[ "\$N" = "\$NEW_NUM" \] && continue/);
  });

  it('перед закрытием сказано, куда смотреть дальше', () => {
    // Закрытие без объяснения читается как «замяли».
    expect(WF).toMatch(/Находки живут в базе, а не в этой задаче/);
  });
});

/**
 * Счёт спрашивается, а не выводится из текста чужой ошибки.
 *
 * Четверо суток (16-19.08) разбор молчал, и причину читали из тела ответа
 * модели — «Credit balance is too low», сорок шесть раз подряд. Спросить счёт
 * напрямую было можно всё это время: checkOpenRouterBalance() написана давно и
 * не имела НИ ОДНОГО потребителя — тот же сюжет, что с validateRoutePost в
 * июле, где полный валидатор с комментарием «каждый пост ОБЯЗАН пройти
 * проверку» никем не вызывался.
 */
describe('состояние счёта названо числом', () => {
  it('остаток печатается прямо', () => {
    const line = balanceLine({ total_credits: 10, total_usage: 7.5, remaining: 2.5, low: false });
    expect(line).toContain('$2.5');
    expect(line).toContain('потрачено $7.5');
  });

  it('исход на исходе помечен словом, а не только числом', () => {
    // Человек читает строку глазами; «$0.3» без пометки проскакивает.
    expect(balanceLine({ total_credits: 10, total_usage: 9.7, remaining: 0.3, low: true }))
      .toContain('НА ИСХОДЕ');
  });

  it('постоплата — не «ноль денег»', () => {
    const line = balanceLine({ total_credits: 0, total_usage: 12, remaining: null, low: false });
    expect(line).toContain('постоплата');
    expect(line).not.toContain('НА ИСХОДЕ');
  });

  it('«не спросили» отличимо от «денег нет»', () => {
    // Третий исход: ключа управления нет или запрос не прошёл (§4.0).
    expect(balanceLine(null)).toMatch(/не спросили/);
  });

  it('счёт попадает в отчёт сразу под числом находок', () => {
    const md = renderReport(
      [{ finding: finding('А'), verdict: 'real', reason: 'причина' }],
      'Счёт OpenRouter: осталось $2.19.',
    );
    const lines = md.split('\n');
    expect(lines[0]).toMatch(/Разобрано находок/);
    expect(lines[1]).toMatch(/Счёт OpenRouter/);
  });

  it('без счёта отчёт остаётся валидным', () => {
    const md = renderReport([{ finding: finding('А'), verdict: 'real', reason: 'причина' }]);
    expect(md).toMatch(/Разобрано находок/);
    expect(md).not.toMatch(/Счёт OpenRouter/);
  });

  it('ключ управления доезжает до джоба', () => {
    expect(WF).toMatch(/OPENROUTER_MANAGEMENT_KEY: \$\{\{ secrets\.OPENROUTER_MANAGEMENT_KEY \}\}/);
  });

  it('счёт спрашивается ДО разбора, а не после', () => {
    // Если денег нет, это должно быть написано в отчёте, а не выведено
    // человеком из сорока шести одинаковых отказов.
    const src = SRC;
    expect(src.indexOf('checkOpenRouterBalance()')).toBeLessThan(src.indexOf('judgeAll(picked)'));
  });
});

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
