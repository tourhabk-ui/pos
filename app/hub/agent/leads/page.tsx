import { redirect } from 'next/navigation';

/**
 * Заявки платформы агентам закрыты (26.09): это персональные данные туристов,
 * а роль агента выдаётся самостоятельной регистрацией (agent-leads-closed).
 * Старые ссылки ведут в «Клиенты» — там агент ведёт своих клиентов.
 */
export default function AgentLeadsPage() {
  redirect('/hub/agent/clients');
}
