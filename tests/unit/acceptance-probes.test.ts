/**
 * Инструменты приёмки перф-цепочки (владелец 08.08: список приёмки после
 * мержа — get_tours без блоба, EXPLAIN занятости на индексе, живые URL).
 *
 * Из песочницы прод недоступен; «глаза» — probe-url. Для приёмки добавлены:
 *   - POST-пробы в workflow (tools/call MCP GET-ом не проверить);
 *   - EXPLAIN-эндпоинт занятости под CRON_SECRET (боевой SQL, не похожий).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF = readFileSync(join(ROOT, '.github/workflows/probe-url.yml'), 'utf-8');
const EXPLAIN = readFileSync(join(ROOT, 'app/api/cron/explain-availability/route.ts'), 'utf-8');
const PLANNER = readFileSync(join(ROOT, 'lib/planner/data.ts'), 'utf-8');

describe('probe-url: POST-пробы', () => {
  /**
   * Сторож судит СВОЙСТВО, а не написание.
   *
   * Прежде здесь требовалось РОВНО ДВА блока `case "$PURL" in` — по одному на
   * GET и POST. Когда 22.08 обе одинаковые ветки схлопнулись в общую функцию
   * запроса, свойство стало СТРОЖЕ (решение о секрете принимается в одном
   * месте на оба метода), а сторож покраснел — он считал копии, а не смысл.
   *
   * Проверяемое свойство: каждое появление заголовка с секретом стоит внутри
   * ветки, отобранной по адресу `https://vedarai.ru/api/cron/*`. Сколько таких
   * веток — одна или пять — правилу безразлично.
   */
  it('секрет уходит ТОЛЬКО своим крон-роутам — на всяком пути, GET и POST', () => {
    const lines = WF.split('\n');
    const bearer = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /Authorization: Bearer/.test(l));

    expect(bearer.length, 'заголовок с секретом исчез из пробы — секрет никуда не уходит?').toBeGreaterThan(0);

    for (const { l, i } of bearer) {
      // Отбор по адресу стоит либо на самой строке (`case`-arm с командой в
      // одну строку), либо чуть выше — берём окно, включающее саму строку.
      const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
      expect(
        window,
        `строка ${i + 1} шлёт CRON_SECRET, но выше нет отбора по адресу крон-роутов: ${l.trim()}`,
      ).toMatch(/https:\/\/vedarai\.ru\/api\/cron\/\*\)/);
    }
  });

  it('адрес секрета сузился до крон-роутов: домен целиком больше не адресат', () => {
    // Публичные роуты нашего же домена от чужого Bearer получали 401 от
    // Edge-middleware — проба публичного JSON была невозможна (09.08). Заодно
    // это строго уже прежнего правила: мест, куда уходит секрет, стало меньше.
    expect(WF).not.toMatch(/https:\/\/vedarai\.ru\/\*\)/);
    expect(WF).toMatch(/https:\/\/vedarai\.ru\/api\/cron\/\*\)/);
  });

  it('POST ждёт выката тем же правилом, что GET — петля ожидания одна на всех', () => {
    // Проба 99 сняла 404 у ещё не собравшегося роута и отчиталась успехом:
    // повтор и маркер свежести жили только в GET-ветке, POST бил один раз.
    // Две петли ожидания — это два правила, и одно из них снова отстанет.
    expect(WF.match(/while : ; do/g) ?? [], 'петля ожидания выката должна быть одна на оба метода').toHaveLength(1);
    expect(WF).toMatch(/ПРОБА НЕ УДАЛАСЬ/);
  });

  it('тело — из файла триггера, без shell-интерполяции JSON', () => {
    expect(WF).toMatch(/--data-binary @\/tmp\/postbody\.json/);
  });
});

describe('explain-availability: приёмка индексов 843', () => {
  it('под секретом и read-only: только EXPLAIN SELECT, никаких мутаций', () => {
    expect(EXPLAIN).toMatch(/verifyCronSecret/);
    expect(EXPLAIN).toMatch(/EXPLAIN \(ANALYZE, BUFFERS\)/);
    expect(EXPLAIN).not.toMatch(/INSERT|UPDATE|DELETE|DROP|CREATE/);
  });

  it('меряется боевой запрос: LATERAL и фильтры дословно из планера', () => {
    for (const frag of [
      'CROSS JOIN LATERAL',
      "booking_status NOT IN ('cancelled', 'rejected')",
      'ta.is_cancelled = FALSE',
    ]) {
      expect(EXPLAIN).toContain(frag);
      expect(PLANNER).toContain(frag);
    }
  });

  it('флаги приёмки называют индексы 843 поимённо', () => {
    expect(EXPLAIN).toContain('idx_tour_availability_tour_date');
    expect(EXPLAIN).toContain('idx_operator_bookings_tour_date_active');
    expect(EXPLAIN).toMatch(/has_seq_scan_on_bookings/);
  });

  it('вход валидируется: tour — только цифры, окно клампится', () => {
    expect(EXPLAIN).toMatch(/\^\\d\{1,10\}\$/);
    expect(EXPLAIN).toMatch(/Math\.min\(Math\.max\(daysRaw, 1\), 31\)/);
  });
});

/**
 * Отказ соединения — это «не смог снять», а не «снял пустоту» (проба 447).
 *
 * Разбор Trip.com 06.09: у одного из четырёх адресов не было соединения
 * вовсе, и проба напечатала под ним 140 588 байт ПРЕДЫДУЩЕГО URL вместе с
 * его маркерами. Читалось это как «хост ответил, supplier там не нашли» —
 * то есть вывод о чужом сайте строился на теле другой страницы.
 *
 * Механизм был двойной, и каждая половина по отдельности выглядела мелочью:
 *   - curl с -o не создаёт файл, если не начал получать ответ, а прежний
 *     /tmp/body никто не обнулял между запросами;
 *   - `|| echo 000` внутри командной подстановки дописывало вторые три нуля
 *     к тем, что curl уже напечатал через -w, и «000000» не совпадало с
 *     веткой распознавания отказа — ни повтора, ни красной пробы.
 *
 * Тот же §4.0, что и в коде платформы: у проверки обязан быть третий исход,
 * и он не равен первому.
 */
describe('probe-url: отказ соединения не выдаётся за ответ', () => {
  it('тело и заголовки обнуляются ПЕРЕД запросом', () => {
    const req = WF.slice(WF.indexOf('do_request() {'), WF.indexOf('fetch_waiting() {'));
    expect(req, 'нет обнуления /tmp/body — маркеры посчитаются по прошлому URL').toMatch(/:\s*>\s*\/tmp\/body/);
    expect(req, 'нет обнуления /tmp/headers').toMatch(/:\s*>\s*\/tmp\/headers/);
    // Обнуление обязано стоять ДО curl, иначе оно стирает свежий ответ.
    expect(req.indexOf(': > /tmp/body')).toBeLessThan(req.indexOf('CODE=$(curl'));
  });

  it('код ответа не склеивается в «000000» — распознавание отказа работает', () => {
    const req = WF.slice(WF.indexOf('do_request() {'), WF.indexOf('fetch_waiting() {'));
    expect(req, '`|| echo 000` внутри $( ) дописывает вторые нули к тем, что печатает -w')
      .not.toMatch(/\|\|\s*echo\s*000\s*\)/);
    // Нормализация: всё, что не трёхзначное число, становится ровно «000» —
    // именно той строкой, которую ищет ветка повтора и остановки.
    expect(req).toMatch(/CODE=000/);
  });

  it('ветка повтора по-прежнему знает про 000 — иначе нормализация некому нужна', () => {
    expect(WF).toMatch(/404\|502\|503\|000\)/);
  });

  it('пустой ответ называется вслух, а маркеры по нему не считаются', () => {
    const rep = WF.slice(WF.indexOf('report_body() {'), WF.indexOf('# Маркер свежести проверяется ТОЛЬКО'));
    expect(rep).toContain('НЕ СМОГ СНЯТЬ');
    // Ранний выход стоит до разбора маркеров: иначе «НЕТ: supplier» по
    // пустому телу читается как факт о чужом сайте.
    expect(rep.indexOf('НЕ СМОГ СНЯТЬ')).toBeLessThan(rep.indexOf('── маркеры ──'));
  });
});
