/**
 * Укрепление записи MCP по аудиту владельца 08.08 (замечания 2 и 3):
 *   2. телефон принимался любой строкой ≥5 символов — «привет» прошёл бы
 *      как номер; теперь нормализация: мусор → отказ с внятной ошибкой;
 *   3. общий дедуп createLead требует ТОЧНОГО совпадения комментария —
 *      агент при ретрае переформулирует, и заявка задвоится; теперь явная
 *      идемпотентность по (телефон, тур, дата) через детерминированный
 *      префикс комментария.
 * Замечание 4 (лишний .mcp.json в корне — конфиг КЛИЕНТА, заехал случайно
 * в #952) — файл удалён из репо.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePhone } from '@/lib/mcp/normalize-phone';

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/api/mcp/route.ts'), 'utf-8');

describe('normalizePhone: мягкая E.164, не строго-РФ', () => {
  it('форматы РФ приводятся к +7', () => {
    expect(normalizePhone('+7 (999) 299-70-07')).toBe('+79992997007');
    expect(normalizePhone('8 914 782-22-22')).toBe('+79147822222');
    expect(normalizePhone('79147822222')).toBe('+79147822222');
  });

  it('иностранный номер проходит как есть с плюсом', () => {
    expect(normalizePhone('+49 151 12345678')).toBe('+4915112345678');
  });

  it('мусор и обрубки не проходят', () => {
    expect(normalizePhone('привет')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('1'.repeat(16))).toBeNull();
  });
});

describe('оба пишущих инструмента нормализуют телефон до создания лида', () => {
  it('create_lead и create_booking_request зовут normalizePhone', () => {
    expect(ROUTE.match(/normalizePhone\(parsed\.data\.phone\)/g)?.length).toBe(2);
    expect(ROUTE).toMatch(/Телефон не похож на номер/);
  });
});

describe('идемпотентность заявки на бронь: (телефон, тур, дата)', () => {
  const LEADS = readFileSync(join(ROOT, 'lib/leads/create.ts'), 'utf-8');

  it('роут спрашивает домен лидов по детерминированному префиксу — своего SQL у MCP нет', () => {
    expect(ROUTE).toMatch(/findRecentLeadByCommentPrefix\(phone, bookingPrefix\)/);
    expect(ROUTE).toMatch(/— новую не создаю/);
  });

  it('дедуп в домене лидов: окно 24ч, спецсимволы LIKE экранируются', () => {
    expect(LEADS).toMatch(/comment LIKE \$2 \|\| '%'/);
    expect(LEADS).toMatch(/\.replace\(\/\[\\\\%_\]\/g/);
  });
});

describe('замечание 4: манифест НАШЕГО сервера один — /.well-known/mcp.json', () => {
  /**
   * Прежняя редакция запрещала `.mcp.json` целиком. Причина, записанная в её
   * же заголовке, — «манифест сервера один», то есть внешние клиенты должны
   * узнавать о НАШЕМ MCP-сервере в одном месте, а не в двух расходящихся.
   *
   * 19.09 владелец завёл `.mcp.json` под Inspo, и оказалось, что запрет шире
   * своей причины: это конфиг ПОТРЕБЛЯЕМЫХ серверов (какие MCP наш агент
   * зовёт), а не второй манифест нашего. Две разные вещи с похожим именем.
   * Поэтому сторож теперь держит саму причину: что бы ни лежало в `.mcp.json`,
   * второго описания нашего сервера там быть не должно.
   *
   * Запрет шире причины опасен ровно тем, чем оказался здесь: он молча
   * блокирует работу, к которой причина не имеет отношения, и выглядит при
   * этом обоснованным.
   */
  it('.mcp.json — только конфиг потребляемых серверов, не второй манифест нашего', () => {
    const path = join(ROOT, '.mcp.json');
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf-8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    // Ключи манифеста сервера (имя, версия, список инструментов) — признак
    // того, что файл снова описывает НАС, а не то, что мы зовём.
    for (const key of ['tools', 'name', 'version', 'protocolVersion', 'capabilities']) {
      expect(cfg[key] ?? null, `.mcp.json несёт ключ манифеста «${key}» — это второе описание нашего сервера`).toBeNull();
    }
    expect(Object.keys(cfg), '.mcp.json должен содержать только mcpServers').toEqual(['mcpServers']);
    // Секретам здесь не место: файл отслеживается и виден всем, у кого есть
    // репозиторий (§4 — ключи только в .env.local и переменных Timeweb).
    expect(raw, '.mcp.json не должен нести ключи и токены').not.toMatch(/sk-[a-z-]*[0-9a-zA-Z]{12,}|Bearer\s+\S|_API_KEY"\s*:\s*"[^"$]/);
  });
});
