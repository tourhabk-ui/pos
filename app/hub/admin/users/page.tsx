'use client';

import React, { useState, useEffect } from 'react';
import {
  DataTable,
  Pagination,
  SearchBar,
  LoadingSpinner,
  EmptyState,
  Sensitive,
  Column
} from '@/components/admin/shared';
import { AdminUser } from '@/types/admin';
import { Users } from 'lucide-react';

export default function UsersManagement() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({});
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [roleErrors, setRoleErrors] = useState<Record<string, string>>({});
  const [roleNotices, setRoleNotices] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchUsers();
  }, [currentPage, search, roleFilter]);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ page: currentPage.toString(), limit: '20' });
      if (search) params.append('search', search);
      if (roleFilter) params.append('role', roleFilter);

      const response = await fetch(`/api/admin/users?${params}`);
      const result = await response.json();
      if (result.success) {
        // API отдаёт data.users (не data.data) — чтение неверного поля роняло
        // рендер (users=undefined → users.length → error boundary).
        setUsers(result.data?.users ?? []);
        setTotalPages(result.data?.pagination?.totalPages ?? 1);
      } else {
        setUsers([]);
      }
    } catch {
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency', currency: 'RUB', minimumFractionDigits: 0
    }).format(value);
  };

  const formatDate = (date: Date) => {
    const d = new Date(date);
    // Intl.format кидает RangeError на Invalid Date — не роняем всю страницу.
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      year: 'numeric', month: 'short', day: 'numeric'
    }).format(d);
  };

  const getRoleLabel = (role: string) => {
    const labels: Record<string, string> = {
      user: 'Пользователь', tourist: 'Турист', operator: 'Оператор', guide: 'Гид',
      transfer: 'Трансфер', agent: 'Агент', stay: 'Проживание', gear: 'Снаряжение',
      admin: 'Админ'
    };
    return labels[role] || role;
  };

  const ROLE_OPTIONS = ['user', 'tourist', 'operator', 'guide', 'transfer', 'agent', 'stay', 'gear', 'admin'];

  const saveRole = async (user: AdminUser) => {
    const newRole = roleDrafts[user.id] ?? user.role;
    if (newRole === user.role || savingUserId) return;
    setSavingUserId(user.id);
    setRoleErrors((prev) => ({ ...prev, [user.id]: '' }));
    setRoleNotices((prev) => ({ ...prev, [user.id]: '' }));
    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.success !== true) {
        setRoleErrors((prev) => ({
          ...prev,
          [user.id]: result?.error ?? `Не удалось сохранить роль (HTTP ${response.status})`,
        }));
        return;
      }
      const savedRole = result.data?.role ?? newRole;
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: savedRole } : u)));
      setRoleDrafts((prev) => {
        const next = { ...prev };
        delete next[user.id];
        return next;
      });
      setRoleNotices((prev) => ({
        ...prev,
        [user.id]: 'Роль сохранена. Пользователю нужно выйти и войти снова, чтобы новая роль вступила в силу.',
      }));
    } catch {
      setRoleErrors((prev) => ({ ...prev, [user.id]: 'Сеть недоступна — роль не сохранена' }));
    } finally {
      setSavingUserId(null);
    }
  };

  const columns: Column<AdminUser>[] = [
    {
      key: 'name',
      header: 'Пользователь',
      sortable: true,
      render: (user) => (
        <div>
          <Sensitive as="p" className="font-medium text-[var(--text-primary)] text-xs">{user.name}</Sensitive>
          <Sensitive as="p" className="text-[10px] text-[var(--text-muted)]">{user.email}</Sensitive>
        </div>
      )
    },
    {
      key: 'role',
      header: 'Роль',
      sortable: true,
      render: (user) => {
        const draft = roleDrafts[user.id] ?? user.role;
        const changed = draft !== user.role;
        const saving = savingUserId === user.id;
        return (
          <div className="flex flex-col gap-1.5 min-w-[190px]">
            <div className="flex items-center gap-1.5">
              <select
                aria-label={`Роль пользователя ${user.email}`}
                value={draft}
                disabled={saving}
                onChange={(e) => {
                  setRoleDrafts((prev) => ({ ...prev, [user.id]: e.target.value }));
                  setRoleErrors((prev) => ({ ...prev, [user.id]: '' }));
                  setRoleNotices((prev) => ({ ...prev, [user.id]: '' }));
                }}
                className="h-10 px-2 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50"
              >
                {!ROLE_OPTIONS.includes(user.role) && (
                  <option value={user.role}>{getRoleLabel(user.role)}</option>
                )}
                {ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>{getRoleLabel(role)}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void saveRole(user)}
                disabled={!changed || saving}
                className="h-10 px-3 text-xs font-medium bg-[var(--bg-hover)] text-[var(--text-primary)] border border-[var(--border)] rounded-md hover:border-[var(--accent)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {saving ? 'Сохраняю…' : 'Сохранить'}
              </button>
            </div>
            {roleErrors[user.id] && (
              <p role="alert" className="text-[11px] leading-snug text-[var(--danger)]">{roleErrors[user.id]}</p>
            )}
            {roleNotices[user.id] && (
              <p className="text-[11px] leading-snug text-[var(--success)]">{roleNotices[user.id]}</p>
            )}
          </div>
        );
      }
    },
    // Колонка «Статус» убрана: API/БД не хранят статус пользователя, бейдж
    // показывал бы всем ложное «inactive». Вернуть при появлении поля в users.
    {
      key: 'bookingsCount',
      header: 'Броней',
      sortable: true,
      render: (user) => <span className="text-[var(--text-primary)] text-xs font-mono">{user.bookingsCount}</span>
    },
    {
      key: 'totalSpent',
      header: 'Потрачено',
      sortable: true,
      render: (user) => <span className="text-[var(--text-primary)] text-xs font-mono font-medium">{formatCurrency(user.totalSpent)}</span>
    },
    {
      key: 'createdAt',
      header: 'Регистрация',
      sortable: true,
      render: (user) => <span className="text-[var(--text-muted)] text-xs font-mono">{formatDate(user.createdAt)}</span>
    }
  ];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <Users className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Пользователи</h1>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex-1">
          <SearchBar placeholder="Поиск по имени или email..." onSearch={(q) => { setSearch(q); setCurrentPage(1); }} />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); setCurrentPage(1); }}
          className="px-3 py-1.5 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="">Все роли</option>
          <option value="tourist">Турист</option>
          <option value="operator">Оператор</option>
          <option value="guide">Гид</option>
          <option value="transfer">Трансфер</option>
          <option value="agent">Агент</option>
          <option value="admin">Админ</option>
        </select>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <LoadingSpinner size="lg" message="Загрузка пользователей..." />
        </div>
      ) : users.length === 0 ? (
        <EmptyState title="Пользователи не найдены" description="Попробуйте изменить фильтры" />
      ) : (
        <div className="space-y-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
            <DataTable columns={columns} data={users} />
          </div>
          <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
        </div>
      )}
    </div>
  );
}
