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
import { evidenceIsQuoted, evidenceFragments, namedFiles, safeRepoPath, journalOverlap } from '../../scripts/os-audit-runner';

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

  it('ноль ПОДТВЕРЖДЁННЫХ находок краснеет: «чисто» и «не справилась» неразличимы', () => {
    expect(SRC).toContain('неразличимы');
    expect(SRC).toMatch(/confirmed\.length === 0[\s\S]{0,300}process\.exit\(1\)/);
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

/**
 * Второй заход: первый ответ модели поверхностен (владелец 08.09).
 *
 * «Без уточнения первые ответы у моделей поверхностные и больше на
 * предположениях строятся». За сутки это подтвердилось трижды на живых
 * разборах: заглушки провайдеров, «И-семантика» запроса, «потерянный слот» —
 * все три были первыми ответами и все три оказались неверны. Правду каждый
 * раз давал второй заход с уликами.
 *
 * Отсюда две проверки, которых у первой редакции аудита не было.
 */
describe('улика проверяется дословно, без вызова модели', () => {
  it('пересказ по памяти не проходит, цитата проходит', () => {
    const file = ['export const GITHUB_DELAY_FLOOR_MIN = 150;', 'const x = 1;'].join('\n');
    // Настоящая цитата — принимается.
    expect(evidenceIsQuoted('в коде стоит «GITHUB_DELAY_FLOOR_MIN = 150»', [file])).toBe(true);
    // Правдоподобный пересказ того же самого — нет.
    expect(evidenceIsQuoted('порог задержки установлен в сто пятьдесят минут', [file])).toBe(false);
  });

  it('разница в пробелах цитату не ломает', () => {
    const file = 'if (a)\n   return   null;';
    expect(evidenceIsQuoted('«if (a) return null;»', [file])).toBe(true);
  });

  it('пустая или слишком короткая улика не проходит', () => {
    expect(evidenceIsQuoted('', ['что угодно'])).toBe(false);
    expect(evidenceIsQuoted('«null»', ['null'])).toBe(false);
  });

  it('куски вырезаются из кавычек всех видов', () => {
    expect(evidenceFragments('«первый кусок текста» и `второй кусок текста`'))
      .toEqual(['первый кусок текста', 'второй кусок текста']);
  });
});

describe('перепроверка каждой находки отдельным заходом', () => {
  it('проверяющий видит только файлы своей находки', () => {
    // Ни остального набора, ни прочих находок: он судит текст, а не связность
    // рассказа аудитора.
    expect(SRC).toContain('verifyFinding');
    expect(SRC).toContain('ПРОВЕРЯЕШЬ одно утверждение');
  });

  it('у проверки три исхода, и третий не равен первому', () => {
    expect(SRC).toContain('cannot_tell');
    expect(SRC).toMatch(/«Не могу проверить» — это НЕ «подтверждается»/);
    // Отказ самой проверки тоже «не смог», а не «подтверждено». Форму
    // ответа переписали, когда 402 стали отличать от прочих отказов, —
    // свойство держим по СМЫСЛУ, а не по точной строке.
    const httpFail = SRC.slice(SRC.indexOf('if (!res.ok)'), SRC.indexOf('if (!res.ok)') + 600);
    expect(httpFail).toContain("verdict: 'cannot_tell'");
    expect(httpFail).toContain('проверяющий не ответил');
  });

  it('печатаются только подтверждённые, а непроверенные названы отдельно', () => {
    expect(SRC).toContain('НЕ УДАЛОСЬ ПРОВЕРИТЬ');
    expect(SRC).toContain('не значит «неверно»');
    expect(SRC).toMatch(/confirmed\.length === 0[\s\S]{0,300}process\.exit\(1\)/);
  });

  it('проверяющему велено быть придирчивым к убедительности', () => {
    // Держим требование, а не его формулировку: убедительность — не довод.
    expect(SRC).toMatch(/Будь придирчив к правдоподобию/);
    expect(SRC).toMatch(/звучащее убедительно, но не следующее из выданного текста/);
  });
});

/**
 * Круги не считаются — они должны РАЗЛИЧАТЬСЯ (владелец 08.09).
 *
 * «Иногда даже 3 ответ поверхностен, но это зависит от уточняющих вопросов».
 * Повторить тот же вопрос — получить тот же ответ. Круг имеет смысл только
 * тогда, когда приносит материал, которого в прошлый раз не было.
 */
describe('вопрос различающий, а не подтверждающий', () => {
  it('проверяющий сперва называет ДВЕ приметы — верности и неверности', () => {
    // Спросить «подтверждается ли» — значит позвать подтверждение. Спросить
    // «что было бы видно в обоих случаях» — значит позвать чтение.
    expect(SRC).toContain('expect_if_true');
    expect(SRC).toContain('expect_if_false');
    expect(SRC).toMatch(/Две разные приметы, а не одна/);
  });

  it('порядок работы задан явно: приметы, потом поиск, потом исход', () => {
    expect(SRC).toContain('Только после этого выноси исход');
  });

  it('общие рассуждения доказательством не считаются', () => {
    expect(SRC).toContain('как обычно бывает в таком коде');
  });
});

describe('третий круг — только с новым материалом', () => {
  it('эскалация по условию, а не по счётчику', () => {
    expect(SRC).toMatch(/v\.verdict === 'cannot_tell' && v\.missing/);
    expect(SRC).toContain('extra.length > 0');
  });

  it('выдуманный недостающий файл новым материалом не считается', () => {
    // namedFiles берёт только существующее на диске.
    expect(namedFiles('нужен lib/kuzmich/core.ts и ещё lib/выдумка-нет-такого.ts'))
      .toEqual(['lib/kuzmich/core.ts']);
  });

  it('уже выданные файлы вторым кругом не добавляются', () => {
    expect(SRC).toContain("filter((p) => !(f.files ?? []).includes(p))");
  });

  it('«не хватило» печатается: это заявка на следующий замер', () => {
    expect(SRC).toContain('не хватило:');
    expect(SRC).toContain('заявка на следующий замер');
  });

  it('число эскалаций названо в итоге — видно, сколько кругов было полезно', () => {
    expect(SRC).toContain('второй круг с новыми файлами');
  });
});

describe('путь, названный моделью, проходит через дверь', () => {
  // Модель называет файлы сама, а мы их читаем и отправляем в чужую LLM.
  // Значит имя — заявка, а не адрес: между ним и readFileSync обязана стоять
  // проверка, иначе достаточно назвать `.env.local`.
  it('выход за дерево репозитория не пропускается', () => {
    expect(safeRepoPath('../../etc/passwd')).toBeNull();
    expect(safeRepoPath('lib/../../etc/hosts')).toBeNull();
    expect(safeRepoPath('/etc/passwd')).toBeNull();
  });

  it('секреты и скрытые файлы не пропускаются', () => {
    expect(safeRepoPath('.env.local')).toBeNull();
    expect(safeRepoPath('.env')).toBeNull();
    expect(safeRepoPath('.git/config')).toBeNull();
  });

  it('расширение вне списка не пропускается', () => {
    expect(safeRepoPath('scripts/deploy.sh')).toBeNull();
    expect(safeRepoPath('public/images/logo.png')).toBeNull();
  });

  it('свой исходник и расписание крона — пропускаются', () => {
    expect(safeRepoPath('lib/kuzmich/core.ts')).toContain('lib/kuzmich/core.ts');
    expect(safeRepoPath('.github/workflows/cron-evo.yml')).toContain('cron-evo.yml');
  });

  it('namedFiles не пускает то, что дверь не пропустила', () => {
    expect(namedFiles('смотри ../../etc/passwd и .env.local')).toEqual([]);
  });
});

describe('круг проверки не голодает и не врёт про причину', () => {
  it('у проверки своя модель, по умолчанию — основная', () => {
    // Два прогона подряд кончились одинаково: основной проход съедал баланс,
    // проверка упиралась в 402. Задача проверки узкая — флагман ей не нужен.
    expect(SRC).toContain('AUDIT_VERIFY_MODEL');
    expect(SRC).toMatch(/verifyModel = process\.env\.AUDIT_VERIFY_MODEL\?\.trim\(\) \|\| model/);
  });

  it('проверка зовётся моделью проверки, а не основной', () => {
    expect(SRC).toMatch(/verifyFinding\(key, verifyModel, f, byPath\)/);
    expect(SRC).not.toMatch(/verifyFinding\(key, model, f, byPath\)/);
  });

  it('402 отличается от прочих отказов: денег нет — дальше не ходим', () => {
    expect(SRC).toContain('outOfFunds: res.status === 402');
    expect(SRC).toMatch(/if \(outOfFunds\) \{/);
  });

  it('недошедшая находка называется своими словами, а не «HTTP 402»', () => {
    expect(SRC).toContain('до этой находки проверка не дошла');
  });

  it('нехватка денег печатается ОТДЕЛЬНОЙ строкой от «не смог по существу»', () => {
    expect(SRC).toContain('ВНИМАНИЕ: на круге проверки кончился баланс');
    expect(SRC).toContain('перетасует');
  });

  it('маркер умеет задавать модель проверки', () => {
    const wf = readFileSync('.github/workflows/os-audit.yml', 'utf8');
    expect(wf).toContain("get('verify_model')");
    expect(wf).toContain('export AUDIT_VERIFY_MODEL');
  });
});

describe('оплаченный проход переживает прогон', () => {
  const WF = readFileSync('.github/workflows/os-audit.yml', 'utf8');

  it('находки сохраняются ДО проверки и независимо от её исхода', () => {
    // Проход стоит ~751 ₽. Терять его результат оттого, что на проверку не
    // хватило денег, — ровно та потеря, из-за которой режим и заведён.
    const save = SRC.indexOf('writeFileSync(FINDINGS_OUT');
    const verify = SRC.indexOf('await verifyAndReport(key, model, good, byPath');
    expect(save).toBeGreaterThan(0);
    expect(save).toBeLessThan(verify);
  });

  it('неудача сохранения названа вслух, а не проглочена', () => {
    expect(SRC).toContain('Находки не сохранены:');
  });

  it('есть режим «проверить сохранённое» без нового прохода', () => {
    expect(SRC).toContain('AUDIT_FINDINGS_IN');
    expect(SRC).toMatch(/if \(FINDINGS_IN\) \{[\s\S]{0,120}verifyOnly/);
  });

  it('пустой файл находок — отказ, а не «всё чисто»', () => {
    expect(SRC).toContain('проверять нечего. Это отказ, а не «всё чисто»');
  });

  it('расхождение коммитов видно: улика могла не найтись из-за правки файла', () => {
    expect(SRC).toContain('проверка идёт на ДРУГОМ коммите');
    expect(SRC).toMatch(/файл изменился/);
  });

  it('workflow кладёт находки артефактом даже при красном прогоне', () => {
    expect(WF).toContain('upload-artifact');
    expect(WF).toMatch(/name: Сохранить находки прохода[\s\S]{0,80}if: always\(\)/);
  });

  it('workflow умеет проверять находки прошлого прогона', () => {
    expect(WF).toContain('verify_findings_run');
    expect(WF).toContain('download-artifact');
    expect(WF).toContain('AUDIT_FINDINGS_IN: audit-findings.json');
  });

  it('проход и проверка взаимоисключающи — иначе снова заплатим за оба', () => {
    expect(WF).toMatch(/name: Аудит одним проходом\n\s+if: inputs\.verify_findings_run == ''/);
  });
});

describe('смена модели не ломает прогон и не выдумывает цену', () => {
  it('temperature шлётся только тем, кто её принимает', () => {
    // У Claude 4.6+ сэмплирование снято: temperature даёт 400, и прогон упал
    // бы, не начавшись. Проверяем ОБА места — проход и круг проверки.
    const sends = SRC.match(/modelProfile\((?:model)\)\.sampling \? \{ temperature/g) ?? [];
    expect(sends.length).toBe(2);
    expect(SRC).not.toMatch(/^\s+temperature: 0(\.\d+)?,$/m);
  });

  it('у anthropic-моделей сэмплирование выключено по умолчанию', () => {
    expect(SRC).toMatch(/sampling: !model\.startsWith\('anthropic\/'\)/);
  });

  it('неизвестной модели цена НЕ приписывается', () => {
    // Прежде цена считалась константой Astra с подписью «прайс Astra» — под
    // другой моделью это было бы уверенное неверное число (§4.0).
    expect(SRC).toContain('тариф модели');
    expect(SRC).toContain('не записан в MODEL_PROFILES');
    // Запрещена КОНСТРУКЦИЯ, а не слово: объяснять историю в комментарии
    // нужно, а считать цену чужим зашитым тарифом — нельзя. Первая версия
    // этой проверки ловила фразу и споткнулась о собственное объяснение.
    expect(SRC).not.toMatch(/;\s*\/\/\s*прайс \w+ из каталога/);
  });

  it('цена считается по тарифу профиля, а не по зашитой константе', () => {
    expect(SRC).toMatch(/price\.usdPerMTokIn !== null && price\.usdPerMTokOut !== null/);
    expect(SRC).not.toMatch(/inTok \* 1e-5 \+ outTok \* 5e-5/);
    // Цена названа оценкой: через OpenRouter возможна своя наценка поверх
    // каталожного тарифа, и выдавать оценку за факт нельзя.
    expect(SRC).toMatch(/оценка по §8/);
  });

  it('модель маркера имеет профиль — иначе цену никто не посчитает', () => {
    const marker = JSON.parse(readFileSync('.github/triggers/os-audit.json', 'utf8'));
    expect(SRC).toContain(`'${marker.model}':`);
  });
});

describe('одно и то же не проверяется по второму разу', () => {
  const JOURNAL = JSON.parse(readFileSync('.github/audit-journal.json', 'utf8'));

  it('журнал есть и у каждой записи сказано, ЧЕМ кончилось и почему', () => {
    expect(Array.isArray(JOURNAL.resolved)).toBe(true);
    expect(JOURNAL.resolved.length).toBeGreaterThan(0);
    for (const e of JOURNAL.resolved) {
      expect(e.files?.length, `у записи «${e.what}» нет файлов`).toBeGreaterThan(0);
      expect(e.decision, `у записи «${e.what}» нет решения`).toBeTruthy();
      // Без «почему» запись через месяц неотличима от отговорки.
      expect(e.note?.length ?? 0, `у записи «${e.what}» нет причины`).toBeGreaterThan(20);
    }
  });

  it('журнал уходит в промпт: модель знает, что уже разобрано', () => {
    expect(SRC).toContain('УЖЕ РАЗОБРАНО РАНЬШЕ');
    expect(SRC).toMatch(/journalBlock\(journal\)/);
  });

  it('пересечение по файлам находит запись', () => {
    const j = [{ files: ['lib/agents/agencies/rescue-agency.ts'], what: 'x', decision: 'fixed' }];
    expect(journalOverlap(['lib/agents/agencies/rescue-agency.ts'], j)).not.toBeNull();
    expect(journalOverlap(['lib/kuzmich/core.ts'], j)).toBeNull();
    expect(journalOverlap([], j)).toBeNull();
  });

  it('CLAUDE.md тождества НЕ доказывает — иначе «разобрано» будет у всего', () => {
    // Правила стоят почти в каждой находке и пересекаются со всем подряд.
    const j = [{ files: ['CLAUDE.md', 'AGENTS.md'], what: 'x', decision: 'fixed' }];
    expect(journalOverlap(['CLAUDE.md', 'lib/новое.ts'], j)).toBeNull();
  });

  it('совпавшая находка НЕ выбрасывается, а уходит в конец очереди', () => {
    // Глушить по догадке значило бы прятать регрессию там, где уже чинили.
    expect(SRC).toContain('не отброшены — совпадение по файлу не доказывает тождества');
    expect(SRC).toMatch(/good = \[\.\.\.fresh, \.\.\.seen\]/);
  });

  it('подтверждённая находка по разобранному месту помечена вслух', () => {
    expect(SRC).toContain('починка не удержалась');
  });
});

describe('аудит предлагает усиление, а не только чинит', () => {
  it('промпт просит предложения и требует у них улику', () => {
    expect(SRC).toContain('УСИЛЕНИЕ:');
    expect(SRC).toContain('Предложение без улики — фантазия');
    expect(SRC).toContain('strengthening');
  });

  it('промпт называет, чего в предложениях НЕ надо', () => {
    // Иначе это генератор списка желаний, а не аудит.
    expect(SRC).toContain('добавить мониторинг');
    expect(SRC).toMatch(/нельзя проверить кодом или замером/);
  });

  it('предложения НЕ идут через «подтверждено/опровергнуто»', () => {
    // Проверяющий отвечает «есть ли названное в файле»; предложение
    // утверждает то, чего ещё нет, и такой вердикт ничего не решает.
    expect(SRC).toMatch(/const proposals = good\.filter\(\(f\) => f\.kind === 'strengthening'\)/);
    expect(SRC).toMatch(/const defects = good\.filter\(\(f\) => f\.kind !== 'strengthening'\)/);
    expect(SRC).toContain('утверждают то, чего ещё НЕТ');
  });

  it('предложения печатаются своим разделом с уликой', () => {
    expect(SRC).toContain('ПРЕДЛОЖЕНИЯ УСИЛЕНИЯ');
    expect(SRC).toContain('от чего отталкиваемся');
  });

  it('пустой разбор — отказ, а не «платформа безупречна»', () => {
    expect(SRC).toContain('Это отказ разбора, а не «платформа безупречна»');
  });
});

/**
 * Уроки прогона 5 (08.09), который сгорел впустую на 1324 ₽.
 *
 * Ответ пришёл ровно на 32000 токенов — в точности наш `max_tokens` — и с
 * ПУСТЫМ полем содержимого. У этого поколения моделей рассуждение включено
 * всегда и считается в тот же бюджет выхода: он ушёл на думание, до ответа
 * очередь не дошла. Раннер при этом напечатал «Ответ без содержимого» и
 * вышел — ни `stop_reason`, ни разбивки токенов, то есть не смог назвать
 * причину собственного отказа.
 *
 * Три правила, которые теперь держит сторож: смета ДО траты, дешёвая проба
 * формы перед дорогим проходом, и потолок выхода, при котором обязателен
 * streaming.
 */
describe('проход через Anthropic: платим только после сметы', () => {
  const SRC = readFileSync('scripts/os-audit-runner.ts', 'utf8');

  it('размер входа считается до запуска модели', () => {
    expect(SRC).toMatch(/client\.messages\.countTokens\(/);
    const at = SRC.indexOf('client.messages.countTokens(');
    const streamAt = SRC.indexOf('client.messages.stream(');
    expect(at, 'смета обязана считаться раньше прохода').toBeLessThan(streamAt);
  });

  it('превышение бюджета — отказ БЕЗ траты', () => {
    expect(SRC).toContain('AUDIT_BUDGET_USD');
    expect(SRC).toContain('ОТКАЗ ДО ТРАТЫ');
  });

  it('перед дорогим проходом идёт дешёвая проба формы', () => {
    const probeAt = SRC.indexOf('проба формы');
    const streamAt = SRC.indexOf('client.messages.stream(');
    expect(probeAt).toBeGreaterThan(0);
    expect(probeAt, 'проба обязана идти до прохода').toBeLessThan(streamAt);
    expect(SRC).toContain('ПРОБА НЕ ДАЛА ТЕКСТА');
  });

  it('проход идёт стримом: при таком потолке иначе таймаут', () => {
    expect(SRC).toMatch(/client\.messages\.stream\(\{/);
    // Потолок должен быть заметно выше того, чего не хватило в прогоне 5
    // (32000), и не выше того, что модель вообще держит (128000).
    const cap = Number(SRC.match(/const ANTHROPIC_MAX_OUTPUT = (\d+);/)?.[1]);
    expect(cap).toBeGreaterThan(32000);
    expect(cap).toBeLessThanOrEqual(128000);
  });

  it('глубина думания задаётся effort, а не бюджетом токенов', () => {
    expect(SRC).toMatch(/output_config: \{ effort: 'high' \}/);
    // budget_tokens и явный thinking у этого поколения дают 400.
    expect(SRC).not.toMatch(/budget_tokens/);
    expect(SRC).not.toMatch(/thinking: \{ type:/);
  });

  it('отказ называется поимённо: stop_reason и разбивка блоков', () => {
    expect(SRC).toMatch(/остановка: \$\{msg\.stop_reason\}/);
    expect(SRC).toContain('блоков рассуждения');
    expect(SRC).toContain('ОТВЕТ НЕ УМЕСТИЛСЯ');
    expect(SRC).toContain('МОДЕЛЬ ОТКАЗАЛАСЬ');
  });

  it('разбор ответа — ОДИН на оба пути, а не копия на каждый', () => {
    expect(SRC).toMatch(/async function handleAnswer\(/);
    const calls = SRC.match(/await handleAnswer\(/g) ?? [];
    expect(calls.length, 'оба пути обязаны звать общий разбор').toBe(2);
  });

  it('поставщик выбирается по форме имени модели', () => {
    expect(SRC).toMatch(/function isAnthropicDirect\(model: string\): boolean \{\s*\n\s*return !model\.includes\('\/'\);/);
  });
});
