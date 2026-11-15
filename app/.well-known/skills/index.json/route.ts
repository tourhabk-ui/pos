/**
 * GET /.well-known/skills/index.json — список навыков Ведара для ИИ-агентов
 * (#3408): имя, описание и адрес SKILL.md (lib/agent/vedar-skill).
 */
import { NextResponse } from 'next/server';
import { vedarSkillsIndex } from '@/lib/agent/vedar-skill';

export async function GET() {
  return NextResponse.json(vedarSkillsIndex(), {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
