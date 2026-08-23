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
    const fn = CODE.slice(CODE.indexOf('export function isTochkaConfigured'));
    const body = fn.slice(0, fn.indexOf('export function tochkaMissingEnv'));
    expect(body).toMatch(/TOCHKA_JWT_TOKEN/);
    expect(body).toMatch(/TOCHKA_MERCHANT_ID/);
    expect(body).toMatch(/TOCHKA_ACCOUNT_ID/);
    expect(body).not.toMatch(/TOCHKA_CLIENT_ID/);
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
    expect(CODE).toMatch(/console\.error\(`\[tochka\] \$\{method\} \$\{path\} → \$\{res\.status\}: \$\{err\}`\)/);
  });

  it('пустого catch нет', () => {
    expect(CODE).not.toMatch(/catch\s*\{\s*\}/);
  });
});

describe('песочница отделена от боевого контура', () => {
  it('переключается переменной, а не правкой кода', () => {
    expect(CODE).toMatch(/TOCHKA_SANDBOX === '1'/);
    expect(CODE).toMatch(/enter\.tochka\.com\/sandbox\/v2/);
  });

  it('боевой адрес остался прежним', () => {
    expect(CODE).toMatch(/enter\.tochka\.com\/uapi/);
  });
});
