/**
 * База знаний Timeweb AI: сбор документов и выгрузка.
 *
 * ── Что нашёл разбор (#1783) ───────────────────────────────────────────────
 *
 * Маршрут собирал «базу знаний» из шести документов проекта. ПЯТИ из шести
 * не существует: `docs/AI_ASSISTANTS_GUIDE.md`, `docs/ROLES_IMPLEMENTATION_PLAN.md`,
 * `docs/DEPLOYMENT_READY.md`, `ЧЕСТНАЯ_ПРОВЕРКА_ЗАГЛУШЕК.md`,
 * `ФИНАЛЬНЫЙ_ОТЧЁТ_ДОРАБОТКИ_ДО_100.md` — остался один README. Пропускались
 * они `fs.existsSync` молча, без единого слова в ответе, поэтому «база
 * знаний собрана» звучало одинаково и при шести документах, и при одном.
 *
 * Отказов было семь, и все глухие: пустые `catch`, прочитанный и выброшенный
 * `errorText` ответа Timeweb, пустой `if (documents.length > maxDocs) {}`
 * вместо сообщения об обрезке. Вызывающий получал `false` СРАЗУ ЗА ТРИ
 * РАЗНЫХ состояния — «выгрузка выключена», «сервер ответил отказом», «упало
 * исключение» — и печатал одну фразу «Failed to update knowledge base»
 * (§4.0: место, где нельзя сказать «не знаю», заполняется враньём).
 *
 * ── И ещё: на проде не читается НИ ОДИН из шести ───────────────────────────
 *
 * Разбор списка показал пять отсутствующих файлов — но это счёт по
 * репозиторию. В образе, который работает на проде, нет и шестого. Dockerfile
 * копирует в runner ровно `public`, `.next/standalone`, `.next/static`,
 * `migrations`, `scripts/migrate-standalone.js` и `start.js` — ни README.md,
 * ни каталога `docs/` там нет вовсе. Значит файловая ветка сбора на проде
 * даёт НОЛЬ документов по построению, а не «иногда меньше».
 *
 * Чинится это двумя разными способами — довезти документы в образ или убрать
 * ветку, — и выбор здесь не мой: он зависит от того, что владелец хочет
 * видеть в базе знаний (репозиторные документы для ассистента, отвечающего
 * туристу, — сомнительное содержимое). Поэтому ветка оставлена, но теперь
 * каждый путь отчитывается словом `missing` с причиной, и «база знаний
 * собрана» больше не звучит одинаково при шести документах и при нуле.
 * Связку держит `tests/unit/knowledge-base-honest.test.ts`: путь, которого
 * нет в образе, обязан быть записан в реестре с причиной.
 *
 * ── Почему выгрузка НЕ «починена», а только честно отчитывается ────────────
 *
 * Рядом лежит `scripts/sync-timeweb-kb.ts`, который делает то же самое, и он
 * расходится с этим маршрутом ТРЕМЯ способами сразу:
 *
 *   1. адрес: скрипт бьёт в `.../knowledge-bases/{KB_ID}/documents`, маршрут —
 *      в `.../knowledge-bases` без идентификатора и без `/documents`, хотя
 *      идентификатор лежит рядом в конфиге и не используется;
 *   2. тело: скрипт шлёт ОДИН документ как `{name, type: 'link', url}`,
 *      маршрут — пачку как `{agentId, documents, chunkIndex, totalChunks}`;
 *   3. токен: скрипт читает `TIMEWEB_TOKEN`, маршрут — `TIMEWEB_API_TOKEN`.
 *
 * Значит эта выгрузка, скорее всего, не работала НИ РАЗУ, а ответ сервера,
 * который бы это доказал, читался и выбрасывался. Угадать верный контракт
 * отсюда нельзя: сам скрипт в комментарии сомневается, поддерживается ли
 * data-URI, и грузит документы по одному как ссылки — а у собранных здесь
 * документов публичного URL нет вовсе. Поэтому правится то, что проверяемо:
 * отказ называется, состав источников виден поимённо, ответ сервера доходит
 * до читающего. Выбор «чинить по настоящему контракту или удалить выгрузку»
 * остаётся человеку, и теперь у него есть чем его сделать.
 */

import { NextRequest, NextResponse } from 'next/server'
import { config } from '@/lib/config'
import { requireAdmin } from '@/lib/auth/middleware'
import { pool } from '@/lib/db-pool'
import { convertUrlToMarkdown } from '@/lib/ai/markdown-new'
import fs from 'fs'
import path from 'path'
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'

// Для Timeweb Cloud Apps можно использовать nodejs runtime
export const runtime = 'nodejs'

interface KnowledgeDocument {
  id: string
  title: string
  content: string
  category: string
  lastUpdated: string
  source: string
  url?: string
}

/**
 * Что стало с каждым источником. Три исхода, а не «попал в массив или нет»:
 * «взяли», «нет на месте» и «не смог прочитать» — разные вещи и чинятся
 * по-разному (§4.0).
 */
interface KbSourceOutcome {
  source: string
  kind: 'file' | 'db' | 'url'
  status: 'included' | 'missing' | 'failed'
  /** Почему не вышло. null — вышло. */
  reason: string | null
  /** Сколько получено: байт для файла, строк для запроса. */
  size: number | null
}

interface KbCollection {
  documents: KnowledgeDocument[]
  sources: KbSourceOutcome[]
}

function parseSourceUrls(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

async function collectExternalUrlDocuments(urls: string[]): Promise<KbCollection> {
  const documents: KnowledgeDocument[] = [];
  const sources: KbSourceOutcome[] = [];

  for (const sourceUrl of urls) {
    try {
      const markdown = await convertUrlToMarkdown(sourceUrl, { method: 'auto', retainImages: false });
      sources.push({ source: sourceUrl, kind: 'url', status: 'included', reason: null, size: markdown.length });
      documents.push({
        id: `external_${Buffer.from(sourceUrl).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`,
        title: `External URL: ${sourceUrl}`,
        content: markdown,
        category: 'external_sources',
        lastUpdated: new Date().toISOString(),
        source: sourceUrl,
        url: sourceUrl,
      });
    } catch (error) {
      // Прежде отказ пропадал целиком, и «источник не настроен» было не
      // отличить от «источник не ответил».
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[knowledge-base] внешний источник ${sourceUrl} не прочитан: ${reason}`);
      sources.push({ source: sourceUrl, kind: 'url', status: 'failed', reason, size: null });
    }
  }

  return { documents, sources };
}

// Настройка S3 клиента для Timeweb Cloud
const s3AccessKey = process.env.S3_ACCESS_KEY
const s3SecretKey = process.env.S3_SECRET_KEY
const s3Endpoint = process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru'
const s3Bucket = process.env.S3_BUCKET

const s3Client = s3AccessKey && s3SecretKey
  ? new S3Client({
      region: process.env.S3_REGION || 'ru-1',
      endpoint: s3Endpoint,
      credentials: {
        accessKeyId: s3AccessKey,
        secretAccessKey: s3SecretKey,
      },
      forcePathStyle: true,
    })
  : null

// Получить все документы для базы знаний
async function collectProjectDocuments(): Promise<KbCollection> {
  const documents: KnowledgeDocument[] = []
  const sources: KbSourceOutcome[] = []

  // Основные документы проекта
  const docPaths = [
    'README.md',
    'docs/AI_ASSISTANTS_GUIDE.md',
    'docs/ROLES_IMPLEMENTATION_PLAN.md',
    'docs/DEPLOYMENT_READY.md',
    'ЧЕСТНАЯ_ПРОВЕРКА_ЗАГЛУШЕК.md',
    'ФИНАЛЬНЫЙ_ОТЧЁТ_ДОРАБОТКИ_ДО_100.md',
  ]

  for (const docPath of docPaths) {
    const fullPath = path.join(process.cwd(), docPath)
    // Читаем сразу, без пары «проверил существование — потом прочитал»:
    // ошибка чтения сама скажет, чего не хватает, и заодно различит «файла
    // нет» (ENOENT) от «файл есть, но не читается» (права, битая кодировка).
    let content: string
    try {
      content = fs.readFileSync(fullPath, 'utf-8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      const reason = error instanceof Error ? error.message : String(error)
      // Пять из шести путей этого списка не существуют, и молчали они так
      // же, как молчал бы сбой прав. Теперь оба состояния названы, и оба
      // доезжают до ответа, а не только до лога.
      console.error(`[knowledge-base] документ ${docPath} не попал в базу знаний: ${reason}`)
      sources.push({
        source: docPath,
        kind: 'file',
        status: code === 'ENOENT' ? 'missing' : 'failed',
        reason: code === 'ENOENT' ? 'файла нет в сборке' : reason,
        size: null,
      })
      continue
    }

    const title = path.basename(docPath, path.extname(docPath))
    sources.push({ source: docPath, kind: 'file', status: 'included', reason: null, size: content.length })
    documents.push({
      id: `doc_${title.toLowerCase().replace(/\s+/g, '_')}`,
      title: title.replace(/_/g, ' '),
      content: content,
      category: 'documentation',
      lastUpdated: new Date().toISOString(),
      source: docPath,
    })
  }

  const { query } = await import('@/lib/database')

  // Туры и операторы — В РАЗНЫХ try. Прежде их накрывал один, и его catch
  // писал «операторы не попали в базу знаний» ДАЖЕ когда падал запрос туров:
  // сообщение об отказе называло не того виноватого, а второй запрос при
  // этом не выполнялся вовсе.
  try {
    const tours = await query(`
      SELECT
        id,
        title AS name,
        description,
        base_price AS price,
        duration_hours AS duration,
        difficulty,
        location_name AS location,
        activity_type AS category
      FROM operator_tours
      WHERE is_active = true AND deleted_at IS NULL
      LIMIT 50
    `)

    tours.rows.forEach((tour: Record<string, unknown>) => {
      documents.push({
        id: `tour_${tour.id}`,
        title: `Тур: ${tour.name}`,
        content: `
Название: ${tour.name}
Описание: ${tour.description || 'Нет описания'}
Цена: ${tour.price} ₽
Длительность: ${tour.duration} дней
Сложность: ${tour.difficulty || 'Не указана'}
Местоположение: ${tour.location || 'Камчатка'}
Категория: ${tour.category || 'Экскурсионный'}
        `,
        category: 'tours',
        lastUpdated: new Date().toISOString(),
        source: 'database_tours',
      })
    })
    sources.push({ source: 'operator_tours', kind: 'db', status: 'included', reason: null, size: tours.rows.length })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[knowledge-base] туры не попали в базу знаний:', reason)
    sources.push({ source: 'operator_tours', kind: 'db', status: 'failed', reason, size: null })
  }

  try {
    const operators = await query(`
      SELECT
        id,
        name,
        description,
        category,
        rating
      FROM partners
      WHERE category = 'operator'
      LIMIT 20
    `)

    operators.rows.forEach((operator: Record<string, unknown>) => {
      documents.push({
        id: `operator_${operator.id}`,
        title: `Оператор: ${operator.name}`,
        content: `
Название: ${operator.name}
Описание: ${operator.description || 'Нет описания'}
Направление: ${operator.category || 'не указано'}
Рейтинг: ${operator.rating || 'Не оценен'}
        `,
        category: 'operators',
        lastUpdated: new Date().toISOString(),
        source: 'database_operators',
      })
    })
    sources.push({ source: 'partners', kind: 'db', status: 'included', reason: null, size: operators.rows.length })
  } catch (error) {
    // Запрос годами шёл по призрачной модели (role, contact_info,
    // specialization — таких колонок в partners нет) и падал целиком: в базе
    // знаний не было НИ ОДНОГО оператора, а пустой catch выдавал это за
    // «операторов нет».
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[knowledge-base] операторы не попали в базу знаний:', reason);
    sources.push({ source: 'partners', kind: 'db', status: 'failed', reason, size: null })
  }

  const externalUrls = parseSourceUrls(process.env.KNOWLEDGE_BASE_SOURCE_URLS)
  if (externalUrls.length > 0) {
    const external = await collectExternalUrlDocuments(externalUrls)
    documents.push(...external.documents)
    sources.push(...external.sources)
  }

  return { documents, sources }
}

// Загрузить файл в S3 хранилище
async function uploadToS3(file: File, fileName: string): Promise<string> {
  // Прежде тело было обёрнуто в `try { ... } catch (error) { throw error }` —
  // конструкция, которая не делает ничего, но выглядит как обработка отказа.
  // Читающий видел «ошибки предусмотрены», хотя предусмотрено не было ничего.
  if (!s3Client || !s3Bucket) {
    throw new Error('Хранилище S3 не настроено: нет ключей или имени бакета')
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  await s3Client.send(new PutObjectCommand({
    Bucket: s3Bucket,
    Key: `knowledge-base/${fileName}`,
    Body: buffer,
    ContentType: file.type,
    ACL: 'public-read',
  }))

  return `${s3Endpoint}/${s3Bucket}/knowledge-base/${fileName}`
}

/**
 * Чем кончилась выгрузка. Раньше здесь было `boolean`, и `false` значил
 * СРАЗУ ТРИ разных состояния: выгрузка выключена, сервер ответил отказом,
 * упало исключение. Вызывающий печатал одну фразу на все три, а ответ
 * сервера — единственное, что объяснило бы отказ, — читался и выбрасывался.
 */
type KbUpdateResult =
  | { status: 'ok'; chunks: number }
  | { status: 'disabled'; reason: string }
  | { status: 'http_error'; httpStatus: number; body: string; chunkIndex: number }
  | { status: 'exception'; reason: string }

// Обновить базу знаний Timeweb AI
async function updateKnowledgeBase(documents: KnowledgeDocument[]): Promise<KbUpdateResult> {
  const { timeweb } = config.ai

  if (!timeweb.knowledgeBase.enabled) {
    return { status: 'disabled', reason: 'TIMEWEB_AI_KB_ID не задан — выгрузка выключена, это не отказ сервера' }
  }

  try {
    // Разбиваем документы на чанки для отправки
    const chunks = []
    const chunkSize = timeweb.knowledgeBase.chunkSize

    for (let i = 0; i < documents.length; i += chunkSize) {
      chunks.push(documents.slice(i, i + chunkSize))
    }


    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]

      const response = await fetch(timeweb.knowledgeBase.updateEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.TIMEWEB_API_TOKEN}`,
        },
        body: JSON.stringify({
          agentId: process.env.TIMEWEB_AI_AGENT_ID ?? '',
          documents: chunk,
          chunkIndex: i,
          totalChunks: chunks.length,
        }),
      })

      if (!response.ok) {
        // Тело ответа — единственное, что объясняет отказ. Прежде оно
        // читалось в `errorText` и выбрасывалось, не дойдя ни до лога, ни до
        // вызывающего: отказ Timeweb был неотличим от выключенной выгрузки.
        const body = (await response.text().catch(() => '')).slice(0, 500)
        console.error(
          `[knowledge-base] Timeweb отверг чанк ${i + 1}/${chunks.length}: HTTP ${response.status} ${body}`,
        )
        return { status: 'http_error', httpStatus: response.status, body, chunkIndex: i }
      }

      await response.json().catch(() => null)

      // Небольшая задержка между запросами
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    return { status: 'ok', chunks: chunks.length }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[knowledge-base] выгрузка не дошла до Timeweb:', reason)
    return { status: 'exception', reason }
  }
}

// GET - Получить статус базы знаний
// AUTH: requireAdmin — чувствительное управление KB и внешние интеграции
export async function GET(request: NextRequest) {
  const adminOrResponse = await requireAdmin(request);
  if (adminOrResponse instanceof NextResponse) return adminOrResponse;

  try {
    const { timeweb } = config.ai

    const kbStats = await pool.query<{ count: number; last_update: string | null }>(
      `SELECT COUNT(*)::int AS count, MAX(updated_at) AS last_update
       FROM knowledge_base_articles WHERE is_published = true`
    );

    const status = {
      agentId: process.env.TIMEWEB_AI_AGENT_ID ?? '',
      agentName: 'Timeweb AI Agent (deprecated)',
      knowledgeBaseEnabled: timeweb.knowledgeBase.enabled,
      maxDocuments: timeweb.knowledgeBase.maxDocuments,
      chunkSize: timeweb.knowledgeBase.chunkSize,
      s3Bucket: process.env.S3_BUCKET,
      s3Endpoint: process.env.S3_ENDPOINT,
      lastUpdate: kbStats.rows[0]?.last_update ?? null,
      documentCount: kbStats.rows[0]?.count ?? 0,
    }

    return NextResponse.json({
      success: true,
      data: status,
      // Без этой оговорки статус читался как отчёт о выгрузке, а описывает он
      // ДРУГОЕ: `documentCount` и `lastUpdate` считаны из локальной таблицы
      // knowledge_base_articles, в которую POST этого маршрута не пишет ни
      // строки. Два разных предмета под одним адресом — и молча.
      note:
        'documentCount и lastUpdate — про локальную таблицу knowledge_base_articles, '
        + 'а не про выгрузку в Timeweb: POST этого маршрута в неё не пишет. '
        + 'Состав выгрузки виден в ответе POST полем sources.',
    })

  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[knowledge-base] статус не собран:', reason)
    return NextResponse.json({
      success: false,
      error: 'Не удалось получить статус базы знаний',
      reason,
    }, { status: 500 })
  }
}

// POST - Обновить базу знаний
// AUTH: requireAdmin — чувствительное управление KB и внешние интеграции
export async function POST(request: NextRequest) {
  const adminOrResponse = await requireAdmin(request);
  if (adminOrResponse instanceof NextResponse) return adminOrResponse;

  try {

    const formData = await request.formData()
    const updateType = formData.get('type') as string || 'auto'

    let documents: KnowledgeDocument[] = []
    let sources: KbSourceOutcome[] = []

    if (updateType === 'file' && formData.has('file')) {
      // Загрузка файла
      const file = formData.get('file') as File
      if (!file) {
        return NextResponse.json({
          success: false,
          error: 'No file provided'
        }, { status: 400 })
      }


      // Загружаем файл в S3
      const fileName = `${Date.now()}_${file.name}`
      const fileUrl = await uploadToS3(file, fileName)

      // Читаем содержимое файла
      const content = await file.text()

      sources.push({ source: file.name, kind: 'file', status: 'included', reason: null, size: content.length })
      documents.push({
        id: `file_${Date.now()}`,
        title: file.name,
        content: content,
        category: 'uploaded_files',
        lastUpdated: new Date().toISOString(),
        source: fileUrl,
        url: fileUrl,
      })

    } else if (updateType === 'url') {
      const sourceUrl = (formData.get('url') as string | null)?.trim()

      if (!sourceUrl) {
        return NextResponse.json({
          success: false,
          error: 'URL is required for type=url'
        }, { status: 400 })
      }

      const markdown = await convertUrlToMarkdown(sourceUrl, { method: 'auto', retainImages: false })
      sources.push({ source: sourceUrl, kind: 'url', status: 'included', reason: null, size: markdown.length })
      documents.push({
        id: `url_${Date.now()}`,
        title: `URL: ${sourceUrl}`,
        content: markdown,
        category: 'external_sources',
        lastUpdated: new Date().toISOString(),
        source: sourceUrl,
        url: sourceUrl,
      })
    } else {
      // Автоматическое обновление из проекта
      const collected = await collectProjectDocuments()
      documents = collected.documents
      sources = collected.sources
    }


    // Ограничиваем количество документов
    const maxDocs = config.ai.timeweb.knowledgeBase.maxDocuments
    const limitedDocuments = documents.slice(0, maxDocs)
    const truncated = Math.max(0, documents.length - limitedDocuments.length)
    if (truncated > 0) {
      // Прежде здесь стоял пустой `if`: обрезка происходила молча, и «база
      // знаний обновлена» звучало одинаково при полной выгрузке и при
      // выброшенной половине.
      console.error(`[knowledge-base] обрезано ${truncated} документ(ов) сверх лимита ${maxDocs}`)
    }

    // Состав источников отдаётся ВСЕГДА, даже при успехе: «собрано 3
    // документа» не говорит, что пять других не нашлись.
    const missing = sources.filter(x => x.status === 'missing').map(x => x.source)
    const failed = sources.filter(x => x.status === 'failed')

    const result = await updateKnowledgeBase(limitedDocuments)

    const common = {
      type: updateType,
      documentsProcessed: limitedDocuments.length,
      totalDocuments: documents.length,
      truncated,
      sources,
      missingSources: missing,
      failedSources: failed.map(x => ({ source: x.source, reason: x.reason })),
    }

    if (result.status === 'ok') {
      return NextResponse.json({
        success: true,
        message: missing.length > 0 || failed.length > 0
          ? 'База знаний обновлена НЕ ПОЛНОСТЬЮ — часть источников не прочитана'
          : 'База знаний обновлена',
        chunks: result.chunks,
        ...common,
      })
    }

    // Три разных отказа — три разных ответа. Прежде все они выходили одной
    // фразой «Failed to update knowledge base», и по ней нельзя было понять,
    // чинить настройку, доступ или запрос.
    if (result.status === 'disabled') {
      return NextResponse.json({
        success: false,
        outcome: result.status,
        error: 'Выгрузка в Timeweb не настроена',
        reason: result.reason,
        ...common,
      }, { status: 409 })
    }

    if (result.status === 'http_error') {
      return NextResponse.json({
        success: false,
        outcome: result.status,
        error: `Timeweb отверг выгрузку: HTTP ${result.httpStatus}`,
        reason: result.body,
        chunkIndex: result.chunkIndex,
        ...common,
      }, { status: 502 })
    }

    return NextResponse.json({
      success: false,
      outcome: result.status,
      error: 'Выгрузка не дошла до Timeweb',
      reason: result.reason,
      ...common,
    }, { status: 502 })

  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[knowledge-base] обновление упало:', reason)
    return NextResponse.json({
      success: false,
      error: 'Обновление базы знаний не выполнено',
      reason,
    }, { status: 500 })
  }
}