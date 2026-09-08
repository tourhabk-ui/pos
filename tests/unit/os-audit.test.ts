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
import { evidenceIsQuoted, evidenceFragments, namedFiles, safeRepoPath } from '../../scripts/os-audit-runner';

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
