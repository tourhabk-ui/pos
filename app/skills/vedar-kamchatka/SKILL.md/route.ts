/**
 * GET /skills/vedar-kamchatka/SKILL.md — навык Ведара для ИИ-агентов
 * (Agent Skill, #3408). Текст — lib/agent/vedar-skill: адреса, команда
 * подключения и правило оплаты оттуда же, откуда у сервера MCP.
 *
 * Статика без личных данных: кэш на час, индексировать можно (ссылка из
 * /llms.txt и /mcp). Исключение из общего no-store — в next.config.js.
 */
import { NextResponse } from 'next/server';
import { vedarSkillMarkdown } from '@/lib/agent/vedar-skill';

export async function GET() {
  return new NextResponse(vedarSkillMarkdown(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Language': 'en',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
