/**
 * Клиент Точки: адреса, конверт ответа и словарь статусов.
 *
 * Прежняя версия не работала целиком, и это выяснилось не рассуждением, а
 * опытом: пробы 109-121 спрашивали песочницу Точки поимённо. Ответы живого
 * сервера и есть содержание этого сторожа — он держит то, что стоило двенадцати
 * проб, чтобы следующая правка не вернула прежнее «правдоподобное».
 *
 * Самое важное свойство здесь — ПУСТОЙ список оплаченных статусов. Он выглядит
 * недоделкой и ею не является: значение, означающее «оплачено», нам неизвестно,
 * а придуманное подтвердило бы бронь без денег либо потеряло настоящую оплату.
 * Пустой список отправляет неизвестное в «не выяснили», и приёмник просит
 * повтор вместо того, чтобы соврать. Сторож запрещает наполнить его иначе, чем
 * фактом: строкой от банка или строкой из документации, прочитанной глазами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/payments/tochka.ts'), 'utf-8');
/**
 * Судим КОД, а не прозу: в шапке файла нарочно цитируются старые адреса.
 *
 * Двойная косая режется только там, где ей не предшествует двоеточие. Наивный
 * `//[^\n]*` съедал бы `https://enter.tochka.com/...` начиная со схемы — то
 * есть сторож адресов ослеп бы ровно на адресах, которые проверяет, и молча
 * прошёл бы. Один раз он так и упал, и это дешевле поймать здесь, чем в файле,
 * где адрес важнее всего.
 */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('адреса — те, что ответили песочнице', () => {
  it('выпуск QR идёт БЕЗ слова account в пути', () => {
    // С ним песочница отвечает 400 «Field accountId : Value error, invalid»:
    // лишний сегмент съедает значение параметра.
    expect(CODE).toMatch(/\/sbp\/v1\.0\/qr-code\/merchant\/\$\{[^}]+\}\/\$\{/);
    expect(CODE).not.toMatch(/qr-code\/merchant\/[^`\n]*\/account\//);
  });

  it('статус спрашивается новым методом qr-codes/{id}/payment-status', () => {
    expect(CODE).toMatch(/\/sbp\/v1\.0\/qr-codes\/\$\{[^}]+\}\/payment-status/);
  });

  it('старый метод статуса не возвращается', () => {
    // .../qr-code/merchant/{m}/payment-status/{qr} → 501 Not Implemented.
    expect(CODE).not.toMatch(/payment-status\/\$\{/);
  });
});

describe('авторизация — статический JWT, а не поток для чужих клиентов', () => {
  it('client_credentials больше не запрашивается', () => {
    // OAuth у Точки предназначен для сервисов, работающих ОТ ИМЕНИ других
    // компаний, и это три запроса с согласием (consent_id), а не два поля.
    expect(CODE).not.toMatch(/client_credentials|connect\/token|TOCHKA_CLIENT_SECRET/);
  });

  it('ключ берётся из TOCHKA_JWT_TOKEN', () => {
    expect(CODE).toMatch(/TOCHKA_JWT_TOKEN/);
  });

  it('готовность считает три переменные, а не четыре', () => {
    // Список один — в tochkaMissingEnv; isTochkaConfigured спрашивает его.
    const fn = CODE.slice(CODE.indexOf('export function tochkaMissingEnv'));
    expect(fn).toMatch(/TOCHKA_JWT_TOKEN/);
    expect(fn).toMatch(/TOCHKA_MERCHANT_ID/);
    expect(fn).toMatch(/TOCHKA_ACCOUNT_ID/);
    expect(fn).not.toMatch(/TOCHKA_CLIENT_ID/);
  });
});

describe('конверт Data разбирается, а не пропускается', () => {
  it('ответ читается из Data, а не с корня', () => {
    // data.image.content на живом ответе давал TypeError — то есть успешный
    // выпуск QR возвращался как null.
    expect(CODE).toMatch(/json\?\.Data/);
    expect(CODE).toMatch(/Envelope|Data\?:/);
  });

  it('двухсотый без конверта — отказ, а не пустые данные', () => {
    expect(SRC).toMatch(/ответ 200 без конверта Data/);
  });

  it('статус читается СПИСКОМ и выбирается свой QR', () => {
    // Метод спрашивает несколько QR сразу; брать первый вслепую нельзя.
    expect(CODE).toMatch(/paymentList/);
    expect(CODE).toMatch(/list\.find\(\(p\) => p\.qrcId === qrId\)/);
  });
});

describe('словарь статусов: пустой там, где знания нет', () => {
  it('список оплаченных статусов ПУСТ', () => {
    // Не недоделка, а решение. Наполнять только фактом: строкой от банка при
    // настоящей оплате или строкой из документации, прочитанной глазами.
    // Если этот тест упал — убедись, что значение именно проверено, и обнови
    // вместе с ним причину в шапке файла.
    expect(CODE).toMatch(/const PAID_STATUSES = new Set<string>\(\);/);
  });

  it('известные «ещё не оплачено» — только те, что видели', () => {
    expect(CODE).toMatch(/PENDING_STATUSES = new Set\(\['NotStarted', 'InProgress'\]\)/);
  });

  it('неопознанный статус уходит в «не выяснили», а не в «не оплачено»', () => {
    const fn = SRC.slice(SRC.indexOf('export async function getSBPPaymentStatus'));
    expect(fn).toMatch(/не опознано/);
    expect(fn).toMatch(/НЕ ВЫЯСНЕННЫМ/);
    // Ветка неизвестного обязана заканчиваться null: это же значение
    // возвращается при недоступном банке, и приёмник просит повтор вебхука.
    const tail = fn.slice(fn.lastIndexOf('console.error'));
    expect(tail).toMatch(/return null;/);
  });

  it('неизвестный QR — тоже «не выяснили»', () => {
    expect(CODE).toMatch(/NOT_FOUND_CODE = 'RQ05014'/);
  });
});

describe('отказы не глушатся', () => {
  it('тело ошибки печатается целиком', () => {
    // В нём лежит имя поля, на котором запрос не прошёл, — единственный
    // источник формы запроса, которой нет в открытой документации.
    expect(CODE).toMatch(/console\.error\(`\[tochka\] \$\{method\} \$\{safePath\(path\)\} → \$\{res\.status\}: \$\{err\}`\)/);
  });

  it('пустого catch нет', () => {
    expect(CODE).not.toMatch(/catch\s*\{\s*\}/);
  });
});

describe('учётных данных в коде нет', () => {
  it('песочница включается переменными, а не константами в исходнике', () => {
    // Сначала адрес, токен и тестовые идентификаторы песочницы стояли прямо в
    // коде. Работало, но CodeQL справедливо назвал это учётными данными в
    // исходнике. Глушить его было бы неправильно даже при опубликованном
    // тестовом токене: правило «секретов в коде нет» перестаёт работать в тот
    // день, когда у него появляется первое исключение.
    expect(CODE).toMatch(/process\.env\.TOCHKA_BASE_URL/);
    expect(CODE, 'адрес песочницы вернулся в код').not.toMatch(/sandbox\/v2/);
    expect(CODE, 'токен песочницы вернулся в код').not.toMatch(/sandbox\.jwt\.token/);
    // Тестовые идентификаторы — тоже данные для входа, пусть и общие.
    expect(CODE, 'тестовый merchantId вернулся в код').not.toMatch(/200000000001097/);
  });

  it('боевой адрес остался прежним и служит умолчанием', () => {
    // Ищем адрес ЦЕЛИКОМ, со схемой и кавычками, а не подстроку хоста.
    // Голое `enter.tochka.com/uapi` — образец, которым проверяют URL «на
    // глазок»: он совпадает и в середине чужого адреса. Здесь это была бы
    // мелочь (мы ищем текст в исходнике, а не проверяем ссылку), но образец
    // с этим изъяном не должен лежать в репозитории даже как пример —
    // скопируют оттуда, где он опасен. CodeQL пометил справедливо.
    expect(CODE).toMatch(/const DEFAULT_BASE = 'https:\/\/enter\.tochka\.com\/uapi';/);
  });

  it('готовность и перечень нехватки — одна правда, а не две', () => {
    // Раньше это были два независимых списка переменных, и разойтись им ничто
    // не мешало: 503 мог сказать «не хватает», а перечень — «всё на месте».
    const fn = CODE.slice(CODE.indexOf('export function isTochkaConfigured'));
    expect(fn.slice(0, 200)).toMatch(/tochkaMissingEnv\(\)\.length === 0/);
  });
});

describe('в адрес запроса не попадает непроверенное', () => {
  it('qrcId из вебхука проверяется по форме до подстановки', () => {
    // qrcId уезжает плательщику вместе с QR-ссылкой, то есть приходит снаружи
    // и от кого угодно. encodeURIComponent уже не даёт сменить хост, но
    // полагаться на экранирование там, где годится белый список, незачем.
    expect(CODE).toMatch(/SAFE_QR_ID = \/\^\[A-Za-z0-9_-\]/);
    const fn = CODE.slice(CODE.indexOf('export async function getSBPPaymentStatus'));
    const check = fn.indexOf('SAFE_QR_ID.test(qrId)');
    const build = fn.indexOf('const path =');
    expect(check).toBeGreaterThan(-1);
    expect(check, 'проверка стоит ПОСЛЕ сборки адреса').toBeLessThan(build);
  });

  it('счёт и merchantId тоже проверяются', () => {
    // Опечатка в переменной окружения — та же подстановка чужого текста в
    // адрес, только сделанная своими руками.
    expect(CODE).toMatch(/SAFE_ACCOUNT/);
    expect(CODE).toMatch(/SAFE_MERCHANT/);
    const fn = CODE.slice(CODE.indexOf('export async function createSBPQR'));
    const check = fn.indexOf('SAFE_MERCHANT.test(merchant)');
    const build = fn.indexOf('const path =');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(build);
  });
});

describe('реквизиты не утекают в лог', () => {
  it('путь в логе идёт через safePath', () => {
    // В пути выпуска QR лежит номер банковского счёта с БИК. Логи читают люди
    // и машины, попадают они и в чужие руки.
    const logs = CODE.match(/console\.error\(`\[tochka\] \$\{method\}[^`]*`/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line, `в логе голый путь: ${line}`).toMatch(/safePath\(path\)/);
    }
  });

  it('safePath прячет и merchantId, и счёт', () => {
    // Две замены: сначала merchantId, следом счёт, который идёт за ним.
    const body = CODE.slice(CODE.indexOf('function safePath')).slice(0, 600);
    // Ровно два скрытых значения на выходе: merchantId и счёт.
    expect((body.match(/'[^']*\[скрыто\]'/g) ?? []).length).toBe(2);
  });
});
