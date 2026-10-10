'use client';

/**
 * «Задачи» — экран CRM кабинета партнёра (CRM 1в, #2325). Что сделать и к
 * какому сроку: просроченные сверху, потом сегодня, завтра, позже. Задача о
 * клиенте открывает его карточку — там же лента, куда ляжет отметка
 * «Задача выполнена».
 */
import { useState } from 'react';
import { ListChecks } from 'lucide-react';
import { ContactPanel } from './ContactPanel';
import { TaskList } from './TaskList';
import { AgentKeysPanel } from './AgentKeysPanel';

export function TasksScreen() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <ListChecks className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Задачи</h1>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Задача о клиенте — с его именем: выполнение попадёт в ленту клиента. Без клиента — общее дело кабинета.
      </p>

      <TaskList onOpenContact={setOpenId} reloadKey={reloadKey} />

      {/* Ключи MCP партнёра (1д-2): «Задачи» — единственный экран CRM во всех шести кабинетах. */}
      <AgentKeysPanel />

      {openId && (
        <ContactPanel
          contactId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => setReloadKey((n) => n + 1)}
        />
      )}
    </div>
  );
}
