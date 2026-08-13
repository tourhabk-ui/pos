/**
 * Находка описывает ЭТОТ файл, а не воображаемый.
 *
 * #1159: «на строке 45 вызывается pool.connect(), но отсутствует блок finally
 * с client.release()». В `app/api/hub/bookings/create/route.ts` нет ни
 * pool.connect, ни release — только pool.query, а строка 45 это проверка
 * rate-limiter'а. Та же находка заводилась трижды: #1106 (10.08), #1131
 * (11.08), #1159 (13.08). Дважды закрыта, дважды вернулась — самоподдерживающийся
 * шум, который человек разбирает заново каждое утро.
 *
 * Симметричная ловушка, из-за которой правило именно такое: находка ИМЕЕТ
 * ПРАВО говорить об отсутствии. #1158 верна ровно потому, что заголовка
 * X-Telegram-Bot-Api-Secret-Token в файле нет. Поэтому проверка отклоняет
 * только когда не найден НИ ОДИН из процитированных вызовов.
 *
 * Тела находок ниже — настоящие, из Issues; файлы читаются с диска. Проверять
 * такое на выдуманных примерах бессмысленно: вопрос ровно в том, совпадает ли
 * находка с реальным кодом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  citedCallSymbols,
  sourceMentionsSymbol,
  verifyAgainstSource,
  type CandidateFinding,
} from '@/lib/agents/evo/finding-guard';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** #1159 — ложная: описывает код, которого в файле нет. */
const FALSE_1159: CandidateFinding = {
  title: 'Утечка pool.connect без release',
  description:
    'На строке 45 вызывается pool.connect(), но отсутствует блок finally с client.release(). ' +
    'При любом исключении соединение не вернётся в пул, что приведёт к исчерпанию пула.',
  suggestion: 'Обернуть код после pool.connect() в try, в finally добавить client.release().',
};

/** #1158 — настоящая: дыра именно в том, что заголовка НЕТ. */
const REAL_1158: CandidateFinding = {
  title: 'Admin webhook без проверки secret_token',
  description:
    'POST /api/telegram/admin — webhook для команд владельца. В коде POST нет проверки ' +
    'X-Telegram-Bot-Api-Secret-Token. Любой, кто знает URL, может отправить команды /stats, ' +
    '/leads и получить чувствительные данные. Защита только по fromId===ownerId.',
  suggestion: 'Создать `lib/telegram/verifyWebhookSecret.ts` и звать её первой в POST.',
};

/** #1160 — настоящая: открытый прокси к Bot API. */
const REAL_1160: CandidateFinding = {
  title: 'Публичный endpoint раскрывает токен бота',
  description:
    'GET /api/telegram/probe/[token] — публичный, без аутентификации. Любой может передать ' +
    'произвольный токен бота и вызвать getMe, getWebhookInfo, setWebhook.',
  suggestion: 'Удалить каталог [token], перенести под admin-guard.',
};

describe('извлечение процитированных вызовов', () => {
  it('берёт вызовы и обращения к членам', () => {
    const s = citedCallSymbols(`${FALSE_1159.title} ${FALSE_1159.description}`);
    expect(s).toContain('pool.connect');
    expect(s).toContain('client.release');
  });

  it('не берёт голые слова из прозы', () => {
    // «finally», «POST», «search» встречаются в тексте в чужих смыслах.
    // Отсев по ним был бы гаданием, а не проверкой.
    const s = citedCallSymbols('отсутствует блок finally в POST, параметр search небезопасен');
    expect(s).toEqual([]);
  });

  it('план правки в извлечение не попадает', () => {
    // suggestion законно предлагает создать то, чего пока нет.
    const s = citedCallSymbols(`${REAL_1158.title} ${REAL_1158.description}`);
    expect(s).not.toContain('lib/telegram/verifyWebhookSecret.ts');
  });
});

describe('сверка символа с исходником', () => {
  it('приёмник может быть переименован — ищем и по имени метода', () => {
    // Модель пишет client.release, в коде c.release() — придираться к имени
    // переменной значило бы отсеивать находку за пересказ, а не за выдумку.
    expect(sourceMentionsSymbol('const c = await pool.connect(); c.release();', 'client.release'))
      .toBe(true);
  });

  it('чего нет — того нет', () => {
    expect(sourceMentionsSymbol('await pool.query(sql, params);', 'pool.connect')).toBe(false);
  });
});

describe('на настоящих находках и настоящих файлах', () => {
  it('#1159 отклонена: ни один процитированный вызов в файле не встречается', () => {
    const source = src('app/api/hub/bookings/create/route.ts');
    expect(verifyAgainstSource(FALSE_1159, source)).toBe('source_lacks_cited_symbols');
  });

  it('#1158 проходит: находка про отсутствие, и это её правда', () => {
    const source = src('app/api/telegram/admin/route.ts');
    expect(verifyAgainstSource(REAL_1158, source)).toBeNull();
  });

  it('#1160 проходит', () => {
    const source = src('app/api/telegram/probe/[token]/route.ts');
    expect(verifyAgainstSource(REAL_1160, source)).toBeNull();
  });

  it('без исходника проверка молчит, а не отклоняет', () => {
    // Нет файла — нет основания судить. Отсев «на всякий случай» был бы
    // ровно той подменой незнания знанием, против которой страж и стоит.
    expect(verifyAgainstSource(FALSE_1159, null)).toBeNull();
  });

  it('ничего не процитировано — проверка не применяется', () => {
    const bare: CandidateFinding = {
      title: 'Роут возвращает 500 на пустом теле',
      description: 'Пустое тело приводит к необработанной ошибке.',
      suggestion: 'Добавить проверку.',
    };
    expect(verifyAgainstSource(bare, 'export async function POST() {}')).toBeNull();
  });
});
