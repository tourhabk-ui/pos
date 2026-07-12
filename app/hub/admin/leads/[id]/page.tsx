import { redirect } from 'next/navigation';

/**
 * Редирект для ссылок «Открыть в CRM» из уже отправленных
 * Telegram-уведомлений о лидах: до июля 2026 они указывали на
 * /hub/admin/leads/[id], которого не существовало (404).
 * Детальная страница лида — /hub/operator/leads/[id].
 */
export default async function AdminLeadRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/hub/operator/leads/${id}`);
}
