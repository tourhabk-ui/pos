/**
 * Сторож: у каждого инструмента CRM три поверхности, и все три — одна
 * функция (CRM #2325, план фазы 1, сторож `crm-three-surfaces`).
 *
 * Партнёр делает одно и то же тремя путями: в кабинете, в чате Кузьмича,
 * своим агентом по ключу MCP. Если путь обзаводится своей копией запроса,
 * копии расходятся на первой же правке — и «Кузьмич сказал, что задача
 * заведена», а на экране её нет. Поэтому держится связка целиком:
 *  - у каждого инструмента есть роут кабинета, и он зовёт ту же функцию из
 *    того же модуля, что инструмент (`lib/crm/tools.ts`);
 *  - новый инструмент без роута-двойника — красный (карта ниже обязана
 *    совпадать со списком инструментов);
 *  - чат партнёра и MCP партнёра берут инструменты одним вызовом
 *    `crmToolDefinitions` и исполняют одним `executeCrmTool` — своего
 *    списка и своего исполнителя у поверхности нет.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
const { CRM_TOOL_NAMES, CRM_WRITE_TOOL_NAMES, crmWriteSummary } = await import('@/lib/crm/tools');

const read = (p: string) => readFileSync(p, 'utf8');

/** Инструмент → роут кабинета, функция данных и модуль, откуда её берут оба. */
const REST_TWIN: Readonly<Record<string, { route: string; fn: string; module: string }>> = {
  crm_inbox: { route: 'app/api/hub/crm/inbox/route.ts', fn: 'loadInbox', module: '@/lib/crm/inbox' },
  crm_find_contact: { route: 'app/api/hub/crm/contacts/route.ts', fn: 'listContacts', module: '@/lib/crm/contact-queries' },
  crm_contact_card: { route: 'app/api/hub/crm/contacts/[id]/route.ts', fn: 'getContactCard', module: '@/lib/crm/contact-queries' },
  crm_tasks: { route: 'app/api/hub/crm/tasks/route.ts', fn: 'listTasks', module: '@/lib/crm/tasks' },
  crm_add_touch: { route: 'app/api/hub/crm/contacts/[id]/events/route.ts', fn: 'addContactTouch', module: '@/lib/crm/events' },
  crm_add_task: { route: 'app/api/hub/crm/tasks/route.ts', fn: 'createTask', module: '@/lib/crm/tasks' },
  crm_complete_task: { route: 'app/api/hub/crm/tasks/[id]/route.ts', fn: 'completeTask', module: '@/lib/crm/tasks' },
};

function importsFrom(src: string, fn: string, module: string): boolean {
  return [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)]
    .some(([, names, from]) => from === module && names.split(',').map((n) => n.trim()).includes(fn));
}

describe('инструменты CRM — три поверхности, одна функция', () => {
  it('у каждого инструмента есть двойник в кабинете, и лишних двойников нет', () => {
    expect([...CRM_TOOL_NAMES].sort()).toEqual(Object.keys(REST_TWIN).sort());
  });

  const tools = read('lib/crm/tools.ts');
  for (const [name, twin] of Object.entries(REST_TWIN)) {
    it(`${name}: кабинет и инструмент зовут ${twin.fn} из ${twin.module}`, () => {
      expect(existsSync(twin.route), twin.route).toBe(true);
      const route = read(twin.route);
      expect(importsFrom(route, twin.fn, twin.module), `${twin.route} не берёт ${twin.fn}`).toBe(true);
      expect(route).toMatch(new RegExp(`\\b${twin.fn}\\(`));
      expect(importsFrom(tools, twin.fn, twin.module), `lib/crm/tools.ts не берёт ${twin.fn}`).toBe(true);
      expect(tools).toMatch(new RegExp(`\\b${twin.fn}\\(`));
    });
  }

  it('кабинетный двойник пускает через requirePartner — как и прочие роуты CRM', () => {
    for (const twin of Object.values(REST_TWIN)) {
      expect(read(twin.route), twin.route).toMatch(/await requirePartner\(req\)/);
    }
  });

  for (const [surface, file] of [
    ['чат Кузьмича партнёра', 'lib/kuzmich/operator-chat.ts'],
    ['MCP партнёра', 'lib/mcp/partner-server.ts'],
  ] as const) {
    it(`${surface}: инструменты — crmToolDefinitions, исполнение — executeCrmTool`, () => {
      const src = read(file);
      expect(importsFrom(src, 'crmToolDefinitions', '@/lib/crm/tools')).toBe(true);
      expect(importsFrom(src, 'executeCrmTool', '@/lib/crm/tools')).toBe(true);
      expect(src).toMatch(/crmToolDefinitions\(/);
      expect(src).toMatch(/executeCrmTool\(/);
      // Своего списка имён инструментов у поверхности нет.
      for (const name of CRM_TOOL_NAMES) expect(src, `${file}: ${name}`).not.toContain(`'${name}'`);
    });
  }

  it('у каждого пишущего инструмента есть свои слова «что записано» — партнёр узнает о записи, даже если модель не ответила', () => {
    for (const name of CRM_WRITE_TOOL_NAMES) {
      expect(crmWriteSummary(name, { title: 'Перезвонить', due: '2030-01-01' }), name).not.toBe(name);
    }
  });
});
