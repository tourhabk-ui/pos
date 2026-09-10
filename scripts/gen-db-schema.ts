#!/usr/bin/env tsx
/**
 * scripts/gen-db-schema.ts — справочник схемы БД из НАСТОЯЩЕЙ базы.
 *
 * Пишет docs/DB_SCHEMA.md: все таблицы public с колонками, ключами и
 * внешними ссылками, представления, ER-диаграмму ядра (Mermaid) и свод по
 * доменам. Источник — information_schema и pg_catalog базы, к которой ведёт
 * DATABASE_URL. Из миграций текстом схема НЕ выводится: разбор DDL
 * консервативен по построению (`lib/database/schema-registry.ts`) и не
 * знает ни типов после ALTER TYPE, ни таблиц, созданных через CREATE TABLE
 * AS, ни колонок, снятых DROP COLUMN. Судить статикой запрещено (CLAUDE.md
 * §4.0) — здесь тот же принцип для документации.
 *
 * Как получить базу с полной схемой (миграции с нуля не проигрываются: цепочка
 * писалась поверх живой базы, каталог начинается с 017):
 *
 *   createdb schema_doc
 *   DATABASE_URL=postgresql://.../schema_doc node scripts/bootstrap-from-baseline.js
 *   psql schema_doc -c "DELETE FROM _migrations WHERE name >= '863'"   # всё новее baseline
 *   DATABASE_URL=postgresql://.../schema_doc npm run migrate
 *   DATABASE_URL=postgresql://.../schema_doc npm run db:schema-doc
 *
 * Первая строка «после baseline» — 863: baseline снят с прода 2026-08-15,
 * последней миграцией того дня была 862 (migrations/MIGRATION_ORDER.md).
 *
 * Из базы выходят только имена и типы — ни одного значения данных. Файл можно
 * читать кому угодно.
 */
import { Client } from 'pg';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Column {
  table: string;
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
}
interface Fk { table: string; column: string; refTable: string; refColumn: string }
interface Pk { table: string; columns: string[] }

/** Домены — первый совпавший побеждает, порядок важен (payments раньше tour_, safety раньше route_). */
const DOMAINS: Array<{ title: string; note: string; re: RegExp }> = [
  {
    title: 'Платежи и деньги',
    note: 'Приём оплаты — `app/api/payments/*` (§7, не трогать). Комиссия начисляется только `recordCommissionFromBooking()`.',
    re: /^(tour_payments|operator_commissions|operator_payouts|commission_payouts|affiliate_|agent_commissions|agent_market_payments|transfer_transactions|refund_requests)/,
  },
  {
    title: 'Безопасность',
    note: 'SOS пишет `sos_events` (`app/api/safety/sos`, §7). Внешние сигналы (сейсмика, МЧС, пожары) — `external_alerts`; журнал решений конвейера — `safety_decision_events` (append-only, триггер).',
    re: /^(sos_events|external_alerts|safety_|mchs_|emergency_contacts|tourist_incidents|route_registrations|route_registration_|danger_assessments|zone_capacity_limits|volcano_status|weather_alert)/,
  },
  {
    title: 'Точки, маршруты, карта',
    note: 'Три master-сущности: `places` (точка), `kamchatka_routes` (маршрут), связь — `route_waypoints` с родом `link_kind`. Читать маршруты наружу только через `v_kamchatka_routes_api`.',
    re: /^(places|place_|kamchatka_routes|route_|_route_description|ai_route_images|location_|parks|road_graph|crowd_log|trail_report|collections|activities|description_provenance|_agent_route_knowledge_legacy|user_place_photos)/,
  },
  {
    title: 'Туры и брони',
    note: 'Коммерция оператора. Бронь — `operator_bookings` (колонка `booking_status`). `bookings` и `tours` — базовые таблицы раннего этапа, в новом коде запрещены (CLAUDE.md §4).',
    re: /^(operator_tours|operator_tour_|tour_|operator_bookings|booking_|bookings|tours|cancellation_policies|promo_codes|contingency_rules|channel_orders|octo_|uon_sync)/,
  },
  {
    title: 'Люди и доступ',
    note: 'JWT в httpOnly-куке `auth_token`; роли — `users.role`, партнёрские профили — `partners`. Логика — `lib/auth.ts` (§7) и `lib/auth/*`.',
    re: /^(users|user_sessions|user_role_history|sessions|accounts|verification_tokens|partners|partner_|operator_applications|operator_signups|operator_staff|operator_settings|operator_ai_|operator_site_audits|operator_stats_cache|operator_vehicles|official_registry|tourist_profiles|tourist_documents|max_login|referrals|security_blocks|audit_log)/,
  },
  { title: 'Гиды', note: '`guide_certifications` — аттестации; живой гид = действующая проверенная аттестация.', re: /^guide_/ },
  {
    title: 'Жильё, снаряжение, трансферы',
    note: 'Три партнёрских модуля: stay, gear, carrier. Трансферы пересобраны 02.09 (`transfer_trips`, `transfer_seat_bookings`).',
    re: /^(accommodation|gear_|transfer|vehicles|vehicle_|drivers|driver_)/,
  },
  {
    title: 'Турагенты (роль agent)',
    note: 'B2B-агенты, продающие туры за комиссию. Не путать с AI-агентами.',
    re: /^(agent_clients|agent_bookings|agent_referral_)/,
  },
  {
    title: 'Лиды и продажи',
    note: 'Заявка без регистрации — `leads` (`POST /api/leads`), квалификация — `lib/services/operators/lead-processor.service.ts`.',
    re: /^(leads|lead_|sales_|outreach_|partner_prospects|funnel_events|client_communications)/,
  },
  {
    title: 'Кузьмич, чат, RAG',
    note: 'Общий мозг — `lib/kuzmich/core.ts`; каналы Telegram (`tg_*`), MAX, web. Память — `user_ai_memory`, `agent_memory`.',
    re: /^(chat_|conversation|kuzmich_|user_ai_memory|rag_|query_expansion|knowledge_base|tg_|message_templates|mcp_|llm_usage)/,
  },
  {
    title: 'AI-агенты, эволюция, ядро',
    note: 'Ядро агентов — `agent_events`/`agent_effects`/`agent_tasks` (`lib/agents/kernel`), эволюция — `evo_*`, аренда окна крона — `cron_leases`.',
    re: /^(agent_|evo_|cron_leases|approval_execution|ai_actions_log|intelligence_sources|board_meeting|external_tools|stakeholder_wishes|legislation_docs)/,
  },
  { title: 'Эко и лояльность', note: '', re: /^(eco_|user_eco|user_achievements|loyalty_)/ },
  {
    title: 'Контент, уведомления, поездки туриста',
    note: 'Поездка туриста — `user_trips`; подготовка к походу — `trip_preparation_*` (миграция 864).',
    re: /^(articles|faqs|notifications|notification_|smart_notifications|push_subscriptions|pwa_installs|page_views|email_templates|assets|review|support_tickets|system_settings|platform_settings|trip_preparation|user_trips)/,
  },
  { title: 'Служебные', note: '`_migrations` — журнал накатки; `_migration_failures` — отказы миграций на проде.', re: /^_/ },
];

/**
 * Ядро ER-диаграммы: таблицы двух дорог туриста (маршрут с картой и
 * безопасностью; купить тур) и то, на чём они стоят.
 */
const CORE_TABLES = [
  'places', 'kamchatka_routes', 'route_waypoints', 'location_safety_profile', 'location_real_time_status',
  'ai_route_images', 'operator_tours', 'tour_availability', 'operator_bookings', 'tour_payments',
  'operator_commissions', 'partners', 'users', 'leads', 'sos_events', 'external_alerts',
  'safety_decision_events', 'route_registrations', 'user_trips', 'reviews',
];

/**
 * Связи, которых в pg_constraint НЕТ — они держатся кодом (CLAUDE.md §4.1).
 * В диаграмме идут пунктиром: читатель обязан видеть, что база их не охраняет.
 */
const LOGICAL_LINKS: Array<[string, string, string]> = [
  ['location_safety_profile', 'places', 'agent_route_id = places.ark_id'],
  ['location_real_time_status', 'places', 'agent_route_id = places.ark_id'],
  ['ai_route_images', 'places', 'route_id = places.ark_id'],
];

function domainOf(table: string): string {
  for (const d of DOMAINS) if (d.re.test(table)) return d.title;
  return 'Прочее';
}

function lastMigration(): string {
  const files = readdirSync(join(process.cwd(), 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  return files[files.length - 1] ?? '';
}

function shortType(t: string): string {
  return t
    .replace('character varying', 'varchar')
    .replace('timestamp with time zone', 'timestamptz')
    .replace('timestamp without time zone', 'timestamp')
    .replace('double precision', 'float8')
    .replace('USER-DEFINED', 'enum')
    .replace('ARRAY', 'array');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL не задан — схему брать неоткуда');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  await client.connect();

  const tables = (await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  )).rows.map((r) => r.table_name);

  const views = (await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.views WHERE table_schema = 'public' ORDER BY table_name`,
  )).rows.map((r) => r.table_name);

  const columns = (await client.query<{ table_name: string; column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  )).rows.map<Column>((r) => ({
    table: r.table_name,
    name: r.column_name,
    type: shortType(r.data_type === 'ARRAY' ? `${r.udt_name.replace(/^_/, '')}[]` : r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type),
    notNull: r.is_nullable === 'NO',
    hasDefault: r.column_default !== null,
  }));

  const fks = (await client.query<{ t: string; c: string; rt: string; rc: string }>(
    `SELECT c.conrelid::regclass::text AS t, a.attname AS c, c.confrelid::regclass::text AS rt, ra.attname AS rc
       FROM pg_constraint c
       JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum  = ANY (c.conkey)
       JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = ANY (c.confkey)
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      ORDER BY 1, 2`,
  )).rows.map<Fk>((r) => ({ table: r.t, column: r.c, refTable: r.rt, refColumn: r.rc }));

  const pks = (await client.query<{ t: string; cols: string[] }>(
    `SELECT c.conrelid::regclass::text AS t, array_agg(a.attname::text ORDER BY a.attnum)::text[] AS cols
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'p' AND c.connamespace = 'public'::regnamespace GROUP BY 1`,
  )).rows.map<Pk>((r) => ({ table: r.t, columns: r.cols }));

  const indexCount = new Map<string, number>();
  for (const r of (await client.query<{ tablename: string; n: string }>(
    `SELECT tablename, count(*)::text AS n FROM pg_indexes WHERE schemaname = 'public' GROUP BY tablename`,
  )).rows) indexCount.set(r.tablename, Number(r.n));

  const triggers = (await client.query<{ t: string; name: string }>(
    `SELECT event_object_table AS t, trigger_name AS name FROM information_schema.triggers
      WHERE trigger_schema = 'public' GROUP BY 1, 2 ORDER BY 1, 2`,
  )).rows;

  const pgVersion = (await client.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)).rows[0]?.v ?? '?';
  await client.end();

  const colsByTable = new Map<string, Column[]>();
  for (const c of columns) colsByTable.set(c.table, [...(colsByTable.get(c.table) ?? []), c]);
  const fksByTable = new Map<string, Fk[]>();
  for (const f of fks) fksByTable.set(f.table, [...(fksByTable.get(f.table) ?? []), f]);
  const pkByTable = new Map(pks.map((p) => [p.table, p.columns]));
  const triggersByTable = new Map<string, string[]>();
  for (const t of triggers) triggersByTable.set(t.t, [...(triggersByTable.get(t.t) ?? []), t.name]);

  const byDomain = new Map<string, string[]>();
  for (const t of tables) {
    const d = domainOf(t);
    byDomain.set(d, [...(byDomain.get(d) ?? []), t]);
  }
  const domainOrder = [...DOMAINS.map((d) => d.title), 'Прочее'].filter((d) => byDomain.has(d));

  const today = new Date().toISOString().slice(0, 10);
  const last = lastMigration();
  const out: string[] = [];
  const w = (s = '') => out.push(s);

  w('# Схема базы данных Ведара');
  w();
  w(`> Снято ${today} с настоящего PostgreSQL ${pgVersion}: baseline прода (\`lib/database/baseline/schema-baseline.sql\`, снимок 2026-08-15) + миграции новее него, накатанные штатным раннером. Последняя миграция в снимке: \`${last}\`.`);
  w('> Файл порождён `scripts/gen-db-schema.ts` (`npm run db:schema-doc`); править руками бессмысленно — следующий прогон перепишет.');
  w('> Что здесь НЕ учтено: дрейф прода после baseline, не отражённый миграциями. Судья дрейфа — `GET /api/cron/schema-drift` на проде (`lib/db/schema-drift.ts`). Значений данных в файле нет — только имена и типы.');
  w();
  w('| Что | Сколько |');
  w('|---|---:|');
  w(`| Таблиц | ${tables.length} |`);
  w(`| Представлений (VIEW) | ${views.length} |`);
  w(`| Колонок | ${columns.length} |`);
  w(`| Внешних ключей | ${fks.length} |`);
  w(`| Таблиц без единого FK в обе стороны | ${tables.filter((t) => !fks.some((f) => f.table === t || f.refTable === t)).length} |`);
  w();
  w('Обозначения в списках колонок: `!` — NOT NULL, `=` — есть DEFAULT, `PK` — первичный ключ, `→` — внешний ключ.');
  w();

  // ── Оглавление доменов ──
  w('## Домены');
  w();
  w('| Домен | Таблиц | Таблицы |');
  w('|---|---:|---|');
  for (const d of domainOrder) {
    const list = byDomain.get(d) ?? [];
    w(`| [${d}](#${anchor(d)}) | ${list.length} | ${list.map((t) => `\`${t}\``).join(' ')} |`);
  }
  w();

  // ── ER-диаграмма ядра ──
  w('## ER-диаграмма ядра (две дороги туриста)');
  w();
  w('Сплошная линия — внешний ключ в базе. Пунктир — связь, которую держит только код (без FK): база её не охраняет, и сирота возможна.');
  w();
  w('```mermaid');
  w('erDiagram');
  const core = new Set(CORE_TABLES.filter((t) => tables.includes(t)));
  for (const t of core) {
    w(`  ${t} {`);
    const cols = colsByTable.get(t) ?? [];
    const pk = new Set(pkByTable.get(t) ?? []);
    const fkCols = new Set((fksByTable.get(t) ?? []).map((f) => f.column));
    // В диаграмму — ключи и первые содержательные колонки, иначе она нечитаема.
    const shown = cols.filter((c) => pk.has(c.name) || fkCols.has(c.name)).concat(
      cols.filter((c) => !pk.has(c.name) && !fkCols.has(c.name)).slice(0, 6),
    );
    for (const c of shown) {
      const tag = pk.has(c.name) ? ' PK' : fkCols.has(c.name) ? ' FK' : '';
      w(`    ${mermaidType(c.type)} ${c.name}${tag}`);
    }
    w('  }');
  }
  const drawn = new Set<string>();
  for (const f of fks) {
    if (!core.has(f.table) || !core.has(f.refTable) || f.table === f.refTable) continue;
    const key = `${f.table}>${f.refTable}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    w(`  ${f.refTable} ||--o{ ${f.table} : "${f.column}"`);
  }
  for (const [from, to, label] of LOGICAL_LINKS) {
    if (core.has(from) && core.has(to)) w(`  ${to} ||..o{ ${from} : "${label}"`);
  }
  w('```');
  w();

  // ── Домены с таблицами ──
  for (const d of domainOrder) {
    const meta = DOMAINS.find((x) => x.title === d);
    w(`## ${d}`);
    w();
    if (meta?.note) { w(meta.note); w(); }
    for (const t of byDomain.get(d) ?? []) {
      const cols = colsByTable.get(t) ?? [];
      const pk = pkByTable.get(t) ?? [];
      const tfks = fksByTable.get(t) ?? [];
      const incoming = fks.filter((f) => f.refTable === t && f.table !== t).map((f) => f.table);
      const head: string[] = [`${cols.length} кол.`];
      if (pk.length) head.push(`PK ${pk.join(', ')}`);
      if (tfks.length) head.push(tfks.map((f) => `${f.column} → ${f.refTable}.${f.refColumn}`).join(', '));
      if (incoming.length) head.push(`на неё ссылаются: ${[...new Set(incoming)].join(', ')}`);
      const idx = indexCount.get(t) ?? 0;
      if (idx) head.push(`индексов ${idx}`);
      const trg = triggersByTable.get(t);
      if (trg?.length) head.push(`триггеры: ${[...new Set(trg)].join(', ')}`);
      w(`**${t}** · ${head.join(' · ')}`);
      w();
      w(cols.map((c) => `\`${c.name} ${c.type}${c.notNull ? '!' : ''}${c.hasDefault ? '=' : ''}\``).join(' '));
      w();
    }
  }

  w('## Представления (VIEW)');
  w();
  for (const v of views) {
    const cols = colsByTable.get(v) ?? [];
    w(`**${v}** · ${cols.length} кол.`);
    w();
    w(cols.map((c) => `\`${c.name} ${c.type}\``).join(' '));
    w();
  }

  const target = join(process.cwd(), 'docs', 'DB_SCHEMA.md');
  writeFileSync(target, out.join('\n') + '\n');
  console.log(`docs/DB_SCHEMA.md: таблиц ${tables.length}, представлений ${views.length}, колонок ${columns.length}, FK ${fks.length}, последняя миграция ${last}`);
}

function anchor(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}

function mermaidType(t: string): string {
  // Mermaid не переносит скобки, запятые и квадратные скобки в типах.
  return t.replace(/\[\]/g, '_array').replace(/[^a-z0-9_]/gi, '_');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
