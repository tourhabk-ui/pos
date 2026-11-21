/**
 * Обязательные поля заявок MCP — одной строкой для /llms.txt (21.11).
 *
 * Панель владельца 21.11: 297 отказов на входе за 30 дней — нет телефона, нет
 * согласия, пустая заявка. Агенты, которые читают /llms.txt раньше tools/list,
 * видели список заявок без обязательных полей и без правила «имя, телефон и
 * согласие — от человека». Строка собирается из `required` самих схем
 * (PUBLIC_MCP_TOOLS), а не пишется руками: список, написанный дважды, разойдётся
 * со схемой (§12 CLAUDE.md).
 *
 * Сторож: tests/unit/mcp-write-tool-requirements.test.ts.
 */
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES, CHANGE_TOOL_NAMES } from '@/lib/mcp/public-tools';

/** Инструмент и его обязательные поля, в порядке реестра. */
export function writeToolRequirements(): Array<{ tool: string; required: string[] }> {
  return PUBLIC_MCP_TOOLS
    .filter((t) => WRITE_TOOL_NAMES.has(t.name) || CHANGE_TOOL_NAMES.has(t.name))
    .map((t) => ({ tool: t.name, required: [...(((t.inputSchema as { required?: string[] }).required) ?? [])] }));
}

const list = (): string => writeToolRequirements().map((r) => `${r.tool} (${r.required.join(', ')})`).join('; ');

export function writeToolRequirementsRu(): string {
  return `Обязательные поля заявок MCP: ${list()}. Имя, телефон и согласие (consent: true) агент берёт только у человека: спросите их до вызова и не придумывайте; без согласия заявка не создаётся. Отказ по входу называет все поля разом и строку «Missing: …» — спросите человека и повторите вызов.`;
}

export function writeToolRequirementsEn(): string {
  return `Required fields of MCP request tools: ${list()}. Name, phone and consent (consent: true) come only from the person: ask before calling and never invent them; without consent no request is created. An input refusal lists every field at once with a "Missing: …" line — ask the person and call again.`;
}
