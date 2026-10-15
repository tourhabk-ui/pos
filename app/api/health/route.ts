/**
 * Health Check Endpoint для Timeweb Apps
 * Простая проверка что приложение работает
 */

import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processMemoryMb } from '@/lib/observability/process-memory';
import { embeddingModelStatus } from '@/lib/ai/semantic-search-state';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface DeployMarker {
  commit: string | null;
  built_at: string | null;
  /** 'ok' либо почему маркера нет: третье состояние, не «сборка старая». */
  reason: string;
}

// Маркер деплоя — public/version.json (scripts/write-version.js, пишется в
// момент сборки образа). Читается с диска, а не из process.env: 04.09 штамп
// пробовали передать через `env` next.config.js, и на проде он был null
// (замер 05.09, prod-check run 8) — standalone-сборка до обработчика его не
// доносит. Файл за жизнь процесса не меняется — читаем один раз.
let marker: DeployMarker | null = null;

function readDeployMarker(): DeployMarker {
  if (marker) return marker;
  try {
    const raw = readFileSync(join(process.cwd(), 'public', 'version.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      marker = { commit: null, built_at: null, reason: 'marker_malformed' };
    } else {
      const o = parsed as Record<string, unknown>;
      marker = {
        commit: typeof o.commit === 'string' && o.commit !== 'unknown' ? o.commit : null,
        built_at: typeof o.built_at === 'string' ? o.built_at : null,
        reason: typeof o.reason === 'string' ? o.reason : 'ok',
      };
    }
  } catch (e) {
    const code = typeof e === 'object' && e && 'code' in e ? String((e as { code?: unknown }).code) : '';
    marker = { commit: null, built_at: null, reason: code === 'ENOENT' ? 'marker_missing' : 'marker_unreadable' };
  }
  return marker;
}

// AUTH: Public — infra/utility endpoint for load balancer health checks
//
// На проде голый /api/health отвечает прокси start.js (его процесс, не Next);
// сюда, в Next, доходит адрес с любым запросом после «?» — prod-check читает
// память и модель как https://vedarai.ru/api/health?process=1.
export async function GET() {
  const deploy = readDeployMarker();
  const model = embeddingModelStatus();
  return NextResponse.json({
    status: 'ok',
    service: 'kamchatour-hub',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '0.1.0',
    // Время СБОРКИ образа и её коммит (маркер version.json). uptime говорит,
    // давно ли перезапускались, а это — ТОТ ли код сейчас на проде: 04.09 два
    // замера ушли впустую, потому что шаг ожидания деплоя ловил рестарт от
    // ПРЕДЫДУЩЕГО мержа. null — маркера нет, причина в build_marker.
    build_time: deploy.built_at,
    commit: deploy.commit,
    build_marker: deploy.reason,
    // Память процесса Next и локальная модель поиска по смыслу (аудит 15.10,
    // A21): решать, держать ли модель в веб-процессе на 4 ГБ, — по этим
    // числам. Текста ошибки загрузки здесь нет: роут открыт всем, причина —
    // в /api/cron/health за CRON_SECRET. Род отказа (error_code: код Node
    // или имя класса, без путей и данных) — здесь: 15.10 прод отвечал
    // load_failed за 1 мс, а тело крона с причиной не печаталось (окно health
    // занимал внешний планировщик), и узнать, почему, было нечем.
    memory: processMemoryMb(),
    semantic_search: {
      enabled: model.enabled, model: model.state, since: model.since, load_ms: model.load_ms, error_code: model.error_code,
    },
  });
}
