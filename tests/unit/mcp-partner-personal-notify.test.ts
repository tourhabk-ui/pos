/**
 * MCP-заявка на бронь тура — лично оператору, а не только в рабочий чат.
 *
 * До фикса create_booking_request с расписанием звал только createLead
 * (уведомление в общий чат платформы): заявка из внешнего ИИ ложилась
 * оператору в кабинет молча, и пилотный оператор узнавал о ней, только
 * зайдя сам (crm-status 18.10, «нет» №1). Веб-форма той же заявки зовёт
 * notifyPartnerNewLeadPersonally + recordPartnerDelivery с 13.10/15.10 —
 * здесь держится, что MCP-путь делает то же той же механикой, а не своей.
 *
 * Сторож по исходнику, как у соседей (mcp-booking, lead-personal-to-operator):
 * исполнение роута целиком требует БД и мессенджеров, а контракт —
 * «вызов есть, стоит после записи, повтор и self не будят» — виден в тексте.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/mcp/route.ts'), 'utf-8');

describe('MCP create_booking_request — личная доставка оператору', () => {
  it('переиспользует механику веб-формы, а не свою отправку', () => {
    expect(ROUTE).toMatch(/import \{ notifyPartnerNewLeadPersonally \} from '@\/lib\/notifications\/lead-notify'/);
    expect(ROUTE).toMatch(/import \{ recordPartnerDelivery \} from '@\/lib\/leads\/delivery-outcome'/);
    expect(ROUTE).toMatch(/notifyPartnerNewLeadPersonally\(\{\s*\.\.\.params,\s*origin: 'заявка через ИИ-ассистента \(MCP\)'/);
    expect(ROUTE).toMatch(/recordPartnerDelivery\(params\.leadId, params\.operatorId, outcome\)/);
  });

  it('вызывается только для новой заявки известному оператору и не для self', () => {
    expect(ROUTE).toMatch(/if \(!existing && !ctx\.self && tour\.operator_id\) \{/);
    const call = ROUTE.indexOf('notifyPartnerPersonallyAboutMcpLead({');
    expect(call).toBeGreaterThan(ROUTE.indexOf('const leadId = existing ?? await createLead({'));
    expect(call).toBeLessThan(ROUTE.indexOf('return accepted + keyLine'));
    const block = ROUTE.slice(call, ROUTE.indexOf('return accepted + keyLine'));
    expect(block).toMatch(/operatorId: tour\.operator_id/);
    expect(block).toMatch(/routeTitle: tour\.title/);
  });

  it('ответ агенту уведомления не ждёт, отказ не глушится пустым catch', () => {
    const fn = ROUTE.slice(ROUTE.indexOf('function notifyPartnerPersonallyAboutMcpLead'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/void \(async \(\) => \{/);
    expect(body).not.toMatch(/catch\(\(\) => (undefined|null)\)/);
    expect(body).toMatch(/console\.error\(`\[mcp\] личное уведомление оператора о заявке/);
  });

  it('остальные пишущие пути не будят оператора второй копией', () => {
    // create_stay_request доставляется хозяину внутри submitStayRequest,
    // запрос мест без расписания — внутри createSeatRequest, create_lead
    // оператора не адресует вовсе. Второй вызов отсюда — двойное уведомление.
    expect(ROUTE.match(/notifyPartnerPersonallyAboutMcpLead\(\{/g)).toHaveLength(1);
  });
});
