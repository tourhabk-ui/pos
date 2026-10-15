/**
 * GET /api/widget/partner/[partnerId]
 * Публичный: оформление виджета партнёра (имя, логотип, цвет, приветствие,
 * вступление формы).
 *
 * Аудит 15.10, WID-lang: ошибки — по-русски (были 'Partner not found' и
 * 'Invalid partnerId'); заготовка приветствия — из словаря виджета
 * (lib/embed/widget-i18n), чтобы окно узнало её и показало посетителю на его
 * языке, а приветствие, заданное партнёром, оставило как есть.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { safeMsg } from '@/lib/errors/sanitize';
import { leadFormIntro, widgetStyle } from '@/lib/embed/widget-style';
import { WIDGET_TEXTS } from '@/lib/embed/widget-i18n';

export const dynamic = 'force-dynamic';

interface PartnerWidgetRow {
  name: string;
  category: string;
  short_description: string | null;
  logo_image: string | null;
  widget_config: Record<string, unknown>;
  widget_domains: string[];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ partnerId: string }> }
) {
  try {
    const { partnerId } = await params;

    if (!partnerId || partnerId.length > 100) {
      return NextResponse.json(
        { success: false, error: 'Некорректный партнёр' },
        { status: 400 }
      );
    }

    const result = await query<PartnerWidgetRow>(
      `SELECT name, category, short_description, logo_image, widget_config, widget_domains
       FROM partners
       WHERE slug = $1 AND widget_enabled = true
       LIMIT 1`,
      [partnerId]
    );

    const partner = result.rows[0];
    if (!partner) {
      return NextResponse.json(
        { success: false, error: 'Виджет партнёра не найден или выключен' },
        { status: 404 }
      );
    }

    const config = partner.widget_config as Record<string, string>;
    // Цвет и вступление формы — тем же правилом, что кнопка lead.js: цвет
    // проверен как hex, заготовка 142 (#D44A0C ниже AA) читается как «не
    // задано» (находка аудита 15.10 WID-config).
    const cfg: Record<string, unknown> = config ?? {};

    // CORS headers for widget domains
    const origin = request.headers.get('origin');
    const headers: Record<string, string> = {};
    if (origin) {
      try {
        const originHost = new URL(origin).hostname;
        const isAllowed = partner.widget_domains.some(d => {
          const clean = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          return originHost === clean || originHost.endsWith(`.${clean}`);
        });
        if (isAllowed) {
          headers['Access-Control-Allow-Origin'] = origin;
        }
      } catch {
        // Invalid origin
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        name: partner.name,
        category: partner.category,
        description: partner.short_description,
        logo: partner.logo_image,
        greeting: config?.greeting || WIDGET_TEXTS.ru.defaultGreeting(partner.name),
        theme: config?.theme || 'auto',
        accentColor: widgetStyle(cfg).accent,
        // Вступление ФОРМЫ заявки — отдельно от приветствия чата: над полями
        // имени и телефона чатовое «спрашивайте» неуместно.
        formIntro: leadFormIntro(cfg),
      },
    }, { headers });
  } catch (error: unknown) {
    const msg = safeMsg(error);
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки конфигурации', details: msg },
      { status: 500 }
    );
  }
}
