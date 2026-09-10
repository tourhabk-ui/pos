/**
 * GET /api/cron/build-sha-probe — знает ли прод, каким коммитом он собран, и
 * если нет, то есть ли sha хоть где-нибудь в его окружении.
 * Bearer CRON_SECRET, только чтение, без БД и без сети.
 *
 * Зачем (#1762, 10.09). Маркер сборки на проде второй месяц отвечает
 * `commit: unknown, reason: no_git_head` — `.git` не доезжает до сборки вовсе.
 * Из-за этого у проверки деплоя нет признака «это образ моего пуша», остаётся
 * `built_at`, а он ложный: образ ПРЕДЫДУЩЕГО коммита, собранный после нашего
 * пуша, тоже новее пуша. Дважды за час старый контейнер сошёл за свежий
 * (safety-ledger-check run 8, prod-check run 46), оба замера пришлось
 * объявить непоказательными.
 *
 * Починка упирается в вопрос, на который из репозитория ответа нет: даёт ли
 * Timeweb sha коммита переменной окружения и под каким именем. В панель
 * агент не ходит, зато рантайм прода видит свои переменные целиком — эта
 * проба и есть способ спросить, не заглядывая в панель.
 *
 * ЧТО ПРОБА НЕ ДЕЛАЕТ. Она не объявляет найденный в окружении sha версией
 * прода. Переменные живут в настройках приложения, а не в слоях образа:
 * контейнер, перезапущенный со свежей переменной на старом образе, назвал бы
 * чужой коммит — ровно тот дефект, ради которого всё это и затеяно.
 * Удостоверение образа одно, public/version.json. Здесь — разведка имени,
 * чтобы завести его в сборку через ARG и получить честный маркер.
 *
 * ЗНАЧЕНИЙ ПЕРЕМЕННЫХ ЗДЕСЬ НЕТ: наружу идут имена и семь знаков sha (коммит
 * и так публичен). Проба, отдающая значения, — утечка, а не диагностика
 * (09.08, секрет в query уехал на сторонний хост).
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { SHA_ENV_NAMES, declaredEnvNamesSet, shaShapedEnvNames } from '@/lib/build/commit-sha';

export const dynamic = 'force-dynamic';

interface MarkerRead {
  commit: string | null;
  built_at: string | null;
  reason: string;
  source: string | null;
  env_probe: string[] | null;
}

/**
 * Маркер сборки с диска. Отдельно от /api/health намеренно: там маркер один
 * раз кэшируется на жизнь процесса и урезается до нужных health полей, а
 * здесь нужны сырые `source`/`env_probe`, которых health не отдаёт.
 */
function readMarker(): MarkerRead {
  try {
    const raw = readFileSync(join(process.cwd(), 'public', 'version.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { commit: null, built_at: null, reason: 'marker_malformed', source: null, env_probe: null };
    }
    const o = parsed as Record<string, unknown>;
    return {
      // 'unknown' — это «не смог», а не имя коммита (§4.0).
      commit: typeof o.commit === 'string' && o.commit !== 'unknown' ? o.commit : null,
      built_at: typeof o.built_at === 'string' ? o.built_at : null,
      reason: typeof o.reason === 'string' ? o.reason : 'ok',
      // Маркер старой сборки этих полей не несёт — тогда null, а не [].
      source: typeof o.source === 'string' ? o.source : null,
      env_probe: Array.isArray(o.env_probe) ? o.env_probe.filter((v): v is string => typeof v === 'string') : null,
    };
  } catch (e) {
    const code = typeof e === 'object' && e && 'code' in e ? String((e as { code?: unknown }).code) : '';
    return {
      commit: null,
      built_at: null,
      reason: code === 'ENOENT' ? 'marker_missing' : 'marker_unreadable',
      source: null,
      env_probe: null,
    };
  }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const marker = readMarker();
  const sightings = shaShapedEnvNames();
  const declaredSet = declaredEnvNamesSet();

  // Три исхода, и третий не равен первому:
  //   marker_names_commit — образ называет свой коммит, чинить нечего;
  //   runtime_sha_found   — маркер не знает, но окружение знает: имя найдено,
  //                         дальше его надо завести в СБОРКУ (ARG + панель);
  //   no_sha_anywhere     — ни образ, ни окружение не знают: запас
  //                         MIN_BUILD_SECONDS остаётся единственной защитой.
  const verdict = marker.commit
    ? 'marker_names_commit'
    : sightings.length > 0
      ? 'runtime_sha_found'
      : 'no_sha_anywhere';

  // Совпадает ли то, что видит рантайм, с тем, чем образ себя называет.
  // Расхождение здесь — не поломка, а напоминание: переменная описывает
  // настройку приложения, маркер — слои образа, и это разные вещи.
  const agreement = marker.commit
    ? sightings.length === 0
      ? 'no_runtime_sha_to_compare'
      : sightings.some((s) => s.prefix === marker.commit!.slice(0, 7))
        ? 'runtime_agrees_with_marker'
        : 'runtime_disagrees_with_marker'
    : 'marker_unknown';

  return NextResponse.json({
    probe: 'build_sha_probe_v1',
    checked_at: new Date().toISOString(),
    marker: {
      commit: marker.commit,
      commit_short: marker.commit ? marker.commit.slice(0, 7) : null,
      built_at: marker.built_at,
      reason: marker.reason,
      source: marker.source,
      // Что дошло до СБОРКИ под известными именами. null — маркер записан
      // сборкой до #1762 и поля не несёт; [] — сборке не дали ничего.
      env_probe: marker.env_probe,
    },
    runtime_env: {
      // Имена и семь знаков. Значений нет.
      sha_shaped: sightings,
      declared_names: SHA_ENV_NAMES,
      declared_set: declaredSet.ok,
      // Имя задано, а внутри не sha: чинится значением, а не панелью.
      declared_malformed: declaredSet.malformed,
    },
    verdict,
    agreement,
    note:
      verdict === 'marker_names_commit'
        ? 'Образ называет свой коммит — проверка деплоя может сверять sha, а не время сборки'
        : verdict === 'runtime_sha_found'
          ? 'Маркер коммита не знает, но окружение прода несёт sha под именами из sha_shaped. Следующий шаг: передать это имя в сборку (ARG в Dockerfile + переменная сборки в панели Timeweb). Пока это НЕ версия прода: переменная описывает настройку приложения, а не слои образа'
          : 'Ни образ, ни окружение sha не знают. Признака «это сборка моего пуша» нет; защита у проверки деплоя одна — запас MIN_BUILD_SECONDS. Требуется решение владельца: задать BUILD_COMMIT_SHA переменной сборки в панели Timeweb',
  });
}
