// @vitest-environment node
/**
 * Проба сетевого пути прод → Anthropic (03.09).
 *
 * Сторож держит: адрес шлюза собирается из проверенных частей, а не из
 * строки запроса (проба с секретом прода не должна становиться прокси на
 * что угодно); три исхода на путь — «дошли», «не пустили», «не смог» — и
 * 401 считается ОТКРЫТЫМ путём, потому что до Anthropic дошли; секрет
 * только заголовком; роут зовётся workflow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayBase, classify, OPEN_OUTCOMES } from '@/app/api/cron/anthropic-path-probe/route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = read('app/api/cron/anthropic-path-probe/route.ts');
const WF = read('.github/workflows/anthropic-path-probe.yml');

const ACC = '0123456789abcdef0123456789abcdef';

describe('адрес шлюза — из проверенных частей', () => {
  it('32 hex + известное имя → адрес на литеральном хосте', () => {
    expect(gatewayBase(ACC, 'vedar-ai')).toBe(`https://gateway.ai.cloudflare.com/v1/${ACC}/vedar-ai/anthropic`);
  });

  it('чужой хост, лишние символы, неизвестный шлюз — null', () => {
    expect(gatewayBase('evil.example.com/../', 'vedar-ai')).toBeNull();
    expect(gatewayBase(ACC.slice(0, 31), 'vedar-ai')).toBeNull();
    expect(gatewayBase(ACC + '/x', 'vedar-ai')).toBeNull();
    expect(gatewayBase(ACC, 'other')).toBeNull();
    expect(gatewayBase(ACC, '__proto__')).toBeNull();
    expect(gatewayBase(null, 'vedar-ai')).toBeNull();
  });

  it('строка запроса в адрес не попадает — только пересобранное значение', () => {
    expect(ROUTE).toMatch(/BigInt\(`0x\$\{accountRaw\}`\)/);
    expect(ROUTE).not.toMatch(/searchParams\.get\('base'\)/);
  });
});

describe('три исхода на путь', () => {
  it('200 — открыт; 401 — открыт без ключа; 403 — заблокирован; прочее — http', () => {
    expect(classify(200, '')).toBe('open');
    expect(classify(401, '{"type":"error","error":{"type":"authentication_error"}}')).toBe('open_no_key');
    expect(classify(403, 'Request not allowed')).toBe('blocked');
    expect(classify(500, '')).toBe('http');
  });

  it('400 с ответом формы Anthropic — дошли, ключ отвергнут (run 1: пустой баланс)', () => {
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}';
    expect(classify(400, body)).toBe('open_key_refused');
    expect(OPEN_OUTCOMES.has('open_key_refused')).toBe(true);
    // Чужой 400 без формы Anthropic (прокси, блокировщик) — не «дошли».
    expect(classify(400, '<html>Bad Request</html>')).toBe('http');
  });

  it('сетевой отказ — «не смог», а не «заблокирован»; без ключа проба всё равно идёт', () => {
    expect(ROUTE).toMatch(/outcome: 'unreachable'/);
    expect(ROUTE).toMatch(/'x-api-key': apiKey \?\? 'absent'/);
    // Все «не смог» → path_exists null, не false.
    expect(ROUTE).toMatch(/path_exists: open\.length > 0 \? true : results\.every/);
    expect(ROUTE).toMatch(/OPEN_OUTCOMES\.has\(r\.outcome\)/);
    // Workflow: с раннера 4xx формы Anthropic — предупреждение, не провал.
    expect(WF).toMatch(/grep -q '"type":"error"' \/tmp\/runner\.json/);
  });
});

describe('периметр и запуск', () => {
  it('секрет — заголовком, сравнение постоянного времени', () => {
    expect(ROUTE).toMatch(/getCronSecret\(request\)/);
    expect(ROUTE).toMatch(/timingSafeCompare/);
    expect(WF).toMatch(/Authorization: Bearer \$CRON_SECRET/);
    expect(WF).not.toMatch(/\?secret=/);
  });

  it('workflow зовёт роут частями адреса и краснеет, когда ни один путь не открыт', () => {
    expect(WF).toMatch(/\/api\/cron\/anthropic-path-probe/);
    expect(WF).toMatch(/--data-urlencode "account=\$ACCOUNT" --data-urlencode "gateway=\$GW"/);
    expect(WF).toMatch(/AI Gateway гео-блок не обходит/);
    // Раннер не в РФ: его успех — контроль шлюза, а не ответ про гео-путь.
    expect(WF).toMatch(/контроль самого шлюза/);
  });

  it('ключи и аккаунт наружу не печатаются', () => {
    expect(WF).toMatch(/add-mask::\$ACCOUNT/);
    expect(WF).not.toMatch(/echo .*\$ANTHROPIC_API_KEY/);
    expect(WF).not.toMatch(/echo .*\$CLOUDFLARE_API_TOKEN/);
  });
});
