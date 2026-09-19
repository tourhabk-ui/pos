/**
 * Рукопожатие MCP: отвечаем на тот вопрос, который задали.
 *
 * ── Случай 19.09 ───────────────────────────────────────────────────────────
 *
 * Glama прислала письмо: почасовая проверка коннектора «Ведар — Камчатка» не
 * проходит, «Error connecting to MCP», и в каталоге он помечен неработающим —
 * то есть стоит ниже живых коннекторов. При этом сервер ЖИВ: вызов
 * `safety_status` с машины агента ответил за секунду.
 *
 * Расхождение — в транспорте. Клиент Streamable HTTP после рукопожатия
 * открывает GET с `Accept: text/event-stream` и ждёт либо поток, либо
 * `405 Method Not Allowed`: второе он читает как «сервер потоком не умеет,
 * работаем без него». Мы отвечали `200 application/json` — карточкой сервера
 * и списком инструментов. Снисходительный клиент это прощал, строгий обрывал
 * соединение.
 *
 * Оговорка, которая должна пережить этот тест: проверку Glama воспроизвести
 * из песочницы нечем — прокси наружу не пускает. Причина названа по
 * спецификации, а не замером. Но прежнее поведение спецификации
 * противоречило в любом случае, и это чинится независимо от того, та ли это
 * причина.
 *
 * ── Почему разбор заголовка, а не поиск подстроки ──────────────────────────
 *
 * Клиент шлёт `application/json, text/event-stream` — обе строки сразу.
 * Условие «содержит text/event-stream» отправило бы в 405 того, кто согласен
 * и на JSON, то есть сломало бы рабочий путь ради починки сломанного.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wantsEventStream } from '@/app/api/mcp/route';

const SRC = readFileSync(join(process.cwd(), 'app/api/mcp/route.ts'), 'utf-8');

describe('кто просит поток событий', () => {
  it('поток запрошен, когда другого клиент не принимает', () => {
    expect(wantsEventStream('text/event-stream')).toBe(true);
    expect(wantsEventStream('TEXT/EVENT-STREAM')).toBe(true);
    expect(wantsEventStream(' text/event-stream ;q=0.9 ')).toBe(true);
  });

  it('согласен и на JSON — значит поток НЕ запрошен', () => {
    // Ровно строка официального клиента Streamable HTTP.
    expect(wantsEventStream('application/json, text/event-stream')).toBe(false);
    expect(wantsEventStream('text/event-stream, application/json')).toBe(false);
  });

  it('обычные запросы потоком не считаются', () => {
    expect(wantsEventStream(null)).toBe(false);
    expect(wantsEventStream('')).toBe(false);
    expect(wantsEventStream('*/*')).toBe(false);
    expect(wantsEventStream('application/json')).toBe(false);
    expect(wantsEventStream('text/html,application/xhtml+xml')).toBe(false);
  });
});

describe('GET отвечает по спецификации', () => {
  const get = SRC.slice(SRC.indexOf('export async function GET('), SRC.indexOf('export async function OPTIONS('));

  it('на запрос потока — 405, а не 200 с JSON', () => {
    expect(get).toContain('wantsEventStream(request.headers.get(\'accept\'))');
    expect(get).toContain('status: 405');
    expect(get).toContain("Allow: 'POST'");
  });

  it('405 идёт с пустым телом', () => {
    // JSON здесь снова стал бы ответом не на тот вопрос.
    expect(get).toMatch(/new NextResponse\(null, \{ status: 405/);
  });

  it('обычный GET по-прежнему отдаёт карточку сервера и инструменты', () => {
    expect(get).toContain('MCP_SERVER_INFO');
    expect(get).toContain('PUBLIC_MCP_TOOLS');
  });
});

describe('предполёт не читается как «сервера нет»', () => {
  it('OPTIONS отвечает 204 и называет методы', () => {
    const opt = SRC.slice(SRC.indexOf('export async function OPTIONS('));
    expect(opt).toContain('status: 204');
    expect(opt).toContain("Allow: 'GET, POST, OPTIONS'");
    expect(opt).toContain('Access-Control-Allow-Methods');
  });
});

describe('живое рядом не задето', () => {
  it('уведомление об инициализации по-прежнему пустое 202', () => {
    // Чинили 17.09: раньше уходил ответ с id: null — ответ на вопрос,
    // которого клиент не задавал.
    expect(SRC).toContain("case 'notifications/initialized':");
    expect(SRC).toMatch(/return new NextResponse\(null, \{ status: 202 \}\)/);
  });

  it('рукопожатие, список и вызов инструментов на месте', () => {
    for (const m of ['initialize', 'tools/list', 'tools/call', 'ping']) {
      expect(SRC, m).toContain(`case '${m}'`);
    }
  });

  it('сервер остаётся публичным: авторизации на нём нет', () => {
    // Glama ходит анонимно, и так и задумано (middleware пропускает /api/mcp).
    expect(SRC).not.toMatch(/requireAuth|requireAdmin/);
  });
});
