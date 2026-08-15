-- Baseline-схема прод-БД Ведара (задача #57 — бэкап-фактор).
-- Снята 2026-08-15 c /api/cron/schema-snapshot (только pg_catalog, без данных).
-- Сервер: PostgreSQL 18.1 (Ubuntu 18.1-1.pgdg24.04+2) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0, 64-bit
--
-- Назначение: восстановление схемы на ПУСТОЙ базе, когда прод-БД
-- утрачена. НЕ применяется автоматикой миграций (start.js) — только
-- вручную: scripts/bootstrap-from-baseline.js. После применения
-- пометить все миграции применёнными (bootstrap это делает сам).

-- ══ extensions (3) ══════════════════════════════
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ══ enums (5) ══════════════════════════════
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "DateStatus" AS ENUM ('AVAILABLE', 'PARTIAL', 'BOOKED', 'BLOCKED');
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');
CREATE TYPE "Role" AS ENUM ('PARTNER', 'ADMIN');
CREATE TYPE "TourCategory" AS ENUM ('FISHING', 'HIKING', 'VOLCANO', 'SKIING', 'OTHER');

-- ══ sequences (55) ══════════════════════════════
CREATE SEQUENCE IF NOT EXISTS _migrations_id_seq;
CREATE SEQUENCE IF NOT EXISTS accommodation_availability_id_seq;
CREATE SEQUENCE IF NOT EXISTS agent_knowledge_id_seq;
CREATE SEQUENCE IF NOT EXISTS agent_knowledge_links_id_seq;
CREATE SEQUENCE IF NOT EXISTS agent_referral_events_id_seq;
CREATE SEQUENCE IF NOT EXISTS ai_actions_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS booking_change_requests_id_seq;
CREATE SEQUENCE IF NOT EXISTS booking_group_members_id_seq;
CREATE SEQUENCE IF NOT EXISTS booking_waivers_id_seq;
CREATE SEQUENCE IF NOT EXISTS cancellation_policies_id_seq;
CREATE SEQUENCE IF NOT EXISTS channel_orders_id_seq;
CREATE SEQUENCE IF NOT EXISTS contingency_rules_id_seq;
CREATE SEQUENCE IF NOT EXISTS crowd_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS danger_assessments_id_seq;
CREATE SEQUENCE IF NOT EXISTS eco_compensation_claims_id_seq;
CREATE SEQUENCE IF NOT EXISTS eco_ledger_id_seq;
CREATE SEQUENCE IF NOT EXISTS emergency_contacts_id_seq;
CREATE SEQUENCE IF NOT EXISTS external_alerts_id_seq;
CREATE SEQUENCE IF NOT EXISTS faqs_id_seq;
CREATE SEQUENCE IF NOT EXISTS funnel_events_id_seq;
CREATE SEQUENCE IF NOT EXISTS kuzmich_engagement_signals_id_seq;
CREATE SEQUENCE IF NOT EXISTS lead_activity_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS location_real_time_status_id_seq;
CREATE SEQUENCE IF NOT EXISTS location_safety_profile_id_seq;
CREATE SEQUENCE IF NOT EXISTS loyalty_levels_id_seq;
CREATE SEQUENCE IF NOT EXISTS mcp_tool_calls_id_seq;
CREATE SEQUENCE IF NOT EXISTS octo_booking_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS octo_webhook_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS operator_ai_actions_id_seq;
CREATE SEQUENCE IF NOT EXISTS operator_ai_config_id_seq;
CREATE SEQUENCE IF NOT EXISTS operator_bookings_id_seq;
CREATE SEQUENCE IF NOT EXISTS operator_staff_id_seq;
CREATE SEQUENCE IF NOT EXISTS operator_tour_reviews_id_seq;
CREATE SEQUENCE IF NOT EXISTS operator_tours_id_seq;
CREATE SEQUENCE IF NOT EXISTS operator_vehicles_id_seq;
CREATE SEQUENCE IF NOT EXISTS page_views_id_seq;
CREATE SEQUENCE IF NOT EXISTS parks_id_seq;
CREATE SEQUENCE IF NOT EXISTS rag_quality_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS refund_requests_id_seq;
CREATE SEQUENCE IF NOT EXISTS road_graph_edges_id_seq;
CREATE SEQUENCE IF NOT EXISTS road_graph_imports_id_seq;
CREATE SEQUENCE IF NOT EXISTS route_subcategories_id_seq;
CREATE SEQUENCE IF NOT EXISTS route_tags_id_seq;
CREATE SEQUENCE IF NOT EXISTS route_waypoints_id_seq;
CREATE SEQUENCE IF NOT EXISTS smart_notifications_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS stakeholder_wishes_id_seq;
CREATE SEQUENCE IF NOT EXISTS tg_conversations_id_seq;
CREATE SEQUENCE IF NOT EXISTS tg_ratings_id_seq;
CREATE SEQUENCE IF NOT EXISTS tour_availability_id_seq;
CREATE SEQUENCE IF NOT EXISTS tour_options_id_seq;
CREATE SEQUENCE IF NOT EXISTS tour_pricing_rules_id_seq;
CREATE SEQUENCE IF NOT EXISTS tour_transfer_requests_id_seq;
CREATE SEQUENCE IF NOT EXISTS tourist_incidents_id_seq;
CREATE SEQUENCE IF NOT EXISTS user_ai_memory_id_seq;
CREATE SEQUENCE IF NOT EXISTS weather_alerts_id_seq;

-- ══ tables (202) ══════════════════════════════
CREATE TABLE IF NOT EXISTS _agent_route_knowledge_legacy (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  route_dedupe_key text NOT NULL,
  route_id uuid,
  category text NOT NULL,
  title text NOT NULL,
  description text,
  lat numeric(10,7),
  lng numeric(11,7),
  source_url text,
  source_name text,
  search_text text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  source_updated_at timestamp with time zone,
  last_synced_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  is_visible boolean NOT NULL DEFAULT false,
  location_type text,
  activity_type text,
  kuzmich_review text,
  zone character varying(50),
  kind character varying(20) NOT NULL DEFAULT 'place'::character varying
);
CREATE TABLE IF NOT EXISTS _migration_failures (
  name text NOT NULL,
  error text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  first_failed_at timestamp with time zone DEFAULT now(),
  last_failed_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS _migrations (
  id integer NOT NULL DEFAULT nextval('_migrations_id_seq'::regclass),
  name character varying(255) NOT NULL,
  applied_at timestamp without time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS _route_description_cache_legacy (
  route_id integer NOT NULL,
  description text NOT NULL,
  model text NOT NULL DEFAULT 'editor-agent'::text,
  generated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accommodation_assets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  accommodation_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accommodation_availability (
  id bigint NOT NULL DEFAULT nextval('accommodation_availability_id_seq'::regclass),
  accommodation_id uuid NOT NULL,
  room_id uuid,
  date date NOT NULL,
  price_override numeric(10,2),
  available_rooms integer,
  is_blocked boolean NOT NULL DEFAULT false,
  block_reason text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accommodation_bookings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  accommodation_id uuid,
  room_id uuid,
  check_in_date date NOT NULL,
  check_out_date date NOT NULL,
  nights integer NOT NULL,
  adults integer NOT NULL,
  children integer DEFAULT 0,
  room_price_per_night numeric(10,2) NOT NULL,
  total_price numeric(10,2) NOT NULL,
  currency character varying(3) DEFAULT 'RUB'::character varying,
  status character varying(20) DEFAULT 'pending'::character varying,
  payment_status character varying(20) DEFAULT 'pending'::character varying,
  special_requests text,
  guest_notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  refund_amount numeric(10,2),
  refund_percent integer,
  refund_reason text,
  cancelled_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS accommodation_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  accommodation_id uuid,
  booking_id uuid,
  cleanliness_rating integer,
  service_rating integer,
  location_rating integer,
  value_rating integer,
  overall_rating integer NOT NULL,
  title character varying(255),
  comment text,
  is_verified boolean DEFAULT false,
  is_visible boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accommodation_rooms (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  accommodation_id uuid,
  name character varying(255) NOT NULL,
  room_type character varying(50) NOT NULL,
  description text,
  size_sqm integer,
  max_guests integer NOT NULL,
  beds_configuration jsonb,
  amenities jsonb DEFAULT '[]'::jsonb,
  view character varying(50),
  available_rooms integer NOT NULL,
  price_per_night numeric(10,2) NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accommodations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  partner_id uuid,
  name character varying(255) NOT NULL,
  type character varying(50) NOT NULL,
  description text,
  short_description character varying(500),
  address character varying(500) NOT NULL,
  coordinates jsonb NOT NULL,
  location_zone character varying(100),
  star_rating integer,
  total_rooms integer NOT NULL,
  check_in_time time without time zone DEFAULT '14:00:00'::time without time zone,
  check_out_time time without time zone DEFAULT '12:00:00'::time without time zone,
  amenities jsonb DEFAULT '[]'::jsonb,
  languages jsonb DEFAULT '["ru"]'::jsonb,
  price_per_night_from numeric(10,2) NOT NULL,
  price_per_night_to numeric(10,2),
  currency character varying(3) DEFAULT 'RUB'::character varying,
  rating numeric(3,2) DEFAULT 0,
  review_count integer DEFAULT 0,
  is_active boolean DEFAULT true,
  is_verified boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  cancellation_policy text
);
CREATE TABLE IF NOT EXISTS accounts (
  id text NOT NULL,
  "userId" text NOT NULL,
  type text NOT NULL,
  provider text NOT NULL,
  "providerAccountId" text NOT NULL,
  refresh_token text,
  access_token text,
  expires_at integer,
  token_type text,
  scope text,
  id_token text,
  session_state text
);
CREATE TABLE IF NOT EXISTS activities (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  key text NOT NULL,
  title text NOT NULL,
  icon_bytes bytea,
  icon_mime text,
  icon_sha256 text,
  icon_url text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  partner character varying(50) NOT NULL,
  source character varying(100) NOT NULL,
  sub_id character varying(100),
  referrer character varying(500),
  ip_addr character varying(45),
  clicked_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  partner character varying(50) NOT NULL,
  amount numeric(10,2) NOT NULL,
  currency character varying(3) DEFAULT 'USD'::character varying,
  status character varying(20) DEFAULT 'pending'::character varying,
  tp_click_id character varying(100),
  received_at timestamp with time zone DEFAULT now(),
  paid_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_actions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id character varying(50) NOT NULL,
  tool_name character varying(100) NOT NULL,
  permission character varying(20) NOT NULL DEFAULT 'auto'::character varying,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb DEFAULT '{}'::jsonb,
  status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  error_message text,
  approval_id uuid,
  measured_at timestamp with time zone,
  measurement jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS agent_approvals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  action_type character varying(100) NOT NULL,
  description text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  requested_by character varying(100),
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  review_notes text,
  expires_at timestamp with time zone,
  topic text,
  executor_agent_id character varying(50),
  executor_name character varying(100),
  execution_status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  execution_notes text,
  due_date date,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  retry_count integer NOT NULL DEFAULT 0,
  approved_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS agent_bookings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  client_id uuid NOT NULL,
  tour_id bigint NOT NULL,
  booking_date timestamp without time zone DEFAULT now(),
  tour_date date NOT NULL,
  guests_count integer DEFAULT 1,
  total_price numeric(12,2) DEFAULT 0,
  agent_commission numeric(12,2) DEFAULT 0,
  commission_rate numeric(5,2) DEFAULT 10,
  commission_status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  payment_status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  special_requests text,
  voucher_code character varying(50),
  discount_amount numeric(12,2) DEFAULT 0,
  notes text,
  created_via character varying(50) DEFAULT 'agent_hub'::character varying,
  deleted_at timestamp without time zone,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_clients (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  name character varying(255) NOT NULL,
  email character varying(255),
  phone character varying(50),
  company character varying(255),
  total_bookings integer DEFAULT 0,
  total_spent numeric(12,2) DEFAULT 0,
  last_booking timestamp without time zone,
  status character varying(20) NOT NULL DEFAULT 'prospect'::character varying,
  notes text,
  tags jsonb DEFAULT '[]'::jsonb,
  source character varying(50) DEFAULT 'direct'::character varying,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_commissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  rate numeric(5,2) NOT NULL,
  status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  paid_at timestamp without time zone,
  payout_reference character varying(255),
  notes text,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_experiments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  intent text,
  variant_a jsonb NOT NULL DEFAULT '{}'::jsonb,
  variant_b jsonb NOT NULL DEFAULT '{}'::jsonb,
  metric text NOT NULL DEFAULT 'success_rate'::text,
  status text NOT NULL DEFAULT 'running'::text,
  winner text,
  results jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_knowledge (
  id integer NOT NULL DEFAULT nextval('agent_knowledge_id_seq'::regclass),
  slug text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  compiled_truth text NOT NULL DEFAULT ''::text,
  timeline text NOT NULL DEFAULT ''::text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_id text,
  edit_count integer NOT NULL DEFAULT 0,
  search_vector tsvector DEFAULT ((setweight(to_tsvector('russian'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('russian'::regconfig, COALESCE(compiled_truth, ''::text)), 'B'::"char")) || setweight(to_tsvector('russian'::regconfig, COALESCE(timeline, ''::text)), 'C'::"char")),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_knowledge_links (
  id integer NOT NULL DEFAULT nextval('agent_knowledge_links_id_seq'::regclass),
  from_slug text NOT NULL,
  to_slug text NOT NULL,
  link_type text NOT NULL DEFAULT ''::text,
  context text NOT NULL DEFAULT ''::text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_market_payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  payment_id character varying(36) NOT NULL DEFAULT (gen_random_uuid())::text,
  query_type character varying(50) NOT NULL DEFAULT 'routes'::character varying,
  query_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_usdt numeric(10,4) NOT NULL DEFAULT 0.01,
  wallet_to text NOT NULL,
  tx_id text,
  status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '00:10:00'::interval),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  confirmed_at timestamp with time zone,
  confirmed_by text
);
CREATE TABLE IF NOT EXISTS agent_memory (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id character varying(50) NOT NULL,
  memory_type character varying(50) NOT NULL,
  key character varying(200) NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(3,2) DEFAULT 1.00,
  source character varying(100),
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  memory_tier smallint NOT NULL DEFAULT 2,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  source_meeting_id text,
  edit_count integer NOT NULL DEFAULT 0,
  last_edited_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS agent_memory_edits (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL,
  agent_id text NOT NULL,
  old_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  edited_by text,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_referral_events (
  id bigint NOT NULL DEFAULT nextval('agent_referral_events_id_seq'::regclass),
  link_id uuid NOT NULL,
  event_type character varying(20) NOT NULL,
  booking_id bigint,
  ip character varying(45),
  user_agent text,
  created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_referral_links (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  tour_id bigint,
  code character varying(32) NOT NULL,
  clicks integer DEFAULT 0,
  conversions integer DEFAULT 0,
  commission_rate numeric(5,2) DEFAULT 10,
  expires_at timestamp without time zone,
  is_active boolean DEFAULT true,
  created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_run_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id character varying(50) NOT NULL,
  status character varying(20) NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone NOT NULL DEFAULT now(),
  duration_ms integer,
  items_processed integer,
  items_created integer,
  errors_count integer NOT NULL DEFAULT 0,
  error_msg text,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  prompt_tokens integer,
  completion_tokens integer,
  llm_calls integer,
  estimated_cost_usd numeric(10,6)
);
CREATE TABLE IF NOT EXISTS agent_sdk_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  intent text NOT NULL,
  variant text NOT NULL DEFAULT 'classic'::text,
  experiment_id uuid,
  tool_calls_count integer NOT NULL DEFAULT 0,
  iterations integer NOT NULL DEFAULT 0,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  outcome text,
  final_response text,
  tool_calls_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_tools (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id character varying(50) NOT NULL,
  tool_name character varying(100) NOT NULL,
  description text NOT NULL,
  permission character varying(20) NOT NULL DEFAULT 'auto'::character varying,
  cooldown_ms integer DEFAULT 0,
  enabled boolean DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_actions_log (
  id bigint NOT NULL DEFAULT nextval('ai_actions_log_id_seq'::regclass),
  action_type character varying(100) NOT NULL,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  provider character varying(50),
  user_id integer,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(10,6)
);
CREATE TABLE IF NOT EXISTS ai_route_images (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL,
  image_data bytea NOT NULL,
  mime_type character varying(20) DEFAULT 'image/jpeg'::character varying,
  prompt text,
  model character varying(100) DEFAULT 'pollinations-flux'::character varying,
  width integer DEFAULT 1280,
  height integer DEFAULT 720,
  created_at timestamp with time zone DEFAULT now(),
  photo_verified boolean,
  ai_audit_reason text,
  ai_audit_at timestamp with time zone,
  manually_reviewed boolean DEFAULT false,
  source_url text,
  author text,
  license text,
  license_url text
);
CREATE TABLE IF NOT EXISTS approval_execution_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL,
  actor character varying(100) NOT NULL,
  event_type character varying(50) NOT NULL,
  message text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS articles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug character varying(80) NOT NULL,
  title text NOT NULL,
  body text,
  source_url text,
  source_name character varying(120),
  topic character varying(60),
  is_visible boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assets (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  url text NOT NULL,
  mime_type character varying(100) NOT NULL,
  sha256 character varying(64) NOT NULL,
  size bigint NOT NULL,
  width integer,
  height integer,
  alt text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  entity_type character varying(50) NOT NULL,
  entity_id uuid NOT NULL,
  action character varying(50) NOT NULL,
  data jsonb,
  ip_address character varying(50),
  user_agent text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  action character varying(100) NOT NULL,
  resource_type character varying(50),
  resource_id uuid,
  details jsonb DEFAULT '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS board_meeting_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  topic text,
  initiated_by uuid,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  consensus text,
  proposals_count integer NOT NULL DEFAULT 0,
  approved_count integer NOT NULL DEFAULT 0,
  status character varying(20) NOT NULL DEFAULT 'running'::character varying
);
CREATE TABLE IF NOT EXISTS booking_change_requests (
  id integer NOT NULL DEFAULT nextval('booking_change_requests_id_seq'::regclass),
  partner_id uuid NOT NULL,
  booking_id integer NOT NULL,
  old_tour_id integer,
  old_date date,
  old_price numeric(10,2),
  new_tour_id integer NOT NULL,
  new_date date NOT NULL,
  new_price numeric(10,2),
  price_diff numeric(10,2),
  payment_link text,
  refund_request_id integer,
  status text NOT NULL DEFAULT 'pending'::text,
  notes text,
  initiated_by integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS booking_group_members (
  id integer NOT NULL DEFAULT nextval('booking_group_members_id_seq'::regclass),
  booking_id integer NOT NULL,
  full_name text NOT NULL,
  phone text,
  passport_number text,
  emergency_contact_name text,
  emergency_contact_phone text,
  dietary_restrictions text,
  medical_notes text,
  created_at timestamp with time zone DEFAULT now(),
  passport_encrypted bytea,
  medical_encrypted bytea,
  consent_given_at timestamp with time zone,
  consent_expires_at timestamp with time zone,
  delete_after date,
  mchs_notified_at timestamp with time zone,
  mchs_reference text
);
CREATE TABLE IF NOT EXISTS booking_transfers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  booking_id uuid,
  from_operator_id uuid,
  to_operator_id uuid,
  commission_percent numeric(5,2) NOT NULL,
  status character varying(20) DEFAULT 'pending'::character varying,
  message text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS booking_waivers (
  id bigint NOT NULL DEFAULT nextval('booking_waivers_id_seq'::regclass),
  booking_id bigint NOT NULL,
  user_id uuid NOT NULL,
  signer_name character varying(255) NOT NULL,
  risks_acknowledged boolean NOT NULL DEFAULT false,
  fit_to_participate boolean NOT NULL DEFAULT false,
  medical_conditions text,
  allergies text,
  emergency_contact_name character varying(255) NOT NULL,
  emergency_contact_phone character varying(50) NOT NULL,
  signed_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bookings (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  tour_id uuid,
  date date NOT NULL,
  start_date date DEFAULT CURRENT_DATE,
  participants integer NOT NULL,
  guests_count integer DEFAULT 1,
  total_price numeric(10,2) NOT NULL,
  status character varying(20) DEFAULT 'pending'::character varying,
  payment_status character varying(20) DEFAULT 'pending'::character varying,
  special_requests text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  departure_id uuid
);
CREATE TABLE IF NOT EXISTS cancellation_policies (
  id integer NOT NULL DEFAULT nextval('cancellation_policies_id_seq'::regclass),
  partner_id uuid NOT NULL,
  tour_id integer,
  days_before integer NOT NULL,
  refund_percent numeric(5,2) NOT NULL,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS channel_orders (
  id bigint NOT NULL DEFAULT nextval('channel_orders_id_seq'::regclass),
  channel character varying(30) NOT NULL,
  external_id character varying(255) NOT NULL,
  tour_id bigint,
  status character varying(30) NOT NULL DEFAULT 'new'::character varying,
  tourist_name character varying(255),
  tourist_email character varying(255),
  tourist_phone character varying(30),
  participants integer NOT NULL DEFAULT 1,
  booking_date date,
  amount numeric(10,2),
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  session_id uuid,
  role character varying(20) NOT NULL,
  content text NOT NULL,
  "timestamp" timestamp with time zone DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  context jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  session_id text,
  role text NOT NULL DEFAULT 'tourist'::text,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  user_message_count integer NOT NULL DEFAULT 0,
  interests_encrypted text,
  is_authenticated boolean NOT NULL DEFAULT false,
  referrer_source character varying(255),
  utm_source character varying(100),
  utm_medium character varying(100),
  utm_campaign character varying(100)
);
CREATE TABLE IF NOT EXISTS client_communications (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  booking_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  message text NOT NULL,
  is_read boolean DEFAULT false,
  is_system_message boolean DEFAULT false,
  attachments jsonb DEFAULT '[]'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  read_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS collections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug character varying(120) NOT NULL,
  title character varying(255) NOT NULL,
  description text,
  cover_image text,
  place_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  route_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  tags text[] NOT NULL DEFAULT '{}'::text[],
  is_public boolean NOT NULL DEFAULT true,
  created_by uuid,
  view_count integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  rule_kind character varying(10),
  rule_location_type character varying(60),
  rule_activity_type character varying(60),
  rule_difficulty character varying(20),
  rule_query character varying(200),
  rule_limit integer DEFAULT 60,
  accent character varying(20) DEFAULT 'accent'::character varying
);
CREATE TABLE IF NOT EXISTS commission_payouts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  total_amount numeric(12,2) NOT NULL,
  status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  payment_method character varying(50),
  payout_date timestamp without time zone,
  notes text,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contingency_rules (
  id bigint NOT NULL DEFAULT nextval('contingency_rules_id_seq'::regclass),
  operator_id uuid NOT NULL,
  primary_tour_id bigint NOT NULL,
  alternative_tour_id bigint NOT NULL,
  discount_percent integer DEFAULT 0,
  auto_refund_percent integer DEFAULT 0,
  weather_conditions character varying(255),
  available_from date,
  available_to date,
  priority integer DEFAULT 1,
  is_active boolean DEFAULT true,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  deleted_at timestamp without time zone
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  conversation_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  content text NOT NULL,
  message_type character varying(20) DEFAULT 'text'::character varying,
  attachments jsonb DEFAULT '[]'::jsonb,
  is_deleted boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversation_participants (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role character varying(30) NOT NULL,
  joined_at timestamp with time zone DEFAULT now(),
  last_read_at timestamp with time zone,
  is_muted boolean DEFAULT false,
  consent_given boolean DEFAULT true
);
CREATE TABLE IF NOT EXISTS conversations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  type character varying(20) NOT NULL DEFAULT 'direct'::character varying,
  subject character varying(255),
  booking_id uuid,
  tour_id uuid,
  created_by uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crowd_log (
  id bigint NOT NULL DEFAULT nextval('crowd_log_id_seq'::regclass),
  agent_route_id uuid,
  group_id uuid,
  group_size integer,
  guide_id uuid,
  checkin_at timestamp without time zone,
  checkout_at timestamp without time zone,
  duration_hours integer,
  incidents text,
  guide_notes text,
  safety_score integer,
  created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS danger_assessments (
  id bigint NOT NULL DEFAULT nextval('danger_assessments_id_seq'::regclass),
  zone text NOT NULL,
  assessed_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  risk_score integer NOT NULL,
  risk_level text NOT NULL,
  threat_types text[] NOT NULL DEFAULT '{}'::text[],
  tourists_at_risk integer NOT NULL DEFAULT 0,
  active_tours_count integer NOT NULL DEFAULT 0,
  confidence numeric(3,2),
  similar_event text,
  recommended_action text,
  analysis_text text NOT NULL,
  seismic_events_count integer DEFAULT 0,
  volcanic_alerts_count integer DEFAULT 0,
  max_magnitude numeric(4,2),
  max_ash_height_m integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS driver_documents (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  driver_id uuid NOT NULL,
  type character varying(50) NOT NULL,
  name character varying(255) NOT NULL,
  file_url text NOT NULL,
  document_number character varying(100),
  issue_date date,
  expiry_date date,
  issuing_authority character varying(255),
  status character varying(20) DEFAULT 'valid'::character varying,
  notes text,
  uploaded_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS driver_schedules (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  driver_id uuid NOT NULL,
  vehicle_id uuid,
  date date NOT NULL,
  start_time time without time zone NOT NULL,
  end_time time without time zone NOT NULL,
  location character varying(255),
  transfer_id uuid,
  type character varying(50) DEFAULT 'available'::character varying,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drivers (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  operator_id uuid NOT NULL,
  first_name character varying(255) NOT NULL,
  last_name character varying(255) NOT NULL,
  phone character varying(50) NOT NULL,
  email character varying(255),
  date_of_birth date,
  license_number character varying(100) NOT NULL,
  license_category character varying(50),
  license_issue_date date,
  license_expiry date NOT NULL,
  experience integer DEFAULT 0,
  languages jsonb DEFAULT '[]'::jsonb,
  rating numeric(3,2) DEFAULT 0.0,
  total_trips integer DEFAULT 0,
  completed_trips integer DEFAULT 0,
  cancelled_trips integer DEFAULT 0,
  status character varying(50) DEFAULT 'active'::character varying,
  vehicle_id uuid,
  emergency_contact jsonb,
  address text,
  city character varying(100),
  postal_code character varying(20),
  country character varying(100) DEFAULT 'Russia'::character varying,
  hire_date date,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS eco_achievements (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying(255) NOT NULL,
  description text,
  points integer NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS eco_balances (
  account text NOT NULL,
  balance bigint NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS eco_compensation_claims (
  id bigint NOT NULL DEFAULT nextval('eco_compensation_claims_id_seq'::regclass),
  ledger_id bigint NOT NULL,
  sink text NOT NULL,
  eco_amount bigint NOT NULL,
  rub_amount numeric(12,2) NOT NULL,
  payer text NOT NULL,
  operator_id bigint,
  status text NOT NULL DEFAULT 'pending'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  settled_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS eco_ledger (
  id bigint NOT NULL DEFAULT nextval('eco_ledger_id_seq'::regclass),
  debit_account text NOT NULL,
  credit_account text NOT NULL,
  amount bigint NOT NULL,
  operation text NOT NULL,
  source text NOT NULL,
  source_ref text,
  description text NOT NULL,
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS eco_points (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying(255) NOT NULL,
  description text,
  coordinates jsonb NOT NULL,
  category character varying(50) NOT NULL,
  points integer NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name character varying(255) NOT NULL,
  subject character varying(500) NOT NULL,
  type character varying(50) NOT NULL,
  html_content text NOT NULL,
  text_content text,
  variables jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id bigint NOT NULL DEFAULT nextval('emergency_contacts_id_seq'::regclass),
  zone character varying(50),
  contact_type character varying(50),
  name character varying(255),
  phone character varying(20),
  location_lat numeric(9,6),
  location_lng numeric(9,6),
  service_hours text,
  capabilities text[],
  updated_at timestamp without time zone DEFAULT now(),
  purpose character varying(30),
  source character varying(30),
  source_url text,
  verified_at timestamp with time zone,
  verified_by text,
  notes text
);
CREATE TABLE IF NOT EXISTS evo_agent_state (
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evo_evolution_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  issue_id uuid,
  action character varying(50) NOT NULL,
  status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  pr_url text,
  commit_hash text,
  diff_summary text,
  review_notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS evo_feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  evolution_id uuid,
  outcome character varying(20) NOT NULL,
  impact_score integer,
  human_notes text,
  ai_learning text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evo_growth_issues (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scan_id uuid,
  category character varying(50) NOT NULL,
  severity character varying(20) NOT NULL DEFAULT 'medium'::character varying,
  file_path text,
  line_number integer,
  title text NOT NULL,
  description text,
  suggestion text,
  ai_proposed_diff text,
  status character varying(20) NOT NULL DEFAULT 'open'::character varying,
  fixed_commit text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone,
  github_issue_url text,
  model text,
  edge character varying(64),
  fault_side character varying(32)
);
CREATE TABLE IF NOT EXISTS evo_growth_scans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scan_type character varying(50) NOT NULL DEFAULT 'full'::character varying,
  status character varying(20) NOT NULL DEFAULT 'running'::character varying,
  issues_found integer NOT NULL DEFAULT 0,
  issues_fixed integer NOT NULL DEFAULT 0,
  duration_ms integer,
  summary text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evo_review_ledger (
  file_path text NOT NULL,
  last_reviewed_at timestamp with time zone,
  review_count integer DEFAULT 0,
  last_findings integer DEFAULT 0,
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS external_alerts (
  id bigint NOT NULL DEFAULT nextval('external_alerts_id_seq'::regclass),
  alert_type character varying(50),
  severity integer,
  title character varying(255),
  description text,
  affected_zones text[],
  affected_locations uuid[] DEFAULT ARRAY[]::uuid[],
  created_at timestamp without time zone DEFAULT now(),
  expires_at timestamp without time zone,
  source_url character varying(500),
  external_id character varying(100),
  updated_at timestamp without time zone DEFAULT now(),
  push_sent_at timestamp with time zone,
  magnitude numeric(4,1),
  lat numeric(8,5),
  lng numeric(8,5)
);
CREATE TABLE IF NOT EXISTS external_tools (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug character varying(120) NOT NULL,
  name character varying(200) NOT NULL,
  description text NOT NULL DEFAULT ''::text,
  url text NOT NULL,
  category character varying(50) NOT NULL DEFAULT 'other'::character varying,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  is_free boolean NOT NULL DEFAULT true,
  api_available boolean NOT NULL DEFAULT false,
  rating numeric(3,1),
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamp with time zone,
  source character varying(20) NOT NULL DEFAULT 'taaft'::character varying,
  search_vector tsvector,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  verified boolean NOT NULL DEFAULT false,
  click_count integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS faqs (
  id bigint NOT NULL DEFAULT nextval('faqs_id_seq'::regclass),
  question character varying(500) NOT NULL,
  answer text NOT NULL,
  category character varying(100),
  priority integer DEFAULT 50,
  views integer DEFAULT 0,
  helpful integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS funnel_events (
  id bigint NOT NULL DEFAULT nextval('funnel_events_id_seq'::regclass),
  step character varying(40) NOT NULL,
  entity_id text,
  visitor_hash character varying(64),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gear_availability (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  gear_item_id uuid NOT NULL,
  date date NOT NULL,
  total_quantity integer NOT NULL,
  rented_quantity integer DEFAULT 0,
  available_quantity integer NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gear_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  partner_id uuid,
  name character varying(255) NOT NULL,
  description text,
  category character varying(50) NOT NULL,
  subcategory character varying(100),
  brand character varying(100),
  model character varying(100),
  price_per_day numeric(10,2) NOT NULL,
  price_per_week numeric(10,2),
  price_per_month numeric(10,2),
  quantity integer NOT NULL DEFAULT 1,
  available_quantity integer NOT NULL DEFAULT 1,
  deposit_amount numeric(10,2),
  insurance_cost_per_day numeric(10,2),
  images jsonb DEFAULT '[]'::jsonb,
  specifications jsonb DEFAULT '{}'::jsonb,
  features jsonb DEFAULT '[]'::jsonb,
  condition character varying(20) DEFAULT 'excellent'::character varying,
  tags text[] DEFAULT '{}'::text[],
  rating numeric(3,2) DEFAULT 0.0,
  review_count integer DEFAULT 0,
  rental_count integer DEFAULT 0,
  total_revenue numeric(12,2) DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gear_rentals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  gear_id uuid NOT NULL,
  customer_name character varying(255) NOT NULL,
  customer_email character varying(255) NOT NULL,
  customer_phone character varying(50) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  days_count integer NOT NULL,
  insurance boolean DEFAULT false,
  base_price numeric(12,2) NOT NULL,
  insurance_cost numeric(10,2) DEFAULT 0,
  total_price numeric(12,2) NOT NULL,
  comments text,
  status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guide_availability (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  guide_id uuid NOT NULL,
  day_of_week integer NOT NULL,
  start_time time without time zone NOT NULL,
  end_time time without time zone NOT NULL,
  is_available boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guide_certifications (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  guide_id uuid NOT NULL,
  name text NOT NULL,
  issuing_authority text NOT NULL,
  issue_date date,
  expiry_date date,
  certificate_number text,
  document_url text,
  is_verified boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guide_earnings (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  guide_id uuid,
  schedule_id uuid,
  tour_id uuid,
  amount numeric(10,2) NOT NULL,
  commission_rate numeric(5,2) DEFAULT 10.00,
  commission_amount numeric(10,2),
  payment_status character varying(50) DEFAULT 'pending'::character varying,
  payment_date date,
  notes text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guide_groups (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  schedule_id uuid,
  group_name character varying(255),
  participants jsonb DEFAULT '[]'::jsonb,
  emergency_contacts jsonb DEFAULT '[]'::jsonb,
  experience_levels jsonb DEFAULT '{}'::jsonb,
  special_needs text,
  equipment_checklist jsonb DEFAULT '[]'::jsonb,
  status character varying(50) DEFAULT 'forming'::character varying,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guide_reviews (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  guide_id uuid NOT NULL,
  tourist_id uuid,
  booking_id uuid,
  rating integer NOT NULL,
  professionalism_rating integer,
  knowledge_rating integer,
  communication_rating integer,
  comment text,
  guide_reply text,
  guide_reply_at timestamp with time zone,
  is_verified boolean DEFAULT false,
  is_public boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guide_schedule (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  guide_id uuid,
  tour_id uuid,
  tour_date date NOT NULL,
  start_time time without time zone NOT NULL,
  end_time time without time zone,
  meeting_point character varying(500),
  participants_count integer DEFAULT 0,
  max_participants integer,
  status character varying(50) DEFAULT 'scheduled'::character varying,
  weather_conditions jsonb,
  safety_notes text,
  special_requirements text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS intelligence_sources (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  url text NOT NULL,
  source_type character varying(20) NOT NULL DEFAULT 'rss'::character varying,
  domain character varying(50) NOT NULL,
  label text NOT NULL,
  search_query text,
  ai_filter text,
  active boolean NOT NULL DEFAULT true,
  last_fetched_at timestamp with time zone,
  last_error text,
  fetch_error_count integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kamchatka_routes (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  category text NOT NULL,
  title text NOT NULL,
  description text,
  lat numeric(10,7),
  lng numeric(11,7),
  source_url text,
  source_name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  slug text,
  ark_id uuid,
  activity_type character varying(50),
  zone character varying(50),
  geometry jsonb,
  difficulty character varying(50),
  pdf_url text,
  season character varying(100),
  route_type character varying(50),
  hazards text[],
  equipment text[],
  registration_required boolean DEFAULT false,
  flora_fauna text,
  distance_km numeric(8,2),
  elevation_gain_m integer,
  duration_hours numeric(8,2),
  accessibility text,
  mchs_registration_required boolean DEFAULT false,
  mchs_phone character varying(50),
  park_name character varying(255),
  park_approval_url text,
  search_count integer NOT NULL DEFAULT 0,
  is_visible boolean NOT NULL DEFAULT true,
  view_count integer NOT NULL DEFAULT 0,
  kuzmich_review text,
  embedding jsonb,
  official_passport_url text,
  passport_agency character varying(100),
  passport_verified_at timestamp with time zone,
  surface_types text[],
  elevation_loss_m integer,
  elevation_min_m integer,
  elevation_max_m integer,
  duration_days integer
);
CREATE TABLE IF NOT EXISTS kuzmich_engagement_signals (
  id bigint NOT NULL DEFAULT nextval('kuzmich_engagement_signals_id_seq'::regclass),
  user_id uuid NOT NULL,
  tour_id bigint NOT NULL,
  session_id text,
  signal_type text NOT NULL DEFAULT 'viewed'::text,
  pushed_at timestamp without time zone,
  created_at timestamp without time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lead_activity_log (
  id bigint NOT NULL DEFAULT nextval('lead_activity_log_id_seq'::regclass),
  lead_id uuid NOT NULL,
  actor character varying(50) NOT NULL DEFAULT 'system'::character varying,
  action character varying(100) NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lead_followups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  followup_type character varying(50) NOT NULL,
  scheduled_at timestamp with time zone NOT NULL,
  sent_at timestamp with time zone,
  status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  message_text text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lead_proposals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  operator_id uuid,
  primary_tour_id text,
  alt_tour_ids text[] DEFAULT '{}'::text[],
  headline character varying(255) NOT NULL,
  summary text NOT NULL,
  highlights jsonb DEFAULT '[]'::jsonb,
  price_from integer,
  price_to integer,
  duration_days smallint,
  ai_model character varying(100),
  generation_ms integer,
  pdf_url text,
  status character varying(30) DEFAULT 'draft'::character varying,
  sent_at timestamp without time zone,
  accepted_at timestamp without time zone,
  expires_at timestamp without time zone DEFAULT (now() + '7 days'::interval),
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  bull_signals jsonb DEFAULT '[]'::jsonb,
  bear_risks jsonb DEFAULT '[]'::jsonb,
  conversion_prob smallint,
  recommended_action character varying(25) DEFAULT NULL::character varying,
  call_strategy text,
  verdict_urgency character varying(10) DEFAULT NULL::character varying
);
CREATE TABLE IF NOT EXISTS leads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name character varying(120) NOT NULL,
  phone character varying(30) NOT NULL,
  comment text,
  route_id uuid,
  route_title character varying(255),
  source_url character varying(500),
  status character varying(30) NOT NULL DEFAULT 'new'::character varying,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  source_data jsonb,
  notes text,
  ai_score smallint,
  ai_summary text,
  ai_intent jsonb DEFAULT '{}'::jsonb,
  matched_tour_ids text[] DEFAULT '{}'::text[],
  operator_id uuid,
  processed_at timestamp without time zone,
  email character varying(255),
  telegram_chat_id character varying(50),
  group_size smallint DEFAULT 1,
  budget_rub integer,
  desired_dates text,
  proposal_id uuid,
  source_channel character varying(32)
);
CREATE TABLE IF NOT EXISTS legislation_docs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_url text NOT NULL,
  source character varying(100) NOT NULL DEFAULT 'Путешествуем.рф'::character varying,
  title text NOT NULL,
  category character varying(40) NOT NULL DEFAULT 'other'::character varying,
  summary text,
  full_text text,
  effective_date text,
  parsed_at timestamp with time zone NOT NULL DEFAULT now(),
  is_stale boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS llm_usage_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  route text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  agent_id text
);
CREATE TABLE IF NOT EXISTS location_real_time_status (
  id bigint NOT NULL DEFAULT nextval('location_real_time_status_id_seq'::regclass),
  agent_route_id uuid,
  is_open boolean DEFAULT true,
  current_crowds integer DEFAULT 0,
  current_weather jsonb,
  active_alerts text[] DEFAULT ARRAY[]::text[],
  alert_severity integer DEFAULT 0,
  alert_message character varying(500),
  alert_source character varying(50),
  alert_expires_at timestamp without time zone,
  tourists_today integer DEFAULT 0,
  tourists_hour integer DEFAULT 0,
  recommender_status character varying(50) DEFAULT 'green'::character varying,
  updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS location_safety_profile (
  id bigint NOT NULL DEFAULT nextval('location_safety_profile_id_seq'::regclass),
  agent_route_id uuid,
  capacity_per_day integer DEFAULT 50,
  capacity_per_hour integer DEFAULT 20,
  optimal_group_size integer DEFAULT 8,
  open_from_date date,
  open_to_date date,
  closed_reason character varying(255),
  hazard_types text[] DEFAULT ARRAY[]::text[],
  difficulty_level integer DEFAULT 2,
  altitude_m integer,
  terrain_type character varying(50),
  road_type character varying(50) DEFAULT 'gravel'::character varying,
  road_accessibility integer DEFAULT 50,
  altitude_diff_m integer,
  distance_km numeric(8,2),
  nearest_medical_km numeric(8,2),
  emergency_access text,
  phone_ranger_mches character varying(20),
  sat_communicator_required boolean DEFAULT false,
  rules_required text,
  weather_threshold jsonb,
  updated_at timestamp without time zone DEFAULT now(),
  required_gear text[],
  connectivity jsonb,
  registration_required boolean NOT NULL DEFAULT false,
  medical_info text,
  tsunami_risk boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS loyalty_levels (
  id integer NOT NULL DEFAULT nextval('loyalty_levels_id_seq'::regclass),
  name character varying(50) NOT NULL,
  min_spent numeric(10,2) NOT NULL,
  discount_percentage numeric(5,4) NOT NULL,
  earn_multiplier numeric(3,2) NOT NULL DEFAULT 1.00,
  benefits text[],
  color character varying(7),
  is_active boolean DEFAULT true
);
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id character varying(50) NOT NULL,
  user_id uuid NOT NULL,
  type character varying(20) NOT NULL,
  amount integer NOT NULL,
  source character varying(30) NOT NULL DEFAULT 'booking'::character varying,
  description text NOT NULL,
  booking_id character varying(50),
  created_at timestamp without time zone DEFAULT now(),
  expires_at timestamp without time zone
);
CREATE TABLE IF NOT EXISTS max_login_sessions (
  nonce text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  max_user_id bigint,
  max_name text,
  max_username text,
  consumed boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  authenticated_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL
);
CREATE TABLE IF NOT EXISTS mchs_group_registrations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  operator_partner_id uuid,
  operator_user_id uuid,
  group_name text NOT NULL,
  group_members jsonb NOT NULL DEFAULT '[]'::jsonb,
  route_description text NOT NULL,
  route_region text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  guide_contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  emergency_contacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  participant_count integer NOT NULL DEFAULT 1,
  status character varying(20) NOT NULL DEFAULT 'submitted'::character varying,
  mchs_request_id text,
  mchs_response jsonb,
  last_error text,
  submitted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mchs_registrations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  booking_id uuid,
  operator_id uuid,
  group_composition jsonb NOT NULL,
  route text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  guide_contacts jsonb NOT NULL,
  emergency_contacts jsonb NOT NULL,
  status character varying(20) DEFAULT 'pending'::character varying,
  mchs_reference text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id bigint NOT NULL DEFAULT nextval('mcp_tool_calls_id_seq'::regclass),
  tool character varying(64) NOT NULL,
  ok boolean NOT NULL,
  error_kind character varying(32),
  duration_ms integer,
  caller_hash character varying(64),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS message_templates (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name character varying(255) NOT NULL,
  subject character varying(255),
  content text NOT NULL,
  template_type character varying(50),
  variables jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  usage_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notification_log (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  notification_id uuid,
  channel character varying(20) NOT NULL,
  status character varying(20) DEFAULT 'pending'::character varying,
  sent_at timestamp with time zone,
  delivered_at timestamp with time zone,
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid NOT NULL,
  email_enabled boolean DEFAULT true,
  push_enabled boolean DEFAULT true,
  sms_enabled boolean DEFAULT false,
  new_booking boolean DEFAULT true,
  booking_confirmed boolean DEFAULT true,
  booking_cancelled boolean DEFAULT true,
  new_review boolean DEFAULT true,
  payment_received boolean DEFAULT true,
  system_updates boolean DEFAULT true,
  marketing boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  type character varying(50) NOT NULL,
  title character varying(255) NOT NULL,
  message text NOT NULL,
  data jsonb DEFAULT '{}'::jsonb,
  is_read boolean DEFAULT false,
  is_archived boolean DEFAULT false,
  priority character varying(20) DEFAULT 'normal'::character varying,
  action_url text,
  created_at timestamp with time zone DEFAULT now(),
  read_at timestamp with time zone,
  expires_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS octo_api_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name character varying(255) NOT NULL,
  api_key character varying(128) NOT NULL,
  operator_id uuid,
  can_read_products boolean DEFAULT true,
  can_read_availability boolean DEFAULT true,
  can_create_bookings boolean DEFAULT true,
  rate_limit_per_minute integer DEFAULT 60,
  is_active boolean DEFAULT true,
  last_used_at timestamp without time zone,
  created_at timestamp without time zone DEFAULT now(),
  created_by uuid,
  notes text,
  webhook_url character varying(500),
  webhook_secret character varying(128)
);
CREATE TABLE IF NOT EXISTS octo_booking_log (
  id bigint NOT NULL DEFAULT nextval('octo_booking_log_id_seq'::regclass),
  booking_id bigint NOT NULL,
  action character varying(50) NOT NULL,
  api_key_id uuid,
  request_body jsonb,
  response_body jsonb,
  created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS octo_webhook_log (
  id bigint NOT NULL DEFAULT nextval('octo_webhook_log_id_seq'::regclass),
  api_key_id uuid NOT NULL,
  booking_id bigint,
  event character varying(50) NOT NULL,
  url character varying(500) NOT NULL,
  status_code integer,
  success boolean NOT NULL DEFAULT false,
  request_body jsonb,
  response_body text,
  duration_ms integer,
  created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS official_registry_operators (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_normalized text NOT NULL,
  inn character varying(20),
  ogrn character varying(20),
  registry_number character varying(120),
  region character varying(160),
  registry_status character varying(80),
  contacts jsonb,
  source_url text,
  registry_date date,
  matched_partner_id uuid,
  match_method character varying(20),
  raw jsonb,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  scraped_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operator_ai_actions (
  id integer NOT NULL DEFAULT nextval('operator_ai_actions_id_seq'::regclass),
  partner_id uuid NOT NULL,
  actor_staff_id integer,
  action_type text NOT NULL,
  entity_type text,
  entity_id integer,
  payload jsonb,
  requires_approval boolean DEFAULT false,
  approved_by integer,
  approved_at timestamp with time zone,
  status text DEFAULT 'executed'::text,
  max_message_id text,
  created_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS operator_ai_config (
  id integer NOT NULL DEFAULT nextval('operator_ai_config_id_seq'::regclass),
  partner_id uuid NOT NULL,
  ai_name text DEFAULT 'Ассистент'::text,
  ai_persona text,
  ai_instructions text,
  enabled_tools text[] DEFAULT ARRAY['get_tours'::text, 'get_bookings'::text, 'get_calendar'::text, 'send_message_to_tourist'::text, 'notify_staff'::text, 'assign_guide'::text],
  auto_approve_threshold numeric(10,2) DEFAULT 0,
  max_owner_chat_id bigint,
  language text DEFAULT 'ru'::text,
  is_enabled boolean DEFAULT true,
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operator_applications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  company_name character varying(255) NOT NULL,
  contact_phone character varying(50),
  contact_email character varying(255),
  description text,
  inn character varying(12),
  review_comment text,
  reviewed_by uuid,
  reviewed_at timestamp without time zone,
  created_at timestamp without time zone DEFAULT now(),
  company_inn character varying(12),
  company_ogrn character varying(15),
  efrt_number character varying(50)
);
CREATE TABLE IF NOT EXISTS operator_bookings (
  id bigint NOT NULL DEFAULT nextval('operator_bookings_id_seq'::regclass),
  operator_tour_id bigint NOT NULL,
  tourist_email character varying(255),
  tourist_phone character varying(20),
  tourist_name character varying(255),
  booking_date date NOT NULL,
  participants integer NOT NULL,
  adult_count integer,
  child_count integer,
  base_total_price numeric(10,2),
  discount_percent integer DEFAULT 0,
  discount_reason character varying(255),
  final_price numeric(10,2),
  currency character varying(3) DEFAULT 'RUB'::character varying,
  payment_status character varying(20) NOT NULL DEFAULT 'pending'::character varying,
  payment_method character varying(50),
  payment_id character varying(255),
  paid_at timestamp without time zone,
  booking_status character varying(20) NOT NULL DEFAULT 'confirmed'::character varying,
  cancellation_reason character varying(255),
  cancelled_at timestamp without time zone,
  weather_alert_triggered boolean DEFAULT false,
  alternative_offered_tour_id bigint,
  customer_chose_alternative boolean DEFAULT false,
  alternative_booked_date date,
  confirmation_sent boolean DEFAULT false,
  reminder_sent_24h boolean DEFAULT false,
  weather_alert_sent boolean DEFAULT false,
  special_requests text,
  notes text,
  metadata jsonb,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  created_via character varying(50),
  deleted_at timestamp without time zone,
  octo_uuid uuid DEFAULT gen_random_uuid(),
  octo_api_key_id uuid,
  hold_expires_at timestamp without time zone,
  option_id bigint,
  availability_id character varying(128),
  tochka_qr_id character varying(100),
  paid_amount numeric(12,2),
  end_date date,
  duration_days integer,
  uon_request_id integer,
  uon_synced_at timestamp with time zone,
  referral_link_id uuid
);
CREATE TABLE IF NOT EXISTS operator_payouts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL,
  total_net numeric(10,2) NOT NULL,
  booking_count integer NOT NULL DEFAULT 0,
  currency character varying(3) NOT NULL DEFAULT 'RUB'::character varying,
  payment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  cp_payout_id character varying(128),
  payout_method character varying(20),
  payout_details jsonb,
  status character varying(20) NOT NULL DEFAULT 'PENDING'::character varying,
  failure_reason text,
  period_start date NOT NULL,
  period_end date NOT NULL,
  paid_at timestamp without time zone,
  payment_reference character varying(255),
  created_at timestamp without time zone DEFAULT now(),
  created_by uuid
);
CREATE TABLE IF NOT EXISTS operator_settings (
  user_id uuid NOT NULL,
  auto_confirm_bookings boolean DEFAULT false,
  booking_lead_time integer DEFAULT 24,
  cancellation_policy text,
  refund_policy text,
  min_group_size integer DEFAULT 1,
  max_advance_booking_days integer DEFAULT 365,
  timezone character varying(50) DEFAULT 'Asia/Kamchatka'::character varying,
  currency character varying(3) DEFAULT 'RUB'::character varying,
  commission_rate numeric(5,2) DEFAULT 10.00,
  settings jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operator_signups (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  partner_id uuid,
  user_id uuid,
  telegram_handle character varying(100),
  acquisition_source character varying(50) DEFAULT 'direct_register'::character varying,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operator_staff (
  id integer NOT NULL DEFAULT nextval('operator_staff_id_seq'::regclass),
  partner_id uuid NOT NULL,
  user_id uuid,
  role text NOT NULL,
  full_name text NOT NULL,
  phone text,
  max_chat_id bigint,
  telegram_chat_id bigint,
  assigned_tour_ids integer[],
  certification jsonb,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  employment_type text DEFAULT 'staff'::text,
  email text,
  password_hash text
);
CREATE TABLE IF NOT EXISTS operator_stats_cache (
  operator_id uuid NOT NULL,
  total_tours integer DEFAULT 0,
  active_tours integer DEFAULT 0,
  total_bookings integer DEFAULT 0,
  total_revenue numeric(12,2) DEFAULT 0,
  avg_rating numeric(3,2) DEFAULT 0,
  total_reviews integer DEFAULT 0,
  completion_rate numeric(5,2) DEFAULT 0,
  last_calculated timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operator_tour_reviews (
  id bigint NOT NULL DEFAULT nextval('operator_tour_reviews_id_seq'::regclass),
  tour_id bigint NOT NULL,
  author_name text NOT NULL,
  author_city text,
  rating integer NOT NULL,
  comment text NOT NULL,
  trip_date text,
  created_at timestamp with time zone DEFAULT now(),
  user_id uuid,
  photos text[] NOT NULL DEFAULT '{}'::text[]
);
CREATE TABLE IF NOT EXISTS operator_tour_tags (
  tour_id bigint NOT NULL,
  tag character varying(100) NOT NULL
);
CREATE TABLE IF NOT EXISTS operator_tours (
  id bigint NOT NULL DEFAULT nextval('operator_tours_id_seq'::regclass),
  operator_id uuid NOT NULL,
  title character varying(255) NOT NULL,
  description text,
  slug character varying(255),
  location_type character varying(50),
  activity_type character varying(50),
  location_name character varying(255),
  latitude numeric(10,8),
  longitude numeric(11,8),
  base_price numeric(10,2) DEFAULT NULL::numeric,
  currency character varying(3) DEFAULT 'RUB'::character varying,
  max_participants integer NOT NULL DEFAULT 1,
  min_participants integer DEFAULT 1,
  duration_hours numeric(5,2),
  duration_type character varying(20),
  multi_day_count integer,
  season_start date,
  season_end date,
  seasonal_only boolean DEFAULT false,
  weather_dependent boolean DEFAULT true,
  min_visibility_m integer DEFAULT 1000,
  max_wind_kmh integer DEFAULT 30,
  max_precipitation_mm integer DEFAULT 2,
  is_active boolean DEFAULT true,
  is_published boolean DEFAULT false,
  notes text,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  created_by uuid,
  deleted_at timestamp without time zone,
  price_old numeric(10,2),
  price_unit character varying(30) DEFAULT 'per_tour'::character varying,
  short_description text,
  difficulty character varying(20),
  included text[],
  not_included text[],
  what_to_bring text[],
  photos text[] DEFAULT '{}'::text[],
  tour_image text,
  agent_route_id uuid,
  rating numeric(3,2) DEFAULT 0,
  review_count integer DEFAULT 0,
  tripster_experience_id character varying(100),
  avito_listing_id character varying(100),
  sputnik8_product_id character varying(100),
  channel_sync_at timestamp without time zone,
  available_slots integer,
  next_available_date date,
  route_id uuid,
  group_size_max integer,
  price_note text,
  includes text,
  source_url text,
  parsed_at timestamp with time zone,
  is_stale boolean DEFAULT false,
  ai_tags jsonb DEFAULT '[]'::jsonb,
  meeting_point text,
  program jsonb,
  safety_notes text[]
);
CREATE TABLE IF NOT EXISTS operator_vehicles (
  id integer NOT NULL DEFAULT nextval('operator_vehicles_id_seq'::regclass),
  partner_id uuid NOT NULL,
  name text NOT NULL,
  vehicle_type text NOT NULL,
  capacity integer NOT NULL,
  driver_name text,
  driver_phone text,
  plate_number text,
  is_available boolean DEFAULT true,
  notes text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outreach_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_name character varying(200) NOT NULL,
  contact_name character varying(200),
  email character varying(300),
  phone character varying(50),
  website character varying(500),
  source character varying(200),
  source_url character varying(1000),
  status character varying(30) NOT NULL DEFAULT 'found'::character varying,
  outreach_text text,
  notes text,
  contacted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS page_views (
  id bigint NOT NULL DEFAULT nextval('page_views_id_seq'::regclass),
  path character varying(500) NOT NULL,
  referrer character varying(500),
  created_at timestamp with time zone DEFAULT now(),
  visitor_hash text,
  session_id text,
  from_path text,
  dwell_ms integer,
  is_bot boolean NOT NULL DEFAULT false,
  is_not_found boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS parks (
  id bigint NOT NULL DEFAULT nextval('parks_id_seq'::regclass),
  slug character varying(64) NOT NULL,
  display_name character varying(255) NOT NULL,
  description text,
  zone character varying(64),
  mchs_phone character varying(32),
  permit_url text,
  search_term character varying(128) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  permit_email character varying(255),
  permit_office_address text,
  permit_office_hours text,
  permit_gosuslugi_url text,
  permit_online_url text
);
CREATE TABLE IF NOT EXISTS partner_assets (
  partner_id uuid NOT NULL,
  asset_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS partner_integrations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  provider text NOT NULL,
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS partner_prospects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name character varying(255) NOT NULL,
  source text,
  website text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  status text NOT NULL DEFAULT 'new'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS partners (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  name character varying(255) NOT NULL,
  category character varying(50) NOT NULL,
  description text,
  contact jsonb NOT NULL,
  rating numeric(3,2) DEFAULT 0.0,
  review_count integer DEFAULT 0,
  is_verified boolean DEFAULT false,
  logo_asset_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  legal_info jsonb,
  bank_details jsonb,
  consents jsonb,
  operator_info jsonb,
  roles jsonb,
  password_hash character varying(255),
  status character varying(50) DEFAULT 'pending'::character varying,
  slug character varying(100),
  short_description text,
  hero_image character varying(500),
  gallery jsonb DEFAULT '[]'::jsonb,
  services jsonb DEFAULT '[]'::jsonb,
  features jsonb DEFAULT '[]'::jsonb,
  faq jsonb DEFAULT '[]'::jsonb,
  season_info jsonb DEFAULT '[]'::jsonb,
  reviews_data jsonb DEFAULT '[]'::jsonb,
  contacts jsonb DEFAULT '[]'::jsonb,
  location jsonb,
  is_public boolean DEFAULT false,
  commission_rate numeric(5,4) NOT NULL DEFAULT 0.15,
  commission_rules jsonb DEFAULT '{}'::jsonb,
  logo_image character varying(500),
  payout_method character varying(20),
  payout_details jsonb,
  payout_verified boolean DEFAULT false,
  payout_verified_at timestamp without time zone,
  commission_start numeric(4,2) DEFAULT 10.00,
  commission_current numeric(4,2) DEFAULT 10.00,
  verified_at timestamp without time zone,
  verified_by uuid,
  company_name character varying(255),
  profile_status text NOT NULL DEFAULT 'none'::text,
  profile_draft jsonb,
  profile_review_comment text,
  onboarding_completed boolean NOT NULL DEFAULT false,
  applied_at timestamp without time zone,
  telegram_chat_id bigint,
  reestr_number text,
  license_expiry date,
  insurance_policy text,
  insurance_amount numeric(12,2),
  widget_enabled boolean DEFAULT false,
  widget_domains text[] DEFAULT ARRAY[]::text[],
  widget_config jsonb DEFAULT '{"greeting": "Привет!", "position": "right", "buttonText": "Чат", "accentColor": "#D44A0C"}'::jsonb,
  max_chat_id bigint,
  company_inn character varying(12),
  company_ogrn character varying(15),
  legal_address text,
  efrt_number character varying(50),
  external_source character varying(50),
  external_source_url text,
  external_id character varying(100),
  telegram_group_url text,
  license_number character varying(100),
  external_rating numeric(3,1),
  website text,
  uon_api_key text,
  uon_company_id integer,
  registry_status character varying(20) NOT NULL DEFAULT 'unknown'::character varying,
  registry_number character varying(120),
  registry_source_url text,
  registry_checked_at timestamp with time zone,
  is_available boolean DEFAULT true
);
CREATE TABLE IF NOT EXISTS place_aliases (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  place_id text NOT NULL,
  alias text NOT NULL,
  source_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS place_safety_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  place_id text NOT NULL,
  user_id uuid,
  is_ok boolean NOT NULL DEFAULT true,
  conditions text[] NOT NULL DEFAULT '{}'::text[],
  note text,
  reporter_lat numeric(9,6),
  reporter_lng numeric(9,6),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS places (
  id text NOT NULL,
  name text NOT NULL,
  description text,
  category text,
  category_slug text,
  lat numeric(10,8) NOT NULL,
  lng numeric(11,8) NOT NULL,
  district text,
  length_km numeric(6,2),
  duration character varying(50),
  difficulty character varying(50),
  images jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  ark_id uuid,
  location_type character varying(50),
  activity_type character varying(50),
  zone character varying(50),
  source_url text,
  source_name character varying(100),
  updated_at timestamp with time zone DEFAULT now(),
  search_count integer NOT NULL DEFAULT 0,
  is_visible boolean NOT NULL DEFAULT true,
  essence text,
  photo_url text,
  best_season text,
  seasonal_notes jsonb,
  access_info text,
  eco_zone character varying(50),
  eco_permit_required boolean DEFAULT false,
  eco_rules text,
  eco_permit_url text,
  indigenous_info jsonb,
  view_count integer NOT NULL DEFAULT 0,
  dedupe_key text,
  kuzmich_review text,
  embedding jsonb,
  merged_into_id uuid,
  merged_at timestamp with time zone,
  geocode_failed_at timestamp with time zone,
  slug character varying(80)
);
CREATE TABLE IF NOT EXISTS platform_settings (
  key character varying(100) NOT NULL,
  value text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS promo_codes (
  id character varying(50) NOT NULL,
  code character varying(50) NOT NULL,
  discount_type character varying(20) NOT NULL,
  discount_value numeric(10,2) NOT NULL,
  max_uses integer NOT NULL,
  current_uses integer DEFAULT 0,
  expires_at timestamp without time zone,
  is_active boolean DEFAULT true,
  created_at timestamp without time zone DEFAULT now(),
  created_by uuid
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  last_used timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pwa_installs (
  client_id text NOT NULL,
  platform text,
  install_source text,
  first_seen timestamp with time zone NOT NULL DEFAULT now(),
  last_seen timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS query_expansion_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  orig_query text NOT NULL,
  expanded_count integer NOT NULL,
  unique_added integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rag_feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  message_id text NOT NULL,
  user_id text,
  query text,
  answer text,
  rating integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rag_quality_log (
  id bigint NOT NULL DEFAULT nextval('rag_quality_log_id_seq'::regclass),
  query text NOT NULL,
  answer text NOT NULL,
  relevance_score smallint,
  completeness_score smallint,
  verdict text,
  model text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS referrals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL,
  referred_id uuid,
  referral_code character varying(20) NOT NULL,
  status character varying(20) DEFAULT 'pending'::character varying,
  reward_amount integer DEFAULT 0,
  created_at timestamp without time zone DEFAULT now(),
  completed_at timestamp without time zone
);
CREATE TABLE IF NOT EXISTS refund_requests (
  id integer NOT NULL DEFAULT nextval('refund_requests_id_seq'::regclass),
  partner_id uuid NOT NULL,
  booking_id integer NOT NULL,
  booking_amount numeric(10,2) NOT NULL,
  refund_percent numeric(5,2) NOT NULL,
  refund_amount numeric(10,2) NOT NULL,
  reason text,
  days_before_tour integer,
  cp_transaction_id text,
  cp_refund_id text,
  status text NOT NULL DEFAULT 'pending'::text,
  error_message text,
  initiated_by integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS review_assets (
  review_id uuid NOT NULL,
  asset_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  tour_id uuid,
  rating integer NOT NULL,
  comment text,
  is_verified boolean DEFAULT false,
  operator_reply text,
  operator_reply_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  place_id uuid,
  author_name character varying(100)
);
CREATE TABLE IF NOT EXISTS road_graph_edges (
  id bigint NOT NULL DEFAULT nextval('road_graph_edges_id_seq'::regclass),
  from_node bigint NOT NULL,
  to_node bigint NOT NULL,
  length_m real NOT NULL,
  highway character varying(32) NOT NULL,
  surface character varying(32),
  name text,
  geometry jsonb
);
CREATE TABLE IF NOT EXISTS road_graph_imports (
  id bigint NOT NULL DEFAULT nextval('road_graph_imports_id_seq'::regclass),
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  nodes_count integer NOT NULL DEFAULT 0,
  edges_count integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'overpass'::text,
  note text
);
CREATE TABLE IF NOT EXISTS road_graph_nodes (
  id bigint NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS route_categories (
  slug character varying(50) NOT NULL,
  name_ru character varying(100) NOT NULL,
  name_en character varying(100),
  icon character varying(50),
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS route_description_cache (
  route_id integer NOT NULL,
  description text NOT NULL,
  model text NOT NULL DEFAULT 'editor-agent'::text,
  generated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS route_passport_ocr (
  route_id uuid NOT NULL,
  pdf_url text NOT NULL,
  markdown text NOT NULL,
  pages integer,
  model character varying(50) NOT NULL DEFAULT 'mistral-ocr-latest'::character varying,
  processed_at timestamp with time zone NOT NULL DEFAULT now(),
  enriched_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS route_registration_notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  registration_id uuid,
  step integer NOT NULL,
  channel character varying(20) NOT NULL,
  recipient text NOT NULL,
  status character varying(20) DEFAULT 'pending'::character varying,
  error_message text,
  sent_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS route_registrations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  route_name text NOT NULL,
  route_description text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  region text NOT NULL DEFAULT 'Камчатский край'::text,
  group_size integer NOT NULL,
  group_members jsonb,
  leader_name text NOT NULL,
  leader_phone text NOT NULL,
  leader_email text,
  emergency_contact_name text NOT NULL,
  emergency_contact_phone text NOT NULL,
  emergency_contact_relation text,
  emergency_contact_telegram_chat_id bigint,
  emergency_contact_email text,
  emergency_contact_consent boolean DEFAULT false,
  emergency_contact_consent_at timestamp with time zone,
  mchs_status character varying(20) DEFAULT 'not_submitted'::character varying,
  mchs_reference text,
  submitted_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  expected_return_at timestamp with time zone,
  trip_kind character varying(10) DEFAULT 'day'::character varying,
  last_position_lat numeric(9,6),
  last_position_lng numeric(9,6),
  last_position_at timestamp with time zone,
  checkin_confirmed_at timestamp with time zone,
  reminder_sent boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS route_subcategories (
  id integer NOT NULL DEFAULT nextval('route_subcategories_id_seq'::regclass),
  category_slug character varying(50),
  slug character varying(50) NOT NULL,
  name_ru character varying(100) NOT NULL,
  name_en character varying(100),
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS route_tags (
  id integer NOT NULL DEFAULT nextval('route_tags_id_seq'::regclass),
  slug character varying(50) NOT NULL,
  name_ru character varying(100) NOT NULL,
  name_en character varying(100),
  category_slug character varying(50),
  tag_type character varying(50),
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS route_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name character varying(255) NOT NULL,
  description text NOT NULL,
  short_description text,
  category character varying(50) DEFAULT 'adventure'::character varying,
  difficulty character varying(20) NOT NULL,
  duration integer NOT NULL,
  season jsonb DEFAULT '[]'::jsonb,
  coordinates jsonb DEFAULT '[]'::jsonb,
  requirements jsonb DEFAULT '[]'::jsonb,
  included jsonb DEFAULT '[]'::jsonb,
  not_included jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  source character varying(50) DEFAULT 'manual'::character varying,
  source_external_id character varying(255),
  dedupe_key character varying(400),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  subcategory character varying(100),
  tags jsonb DEFAULT '[]'::jsonb,
  district character varying(100),
  length_km numeric(8,2),
  activities jsonb DEFAULT '[]'::jsonb,
  features jsonb DEFAULT '[]'::jsonb,
  best_months character varying(50),
  min_elevation integer,
  max_elevation integer,
  images jsonb DEFAULT '[]'::jsonb
);
CREATE TABLE IF NOT EXISTS route_waypoints (
  id bigint NOT NULL DEFAULT nextval('route_waypoints_id_seq'::regclass),
  route_id uuid NOT NULL,
  place_id text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  is_start boolean DEFAULT false,
  is_end boolean DEFAULT false,
  notes text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS safety_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  zone character varying(20) NOT NULL,
  severity character varying(10) NOT NULL,
  title character varying(200) NOT NULL,
  message text NOT NULL,
  source character varying(100) NOT NULL DEFAULT 'МЧС Камчатка'::character varying,
  active_from timestamp with time zone NOT NULL DEFAULT now(),
  active_until timestamp with time zone,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS safety_source_health (
  source_key text NOT NULL,
  label text,
  last_run_at timestamp with time zone,
  last_status text,
  raw_items integer DEFAULT 0,
  inserted integer DEFAULT 0,
  last_nonempty_at timestamp with time zone,
  last_alerted_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now(),
  first_seen_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS sessions (
  id text NOT NULL,
  "sessionToken" text NOT NULL,
  "userId" text NOT NULL,
  expires timestamp(3) without time zone NOT NULL
);
CREATE TABLE IF NOT EXISTS smart_notifications_log (
  id bigint NOT NULL DEFAULT nextval('smart_notifications_log_id_seq'::regclass),
  user_id uuid NOT NULL,
  tours_matched bigint[] NOT NULL DEFAULT '{}'::bigint[],
  channel character varying(20) NOT NULL DEFAULT 'telegram'::character varying,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sos_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  session_id text,
  lat numeric(10,7),
  lng numeric(11,7),
  accuracy numeric(10,2),
  ip_address inet,
  user_agent text,
  status character varying(32) NOT NULL DEFAULT 'sent'::character varying,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  tourist_name text,
  tourist_phone text,
  message text,
  emergency_type text,
  source character varying(20) NOT NULL DEFAULT 'direct'::character varying,
  relayed_by text
);
CREATE TABLE IF NOT EXISTS stakeholder_wishes (
  id bigint NOT NULL DEFAULT nextval('stakeholder_wishes_id_seq'::regclass),
  stakeholder character varying(100) NOT NULL DEFAULT 'artem'::character varying,
  message text NOT NULL,
  category character varying(30) NOT NULL DEFAULT 'general'::character varying,
  priority character varying(10) NOT NULL DEFAULT 'medium'::character varying,
  status character varying(20) NOT NULL DEFAULT 'new'::character varying,
  admin_reply text,
  created_by uuid,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  channel character varying(20) NOT NULL DEFAULT 'telegram'::character varying,
  category character varying(30) NOT NULL DEFAULT 'other'::character varying,
  subject text NOT NULL,
  status character varying(20) NOT NULL DEFAULT 'open'::character varying,
  assigned_agent character varying(30) DEFAULT NULL::character varying,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolution text,
  escalated_at timestamp with time zone,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  user_name character varying(255),
  user_email character varying(255)
);
CREATE TABLE IF NOT EXISTS system_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key character varying(100) NOT NULL,
  value text NOT NULL,
  description text,
  category character varying(50) DEFAULT 'general'::character varying,
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tg_booking_flow (
  chat_id bigint NOT NULL,
  mode text NOT NULL DEFAULT 'tourist'::text,
  state jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tg_conversations (
  id bigint NOT NULL DEFAULT nextval('tg_conversations_id_seq'::regclass),
  chat_id bigint NOT NULL,
  mode character varying(20) NOT NULL DEFAULT 'tourist'::character varying,
  role character varying(10) NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  user_id bigint,
  user_name character varying(255),
  platform character varying(20) DEFAULT 'telegram'::character varying
);
CREATE TABLE IF NOT EXISTS tg_operator_groups (
  group_id bigint NOT NULL,
  operator_id integer,
  group_title text,
  registered_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tg_ratings (
  id bigint NOT NULL DEFAULT nextval('tg_ratings_id_seq'::regclass),
  chat_id bigint NOT NULL,
  mode text NOT NULL DEFAULT 'tourist'::text,
  rating smallint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tour_assets (
  tour_id uuid NOT NULL,
  asset_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS tour_availability (
  id bigint NOT NULL DEFAULT nextval('tour_availability_id_seq'::regclass),
  operator_tour_id bigint NOT NULL,
  date date NOT NULL,
  day_of_week integer,
  available_slots integer NOT NULL,
  booked_slots integer DEFAULT 0,
  base_price_override numeric(10,2),
  weather_status character varying(20) DEFAULT 'unknown'::character varying,
  weather_data jsonb,
  weather_check_time timestamp without time zone,
  is_cancelled boolean DEFAULT false,
  cancellation_reason character varying(255),
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  deleted_at timestamp without time zone
);
CREATE TABLE IF NOT EXISTS tour_availability_alternatives (
  availability_id bigint NOT NULL,
  alternative_tour_id bigint NOT NULL,
  priority integer DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tour_departures (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  tour_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date,
  available_slots integer NOT NULL DEFAULT 10,
  booked_slots integer NOT NULL DEFAULT 0,
  price_override numeric(12,2),
  min_group_size integer DEFAULT 5,
  status text NOT NULL DEFAULT 'active'::text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tour_options (
  id bigint NOT NULL DEFAULT nextval('tour_options_id_seq'::regclass),
  operator_tour_id bigint NOT NULL,
  internal_name character varying(255) NOT NULL,
  is_default boolean DEFAULT false,
  price_adult numeric(10,2),
  price_child numeric(10,2),
  price_youth numeric(10,2),
  max_units integer,
  min_units integer DEFAULT 1,
  restrictions jsonb DEFAULT '{}'::jsonb,
  is_active boolean DEFAULT true,
  created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tour_payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  booking_id bigint NOT NULL,
  operator_id uuid NOT NULL,
  retail_amount numeric(10,2) NOT NULL,
  net_amount numeric(10,2) NOT NULL,
  commission_amount numeric(10,2) NOT NULL,
  commission_rate numeric(4,2) NOT NULL,
  currency character varying(3) NOT NULL DEFAULT 'RUB'::character varying,
  cp_transaction_id character varying(128),
  cp_invoice_id character varying(128),
  cp_payment_method character varying(50),
  status character varying(20) NOT NULL DEFAULT 'HELD'::character varying,
  paid_at timestamp without time zone,
  release_after timestamp without time zone,
  released_at timestamp without time zone,
  refunded_at timestamp without time zone,
  refund_amount numeric(10,2),
  refund_reason text,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tour_pricing_rules (
  id bigint NOT NULL DEFAULT nextval('tour_pricing_rules_id_seq'::regclass),
  operator_tour_id bigint NOT NULL,
  rule_type character varying(30) NOT NULL,
  date_from date,
  date_to date,
  days_before_min integer,
  days_before_max integer,
  occupancy_min integer,
  guests_min integer,
  multiplier numeric(5,3) NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tour_selection_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  selection_id uuid NOT NULL,
  item_id uuid,
  event_type character varying(20) NOT NULL,
  visitor_ip text,
  user_agent text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tour_selection_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  selection_id uuid NOT NULL,
  operator_tour_id integer NOT NULL,
  "position" integer DEFAULT 0,
  note text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tour_selections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code character varying(16) NOT NULL,
  title text,
  client_name text,
  client_phone text,
  client_telegram text,
  operator_id uuid,
  created_by uuid,
  created_via character varying(20) DEFAULT 'hub'::character varying,
  expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tour_transfer_requests (
  id integer NOT NULL DEFAULT nextval('tour_transfer_requests_id_seq'::regclass),
  from_partner_id uuid NOT NULL,
  to_partner_id uuid,
  booking_ids integer[] NOT NULL,
  tourist_count integer NOT NULL,
  original_amount numeric(10,2) NOT NULL,
  transfer_amount numeric(10,2),
  platform_commission numeric(10,2),
  originator_fee numeric(10,2),
  reason text NOT NULL,
  status text DEFAULT 'searching'::text,
  message text,
  expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tourist_incidents (
  id integer NOT NULL DEFAULT nextval('tourist_incidents_id_seq'::regclass),
  slug character varying(120) NOT NULL,
  incident_date date NOT NULL,
  title text NOT NULL,
  location_name text NOT NULL,
  location_type character varying(40) DEFAULT 'volcano'::character varying,
  casualties integer NOT NULL DEFAULT 0,
  injured integer NOT NULL DEFAULT 0,
  description text NOT NULL,
  cause text NOT NULL,
  lessons text[] NOT NULL DEFAULT '{}'::text[],
  mchs_involved boolean DEFAULT true,
  source_url text,
  related_ark_id uuid,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tours (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying(255) NOT NULL,
  description text NOT NULL,
  short_description text,
  category character varying(50) DEFAULT 'adventure'::character varying,
  difficulty character varying(20) NOT NULL,
  duration integer NOT NULL,
  price numeric(10,2) NOT NULL,
  currency character varying(3) DEFAULT 'RUB'::character varying,
  season jsonb DEFAULT '[]'::jsonb,
  coordinates jsonb DEFAULT '[]'::jsonb,
  requirements jsonb DEFAULT '[]'::jsonb,
  included jsonb DEFAULT '[]'::jsonb,
  not_included jsonb DEFAULT '[]'::jsonb,
  operator_id uuid,
  guide_id uuid,
  max_group_size integer DEFAULT 20,
  min_group_size integer DEFAULT 1,
  rating numeric(3,2) DEFAULT 0.0,
  review_count integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  ai_tags jsonb DEFAULT '{}'::jsonb,
  route_id uuid,
  tour_image text
);
CREATE TABLE IF NOT EXISTS trail_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_type character varying(20) NOT NULL,
  text text NOT NULL,
  lat double precision,
  lng double precision,
  user_id uuid,
  status character varying(10) NOT NULL DEFAULT 'pending'::character varying,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transfer_reviews (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  transfer_id uuid NOT NULL,
  user_id uuid,
  driver_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  rating integer NOT NULL,
  driver_rating integer,
  vehicle_rating integer,
  punctuality_rating integer,
  comment text,
  operator_reply text,
  operator_reply_at timestamp with time zone,
  is_verified boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transfer_routes (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  operator_id uuid NOT NULL,
  name character varying(255) NOT NULL,
  from_location character varying(255) NOT NULL,
  to_location character varying(255) NOT NULL,
  from_coordinates jsonb,
  to_coordinates jsonb,
  distance numeric(10,2),
  estimated_duration integer,
  base_price numeric(10,2) NOT NULL,
  price_per_km numeric(10,2),
  price_per_hour numeric(10,2),
  popular boolean DEFAULT false,
  transfers_count integer DEFAULT 0,
  average_rating numeric(3,2) DEFAULT 0.0,
  is_active boolean DEFAULT true,
  weather_dependent boolean DEFAULT false,
  stops jsonb DEFAULT '[]'::jsonb,
  description text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transfer_transactions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  operator_id uuid NOT NULL,
  type character varying(50) NOT NULL,
  amount numeric(10,2) NOT NULL,
  currency character varying(3) DEFAULT 'RUB'::character varying,
  description text,
  date date NOT NULL,
  transfer_id uuid,
  driver_id uuid,
  vehicle_id uuid,
  payment_method character varying(50),
  reference_number character varying(100),
  notes text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transfers (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  booking_reference character varying(100) NOT NULL,
  operator_id uuid NOT NULL,
  route_id uuid,
  client_name character varying(255) NOT NULL,
  client_phone character varying(50) NOT NULL,
  client_email character varying(255),
  user_id uuid,
  vehicle_id uuid,
  driver_id uuid,
  pickup_location text NOT NULL,
  pickup_coordinates jsonb,
  dropoff_location text NOT NULL,
  dropoff_coordinates jsonb,
  pickup_datetime timestamp with time zone NOT NULL,
  dropoff_datetime timestamp with time zone,
  passengers integer NOT NULL,
  luggage integer DEFAULT 0,
  special_requests text,
  price numeric(10,2) NOT NULL,
  currency character varying(3) DEFAULT 'RUB'::character varying,
  status character varying(50) DEFAULT 'scheduled'::character varying,
  payment_status character varying(50) DEFAULT 'pending'::character varying,
  payment_method character varying(50),
  notes text,
  actual_pickup_time timestamp with time zone,
  actual_dropoff_time timestamp with time zone,
  actual_distance numeric(10,2),
  actual_duration integer,
  rating integer,
  feedback text,
  cancellation_reason text,
  cancelled_by character varying(50),
  cancelled_at timestamp with time zone,
  assigned_at timestamp with time zone,
  confirmed_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS uon_sync_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  operator_id uuid,
  booking_id text,
  endpoint text NOT NULL,
  success boolean NOT NULL,
  http_status integer,
  latency_ms integer NOT NULL DEFAULT 0,
  uon_request_id integer,
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id uuid NOT NULL,
  achievement_id uuid NOT NULL,
  unlocked_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_ai_memory (
  id bigint NOT NULL DEFAULT nextval('user_ai_memory_id_seq'::regclass),
  user_id uuid NOT NULL,
  preferred_activities text[] DEFAULT '{}'::text[],
  preferred_locations text[] DEFAULT '{}'::text[],
  travel_style text,
  sessions_count integer NOT NULL DEFAULT 1,
  last_updated timestamp without time zone NOT NULL DEFAULT now(),
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  group_size character varying(50),
  budget_level character varying(50),
  ai_notes text,
  messages_count integer DEFAULT 0,
  budget_max integer,
  group_size_num integer,
  preferred_months integer[] DEFAULT '{}'::integer[],
  viewed_tour_ids integer[] DEFAULT '{}'::integer[],
  last_intent text
);
CREATE TABLE IF NOT EXISTS user_eco_activities (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  points integer NOT NULL,
  activity character varying(255) NOT NULL,
  eco_point_id uuid,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_eco_points (
  user_id uuid NOT NULL,
  total_points integer DEFAULT 0,
  level integer DEFAULT 1,
  last_activity timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_place_photos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  place_id text NOT NULL,
  user_id uuid,
  url text NOT NULL,
  caption text,
  status text NOT NULL DEFAULT 'pending'::text,
  created_at timestamp with time zone DEFAULT now(),
  reviewed_at timestamp with time zone,
  reviewed_by uuid
);
CREATE TABLE IF NOT EXISTS user_role_history (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  old_role character varying(50),
  new_role character varying(50) NOT NULL,
  changed_by uuid,
  reason text,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  token character varying(255) NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_trips (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title character varying(255) NOT NULL DEFAULT 'Мой маршрут'::character varying,
  arrival_date date,
  departure_date date,
  places text[] NOT NULL DEFAULT '{}'::text[],
  activities text[] NOT NULL DEFAULT '{}'::text[],
  days jsonb NOT NULL DEFAULT '[]'::jsonb,
  transport_by_day jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  flight_arrival character varying(20),
  flight_departure character varying(20),
  flight_arrival_time character varying(5) DEFAULT NULL::character varying,
  flight_departure_time character varying(5) DEFAULT NULL::character varying,
  needs_airport_transfer boolean NOT NULL DEFAULT false,
  share_token uuid DEFAULT gen_random_uuid(),
  is_public boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS users (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  email character varying(255) NOT NULL,
  name character varying(255) NOT NULL,
  password_hash character varying(255) NOT NULL,
  role character varying(50) NOT NULL,
  preferences jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  recommendations jsonb,
  recommended_at timestamp with time zone,
  phone character varying(20),
  pd_consent_at timestamp with time zone,
  pd_consent_ip character varying(45),
  referral_code character varying(20),
  referred_by uuid,
  total_spent numeric(12,2) DEFAULT 0,
  pending_role text,
  role_applied_at timestamp without time zone,
  telegram_id bigint,
  telegram_username character varying(100),
  pd_consent_given boolean DEFAULT false,
  marketing_consent boolean DEFAULT false,
  telegram_chat_id bigint,
  is_active boolean DEFAULT true,
  mfa_secret text,
  mfa_enabled boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  active_trip_id uuid,
  active_trip_since timestamp with time zone,
  max_user_id bigint,
  max_username text
);
CREATE TABLE IF NOT EXISTS vehicle_documents (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  vehicle_id uuid NOT NULL,
  type character varying(50) NOT NULL,
  name character varying(255) NOT NULL,
  file_url text NOT NULL,
  document_number character varying(100),
  issue_date date,
  expiry_date date,
  issuing_authority character varying(255),
  status character varying(20) DEFAULT 'valid'::character varying,
  notes text,
  uploaded_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vehicles (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  operator_id uuid NOT NULL,
  name character varying(255) NOT NULL,
  type character varying(50) NOT NULL,
  license_plate character varying(50) NOT NULL,
  capacity integer NOT NULL,
  category character varying(50) DEFAULT 'economy'::character varying,
  status character varying(50) DEFAULT 'active'::character varying,
  location character varying(255),
  features jsonb DEFAULT '[]'::jsonb,
  images jsonb DEFAULT '[]'::jsonb,
  purchase_date date,
  last_service_date date,
  next_service_date date,
  mileage integer DEFAULT 0,
  fuel_type character varying(50),
  year integer,
  color character varying(50),
  vin character varying(100),
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verification_tokens (
  identifier text NOT NULL,
  token text NOT NULL,
  expires timestamp(3) without time zone NOT NULL
);
CREATE TABLE IF NOT EXISTS volcano_status (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  place_ark_id uuid,
  volcano_name text NOT NULL,
  name_normalized text NOT NULL,
  aviation_color_code text NOT NULL DEFAULT 'unassigned'::text,
  activity_level text,
  ash_height_m integer,
  summary text,
  source_url text,
  source_name text DEFAULT 'KVERT'::text,
  observed_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS weather_alert_bookings (
  alert_id bigint NOT NULL,
  booking_id bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS weather_alerts (
  id bigint NOT NULL DEFAULT nextval('weather_alerts_id_seq'::regclass),
  operator_tour_id bigint NOT NULL,
  location_name character varying(255),
  alert_date date NOT NULL,
  alert_type character varying(50),
  severity character varying(20),
  weather_data jsonb,
  processed boolean DEFAULT false,
  processed_at timestamp without time zone,
  action_taken character varying(255),
  created_at timestamp without time zone DEFAULT now()
);

-- ══ constraints (646) ══════════════════════════════
ALTER TABLE _migration_failures ADD CONSTRAINT _migration_failures_pkey PRIMARY KEY (name);
ALTER TABLE _migrations ADD CONSTRAINT _migrations_pkey PRIMARY KEY (id);
ALTER TABLE _route_description_cache_legacy ADD CONSTRAINT route_description_cache_pkey PRIMARY KEY (route_id);
ALTER TABLE accommodation_assets ADD CONSTRAINT accommodation_assets_pkey PRIMARY KEY (id);
ALTER TABLE accommodation_availability ADD CONSTRAINT accommodation_availability_pkey PRIMARY KEY (id);
ALTER TABLE accommodation_bookings ADD CONSTRAINT accommodation_bookings_pkey PRIMARY KEY (id);
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_pkey PRIMARY KEY (id);
ALTER TABLE accommodation_rooms ADD CONSTRAINT accommodation_rooms_pkey PRIMARY KEY (id);
ALTER TABLE accommodations ADD CONSTRAINT accommodations_pkey PRIMARY KEY (id);
ALTER TABLE accounts ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
ALTER TABLE activities ADD CONSTRAINT activities_pkey PRIMARY KEY (id);
ALTER TABLE affiliate_clicks ADD CONSTRAINT affiliate_clicks_pkey PRIMARY KEY (id);
ALTER TABLE affiliate_payouts ADD CONSTRAINT affiliate_payouts_pkey PRIMARY KEY (id);
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_pkey PRIMARY KEY (id);
ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_pkey PRIMARY KEY (id);
ALTER TABLE agent_bookings ADD CONSTRAINT agent_bookings_pkey PRIMARY KEY (id);
ALTER TABLE agent_clients ADD CONSTRAINT agent_clients_pkey PRIMARY KEY (id);
ALTER TABLE agent_commissions ADD CONSTRAINT agent_commissions_pkey PRIMARY KEY (id);
ALTER TABLE agent_experiments ADD CONSTRAINT agent_experiments_pkey PRIMARY KEY (id);
ALTER TABLE agent_knowledge ADD CONSTRAINT agent_knowledge_pkey PRIMARY KEY (id);
ALTER TABLE agent_knowledge_links ADD CONSTRAINT agent_knowledge_links_pkey PRIMARY KEY (id);
ALTER TABLE agent_market_payments ADD CONSTRAINT agent_market_payments_pkey PRIMARY KEY (id);
ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_pkey PRIMARY KEY (id);
ALTER TABLE agent_memory_edits ADD CONSTRAINT agent_memory_edits_pkey PRIMARY KEY (id);
ALTER TABLE agent_referral_events ADD CONSTRAINT agent_referral_events_pkey PRIMARY KEY (id);
ALTER TABLE agent_referral_links ADD CONSTRAINT agent_referral_links_pkey PRIMARY KEY (id);
ALTER TABLE agent_run_history ADD CONSTRAINT agent_run_history_pkey PRIMARY KEY (id);
ALTER TABLE agent_sdk_sessions ADD CONSTRAINT agent_sdk_sessions_pkey PRIMARY KEY (id);
ALTER TABLE agent_tools ADD CONSTRAINT agent_tools_pkey PRIMARY KEY (id);
ALTER TABLE ai_actions_log ADD CONSTRAINT ai_actions_log_pkey PRIMARY KEY (id);
ALTER TABLE ai_route_images ADD CONSTRAINT ai_route_images_pkey PRIMARY KEY (id);
ALTER TABLE approval_execution_log ADD CONSTRAINT approval_execution_log_pkey PRIMARY KEY (id);
ALTER TABLE articles ADD CONSTRAINT articles_pkey PRIMARY KEY (id);
ALTER TABLE assets ADD CONSTRAINT assets_pkey PRIMARY KEY (id);
ALTER TABLE audit_log ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);
ALTER TABLE board_meeting_sessions ADD CONSTRAINT board_meeting_sessions_pkey PRIMARY KEY (id);
ALTER TABLE booking_change_requests ADD CONSTRAINT booking_change_requests_pkey PRIMARY KEY (id);
ALTER TABLE booking_group_members ADD CONSTRAINT booking_group_members_pkey PRIMARY KEY (id);
ALTER TABLE booking_transfers ADD CONSTRAINT booking_transfers_pkey PRIMARY KEY (id);
ALTER TABLE booking_waivers ADD CONSTRAINT booking_waivers_pkey PRIMARY KEY (id);
ALTER TABLE bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
ALTER TABLE cancellation_policies ADD CONSTRAINT cancellation_policies_pkey PRIMARY KEY (id);
ALTER TABLE channel_orders ADD CONSTRAINT channel_orders_pkey PRIMARY KEY (id);
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);
ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_pkey PRIMARY KEY (id);
ALTER TABLE client_communications ADD CONSTRAINT client_communications_pkey PRIMARY KEY (id);
ALTER TABLE collections ADD CONSTRAINT collections_pkey PRIMARY KEY (id);
ALTER TABLE commission_payouts ADD CONSTRAINT commission_payouts_pkey PRIMARY KEY (id);
ALTER TABLE contingency_rules ADD CONSTRAINT contingency_rules_pkey PRIMARY KEY (id);
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_pkey PRIMARY KEY (id);
ALTER TABLE conversation_participants ADD CONSTRAINT conversation_participants_pkey PRIMARY KEY (id);
ALTER TABLE conversations ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);
ALTER TABLE crowd_log ADD CONSTRAINT crowd_log_pkey PRIMARY KEY (id);
ALTER TABLE danger_assessments ADD CONSTRAINT danger_assessments_pkey PRIMARY KEY (id);
ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_pkey PRIMARY KEY (id);
ALTER TABLE driver_schedules ADD CONSTRAINT driver_schedules_pkey PRIMARY KEY (id);
ALTER TABLE drivers ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);
ALTER TABLE eco_achievements ADD CONSTRAINT eco_achievements_pkey PRIMARY KEY (id);
ALTER TABLE eco_balances ADD CONSTRAINT eco_balances_pkey PRIMARY KEY (account);
ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_compensation_claims_pkey PRIMARY KEY (id);
ALTER TABLE eco_ledger ADD CONSTRAINT eco_ledger_pkey PRIMARY KEY (id);
ALTER TABLE eco_points ADD CONSTRAINT eco_points_pkey PRIMARY KEY (id);
ALTER TABLE email_templates ADD CONSTRAINT email_templates_pkey PRIMARY KEY (id);
ALTER TABLE emergency_contacts ADD CONSTRAINT emergency_contacts_pkey PRIMARY KEY (id);
ALTER TABLE evo_agent_state ADD CONSTRAINT evo_agent_state_pkey PRIMARY KEY (key);
ALTER TABLE evo_evolution_log ADD CONSTRAINT evo_evolution_log_pkey PRIMARY KEY (id);
ALTER TABLE evo_feedback ADD CONSTRAINT evo_feedback_pkey PRIMARY KEY (id);
ALTER TABLE evo_growth_issues ADD CONSTRAINT evo_growth_issues_pkey PRIMARY KEY (id);
ALTER TABLE evo_growth_scans ADD CONSTRAINT evo_growth_scans_pkey PRIMARY KEY (id);
ALTER TABLE evo_review_ledger ADD CONSTRAINT evo_review_ledger_pkey PRIMARY KEY (file_path);
ALTER TABLE external_alerts ADD CONSTRAINT external_alerts_pkey PRIMARY KEY (id);
ALTER TABLE external_tools ADD CONSTRAINT external_tools_pkey PRIMARY KEY (id);
ALTER TABLE faqs ADD CONSTRAINT faqs_pkey PRIMARY KEY (id);
ALTER TABLE funnel_events ADD CONSTRAINT funnel_events_pkey PRIMARY KEY (id);
ALTER TABLE gear_availability ADD CONSTRAINT gear_availability_pkey PRIMARY KEY (id);
ALTER TABLE gear_items ADD CONSTRAINT gear_items_pkey PRIMARY KEY (id);
ALTER TABLE gear_rentals ADD CONSTRAINT gear_rentals_pkey PRIMARY KEY (id);
ALTER TABLE guide_availability ADD CONSTRAINT guide_availability_pkey PRIMARY KEY (id);
ALTER TABLE guide_certifications ADD CONSTRAINT guide_certifications_pkey PRIMARY KEY (id);
ALTER TABLE guide_earnings ADD CONSTRAINT guide_earnings_pkey PRIMARY KEY (id);
ALTER TABLE guide_groups ADD CONSTRAINT guide_groups_pkey PRIMARY KEY (id);
ALTER TABLE guide_reviews ADD CONSTRAINT guide_reviews_pkey PRIMARY KEY (id);
ALTER TABLE guide_schedule ADD CONSTRAINT guide_schedule_pkey PRIMARY KEY (id);
ALTER TABLE intelligence_sources ADD CONSTRAINT intelligence_sources_pkey PRIMARY KEY (id);
ALTER TABLE kamchatka_routes ADD CONSTRAINT kamchatka_routes_pkey PRIMARY KEY (id);
ALTER TABLE kuzmich_engagement_signals ADD CONSTRAINT kuzmich_engagement_signals_pkey PRIMARY KEY (id);
ALTER TABLE lead_activity_log ADD CONSTRAINT lead_activity_log_pkey PRIMARY KEY (id);
ALTER TABLE lead_followups ADD CONSTRAINT lead_followups_pkey PRIMARY KEY (id);
ALTER TABLE lead_proposals ADD CONSTRAINT lead_proposals_pkey PRIMARY KEY (id);
ALTER TABLE leads ADD CONSTRAINT leads_pkey PRIMARY KEY (id);
ALTER TABLE legislation_docs ADD CONSTRAINT legislation_docs_pkey PRIMARY KEY (id);
ALTER TABLE llm_usage_log ADD CONSTRAINT llm_usage_log_pkey PRIMARY KEY (id);
ALTER TABLE location_real_time_status ADD CONSTRAINT location_real_time_status_pkey PRIMARY KEY (id);
ALTER TABLE location_safety_profile ADD CONSTRAINT location_safety_profile_pkey PRIMARY KEY (id);
ALTER TABLE loyalty_levels ADD CONSTRAINT loyalty_levels_pkey PRIMARY KEY (id);
ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_pkey PRIMARY KEY (id);
ALTER TABLE max_login_sessions ADD CONSTRAINT max_login_sessions_pkey PRIMARY KEY (nonce);
ALTER TABLE mchs_group_registrations ADD CONSTRAINT mchs_group_registrations_pkey PRIMARY KEY (id);
ALTER TABLE mchs_registrations ADD CONSTRAINT mchs_registrations_pkey PRIMARY KEY (id);
ALTER TABLE mcp_tool_calls ADD CONSTRAINT mcp_tool_calls_pkey PRIMARY KEY (id);
ALTER TABLE message_templates ADD CONSTRAINT message_templates_pkey PRIMARY KEY (id);
ALTER TABLE notification_log ADD CONSTRAINT notification_log_pkey PRIMARY KEY (id);
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id);
ALTER TABLE notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE octo_api_keys ADD CONSTRAINT octo_api_keys_pkey PRIMARY KEY (id);
ALTER TABLE octo_booking_log ADD CONSTRAINT octo_booking_log_pkey PRIMARY KEY (id);
ALTER TABLE octo_webhook_log ADD CONSTRAINT octo_webhook_log_pkey PRIMARY KEY (id);
ALTER TABLE official_registry_operators ADD CONSTRAINT official_registry_operators_pkey PRIMARY KEY (id);
ALTER TABLE operator_ai_actions ADD CONSTRAINT operator_ai_actions_pkey PRIMARY KEY (id);
ALTER TABLE operator_ai_config ADD CONSTRAINT operator_ai_config_pkey PRIMARY KEY (id);
ALTER TABLE operator_applications ADD CONSTRAINT operator_applications_pkey PRIMARY KEY (id);
ALTER TABLE operator_bookings ADD CONSTRAINT operator_bookings_pkey PRIMARY KEY (id);
ALTER TABLE operator_payouts ADD CONSTRAINT operator_payouts_pkey PRIMARY KEY (id);
ALTER TABLE operator_settings ADD CONSTRAINT operator_settings_pkey PRIMARY KEY (user_id);
ALTER TABLE operator_signups ADD CONSTRAINT operator_signups_pkey PRIMARY KEY (id);
ALTER TABLE operator_staff ADD CONSTRAINT operator_staff_pkey PRIMARY KEY (id);
ALTER TABLE operator_stats_cache ADD CONSTRAINT operator_stats_cache_pkey PRIMARY KEY (operator_id);
ALTER TABLE operator_tour_reviews ADD CONSTRAINT operator_tour_reviews_pkey PRIMARY KEY (id);
ALTER TABLE operator_tour_tags ADD CONSTRAINT operator_tour_tags_pkey PRIMARY KEY (tour_id, tag);
ALTER TABLE operator_tours ADD CONSTRAINT operator_tours_pkey PRIMARY KEY (id);
ALTER TABLE operator_vehicles ADD CONSTRAINT operator_vehicles_pkey PRIMARY KEY (id);
ALTER TABLE outreach_queue ADD CONSTRAINT outreach_queue_pkey PRIMARY KEY (id);
ALTER TABLE page_views ADD CONSTRAINT page_views_pkey PRIMARY KEY (id);
ALTER TABLE parks ADD CONSTRAINT parks_pkey PRIMARY KEY (id);
ALTER TABLE partner_assets ADD CONSTRAINT partner_assets_pkey PRIMARY KEY (partner_id, asset_id);
ALTER TABLE partner_integrations ADD CONSTRAINT partner_integrations_pkey PRIMARY KEY (id);
ALTER TABLE partner_prospects ADD CONSTRAINT partner_prospects_pkey PRIMARY KEY (id);
ALTER TABLE partners ADD CONSTRAINT partners_pkey PRIMARY KEY (id);
ALTER TABLE place_aliases ADD CONSTRAINT place_aliases_pkey PRIMARY KEY (id);
ALTER TABLE place_safety_reports ADD CONSTRAINT place_safety_reports_pkey PRIMARY KEY (id);
ALTER TABLE places ADD CONSTRAINT places_pkey PRIMARY KEY (id);
ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_pkey PRIMARY KEY (id);
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE pwa_installs ADD CONSTRAINT pwa_installs_pkey PRIMARY KEY (client_id);
ALTER TABLE query_expansion_log ADD CONSTRAINT query_expansion_log_pkey PRIMARY KEY (id);
ALTER TABLE rag_feedback ADD CONSTRAINT rag_feedback_pkey PRIMARY KEY (id);
ALTER TABLE rag_quality_log ADD CONSTRAINT rag_quality_log_pkey PRIMARY KEY (id);
ALTER TABLE referrals ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_pkey PRIMARY KEY (id);
ALTER TABLE review_assets ADD CONSTRAINT review_assets_pkey PRIMARY KEY (review_id, asset_id);
ALTER TABLE reviews ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);
ALTER TABLE road_graph_edges ADD CONSTRAINT road_graph_edges_pkey PRIMARY KEY (id);
ALTER TABLE road_graph_imports ADD CONSTRAINT road_graph_imports_pkey PRIMARY KEY (id);
ALTER TABLE road_graph_nodes ADD CONSTRAINT road_graph_nodes_pkey PRIMARY KEY (id);
ALTER TABLE route_categories ADD CONSTRAINT route_categories_pkey PRIMARY KEY (slug);
ALTER TABLE route_description_cache ADD CONSTRAINT route_description_cache_pkey1 PRIMARY KEY (route_id);
ALTER TABLE route_passport_ocr ADD CONSTRAINT route_passport_ocr_pkey PRIMARY KEY (route_id);
ALTER TABLE route_registration_notifications ADD CONSTRAINT route_registration_notifications_pkey PRIMARY KEY (id);
ALTER TABLE route_registrations ADD CONSTRAINT route_registrations_pkey PRIMARY KEY (id);
ALTER TABLE route_subcategories ADD CONSTRAINT route_subcategories_pkey PRIMARY KEY (id);
ALTER TABLE route_tags ADD CONSTRAINT route_tags_pkey PRIMARY KEY (id);
ALTER TABLE route_templates ADD CONSTRAINT route_templates_pkey PRIMARY KEY (id);
ALTER TABLE route_waypoints ADD CONSTRAINT route_waypoints_pkey PRIMARY KEY (id);
ALTER TABLE safety_alerts ADD CONSTRAINT safety_alerts_pkey PRIMARY KEY (id);
ALTER TABLE safety_source_health ADD CONSTRAINT safety_source_health_pkey PRIMARY KEY (source_key);
ALTER TABLE sessions ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
ALTER TABLE smart_notifications_log ADD CONSTRAINT smart_notifications_log_pkey PRIMARY KEY (id);
ALTER TABLE sos_events ADD CONSTRAINT sos_events_pkey PRIMARY KEY (id);
ALTER TABLE stakeholder_wishes ADD CONSTRAINT stakeholder_wishes_pkey PRIMARY KEY (id);
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);
ALTER TABLE system_settings ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);
ALTER TABLE tg_booking_flow ADD CONSTRAINT tg_booking_flow_pkey PRIMARY KEY (chat_id, mode);
ALTER TABLE tg_conversations ADD CONSTRAINT tg_conversations_pkey PRIMARY KEY (id);
ALTER TABLE tg_operator_groups ADD CONSTRAINT tg_operator_groups_pkey PRIMARY KEY (group_id);
ALTER TABLE tg_ratings ADD CONSTRAINT tg_ratings_pkey PRIMARY KEY (id);
ALTER TABLE tour_assets ADD CONSTRAINT tour_assets_pkey PRIMARY KEY (tour_id, asset_id);
ALTER TABLE tour_availability ADD CONSTRAINT tour_availability_pkey PRIMARY KEY (id);
ALTER TABLE tour_availability_alternatives ADD CONSTRAINT tour_availability_alternatives_pkey PRIMARY KEY (availability_id, alternative_tour_id);
ALTER TABLE tour_departures ADD CONSTRAINT tour_departures_pkey PRIMARY KEY (id);
ALTER TABLE tour_options ADD CONSTRAINT tour_options_pkey PRIMARY KEY (id);
ALTER TABLE tour_payments ADD CONSTRAINT tour_payments_pkey PRIMARY KEY (id);
ALTER TABLE tour_pricing_rules ADD CONSTRAINT tour_pricing_rules_pkey PRIMARY KEY (id);
ALTER TABLE tour_selection_events ADD CONSTRAINT tour_selection_events_pkey PRIMARY KEY (id);
ALTER TABLE tour_selection_items ADD CONSTRAINT tour_selection_items_pkey PRIMARY KEY (id);
ALTER TABLE tour_selections ADD CONSTRAINT tour_selections_pkey PRIMARY KEY (id);
ALTER TABLE tour_transfer_requests ADD CONSTRAINT tour_transfer_requests_pkey PRIMARY KEY (id);
ALTER TABLE tourist_incidents ADD CONSTRAINT tourist_incidents_pkey PRIMARY KEY (id);
ALTER TABLE tours ADD CONSTRAINT tours_pkey PRIMARY KEY (id);
ALTER TABLE trail_reports ADD CONSTRAINT trail_reports_pkey PRIMARY KEY (id);
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_pkey PRIMARY KEY (id);
ALTER TABLE transfer_routes ADD CONSTRAINT transfer_routes_pkey PRIMARY KEY (id);
ALTER TABLE transfer_transactions ADD CONSTRAINT transfer_transactions_pkey PRIMARY KEY (id);
ALTER TABLE transfers ADD CONSTRAINT transfers_pkey PRIMARY KEY (id);
ALTER TABLE uon_sync_log ADD CONSTRAINT uon_sync_log_pkey PRIMARY KEY (id);
ALTER TABLE user_achievements ADD CONSTRAINT user_achievements_pkey PRIMARY KEY (user_id, achievement_id);
ALTER TABLE user_ai_memory ADD CONSTRAINT user_ai_memory_pkey PRIMARY KEY (id);
ALTER TABLE user_eco_activities ADD CONSTRAINT user_eco_activities_pkey PRIMARY KEY (id);
ALTER TABLE user_eco_points ADD CONSTRAINT user_eco_points_pkey PRIMARY KEY (user_id);
ALTER TABLE user_place_photos ADD CONSTRAINT user_place_photos_pkey PRIMARY KEY (id);
ALTER TABLE user_role_history ADD CONSTRAINT user_role_history_pkey PRIMARY KEY (id);
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);
ALTER TABLE user_trips ADD CONSTRAINT user_trips_pkey PRIMARY KEY (id);
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE vehicle_documents ADD CONSTRAINT vehicle_documents_pkey PRIMARY KEY (id);
ALTER TABLE vehicles ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);
ALTER TABLE volcano_status ADD CONSTRAINT volcano_status_pkey PRIMARY KEY (id);
ALTER TABLE weather_alert_bookings ADD CONSTRAINT weather_alert_bookings_pkey PRIMARY KEY (alert_id, booking_id);
ALTER TABLE weather_alerts ADD CONSTRAINT weather_alerts_pkey PRIMARY KEY (id);
ALTER TABLE _agent_route_knowledge_legacy ADD CONSTRAINT agent_route_knowledge_route_dedupe_key_key UNIQUE (route_dedupe_key);
ALTER TABLE _migrations ADD CONSTRAINT _migrations_name_key UNIQUE (name);
ALTER TABLE accommodation_assets ADD CONSTRAINT accommodation_assets_accommodation_id_asset_id_key UNIQUE (accommodation_id, asset_id);
ALTER TABLE activities ADD CONSTRAINT activities_key_key UNIQUE (key);
ALTER TABLE agent_knowledge ADD CONSTRAINT agent_knowledge_slug_key UNIQUE (slug);
ALTER TABLE agent_knowledge_links ADD CONSTRAINT agent_knowledge_links_from_slug_to_slug_key UNIQUE (from_slug, to_slug);
ALTER TABLE agent_market_payments ADD CONSTRAINT agent_market_payments_payment_id_key UNIQUE (payment_id);
ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_agent_id_memory_type_key_key UNIQUE (agent_id, memory_type, key);
ALTER TABLE agent_referral_links ADD CONSTRAINT agent_referral_links_code_key UNIQUE (code);
ALTER TABLE agent_tools ADD CONSTRAINT agent_tools_agent_id_tool_name_key UNIQUE (agent_id, tool_name);
ALTER TABLE articles ADD CONSTRAINT articles_slug_key UNIQUE (slug);
ALTER TABLE assets ADD CONSTRAINT assets_sha256_key UNIQUE (sha256);
ALTER TABLE booking_waivers ADD CONSTRAINT booking_waivers_booking_id_key UNIQUE (booking_id);
ALTER TABLE cancellation_policies ADD CONSTRAINT cancellation_policies_partner_id_tour_id_days_before_key UNIQUE (partner_id, tour_id, days_before);
ALTER TABLE channel_orders ADD CONSTRAINT channel_orders_channel_external_id_key UNIQUE (channel, external_id);
ALTER TABLE collections ADD CONSTRAINT collections_slug_key UNIQUE (slug);
ALTER TABLE conversation_participants ADD CONSTRAINT conversation_participants_conversation_id_user_id_key UNIQUE (conversation_id, user_id);
ALTER TABLE driver_schedules ADD CONSTRAINT driver_schedules_driver_id_date_start_time_key UNIQUE (driver_id, date, start_time);
ALTER TABLE external_alerts ADD CONSTRAINT external_alerts_external_id_key UNIQUE (external_id);
ALTER TABLE external_tools ADD CONSTRAINT external_tools_slug_key UNIQUE (slug);
ALTER TABLE gear_availability ADD CONSTRAINT gear_availability_gear_item_id_date_key UNIQUE (gear_item_id, date);
ALTER TABLE guide_availability ADD CONSTRAINT guide_availability_guide_id_day_of_week_start_time_key UNIQUE (guide_id, day_of_week, start_time);
ALTER TABLE guide_reviews ADD CONSTRAINT guide_reviews_booking_id_tourist_id_key UNIQUE (booking_id, tourist_id);
ALTER TABLE intelligence_sources ADD CONSTRAINT intelligence_sources_url_key UNIQUE (url);
ALTER TABLE kamchatka_routes ADD CONSTRAINT kamchatka_routes_dedupe_key_key UNIQUE (dedupe_key);
ALTER TABLE kamchatka_routes ADD CONSTRAINT kamchatka_routes_slug_unique UNIQUE (slug);
ALTER TABLE location_real_time_status ADD CONSTRAINT location_real_time_status_agent_route_id_key UNIQUE (agent_route_id);
ALTER TABLE location_safety_profile ADD CONSTRAINT location_safety_profile_agent_route_id_key UNIQUE (agent_route_id);
ALTER TABLE octo_api_keys ADD CONSTRAINT octo_api_keys_api_key_key UNIQUE (api_key);
ALTER TABLE operator_ai_config ADD CONSTRAINT operator_ai_config_partner_id_key UNIQUE (partner_id);
ALTER TABLE operator_staff ADD CONSTRAINT operator_staff_email_key UNIQUE (email);
ALTER TABLE operator_staff ADD CONSTRAINT operator_staff_max_chat_id_key UNIQUE (max_chat_id);
ALTER TABLE operator_staff ADD CONSTRAINT operator_staff_telegram_chat_id_key UNIQUE (telegram_chat_id);
ALTER TABLE operator_tours ADD CONSTRAINT operator_tours_operator_id_slug_key UNIQUE (operator_id, slug);
ALTER TABLE parks ADD CONSTRAINT parks_slug_key UNIQUE (slug);
ALTER TABLE partner_integrations ADD CONSTRAINT partner_integrations_partner_id_provider_key UNIQUE (partner_id, provider);
ALTER TABLE partners ADD CONSTRAINT partners_slug_key UNIQUE (slug);
ALTER TABLE places ADD CONSTRAINT uq_places_ark_id UNIQUE (ark_id);
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_code_key UNIQUE (code);
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);
ALTER TABLE rag_feedback ADD CONSTRAINT rag_feedback_message_id_user_id_key UNIQUE (message_id, user_id);
ALTER TABLE referrals ADD CONSTRAINT referrals_referrer_id_referred_id_key UNIQUE (referrer_id, referred_id);
ALTER TABLE route_subcategories ADD CONSTRAINT route_subcategories_category_slug_slug_key UNIQUE (category_slug, slug);
ALTER TABLE route_tags ADD CONSTRAINT route_tags_slug_key UNIQUE (slug);
ALTER TABLE route_waypoints ADD CONSTRAINT route_waypoints_route_id_place_id_key UNIQUE (route_id, place_id);
ALTER TABLE system_settings ADD CONSTRAINT system_settings_key_key UNIQUE (key);
ALTER TABLE tour_availability ADD CONSTRAINT tour_availability_operator_tour_id_date_key UNIQUE (operator_tour_id, date);
ALTER TABLE tour_departures ADD CONSTRAINT tour_departures_tour_id_start_date_key UNIQUE (tour_id, start_date);
ALTER TABLE tour_selections ADD CONSTRAINT tour_selections_code_key UNIQUE (code);
ALTER TABLE tourist_incidents ADD CONSTRAINT tourist_incidents_slug_key UNIQUE (slug);
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_transfer_id_user_id_key UNIQUE (transfer_id, user_id);
ALTER TABLE transfers ADD CONSTRAINT transfers_booking_reference_key UNIQUE (booking_reference);
ALTER TABLE user_ai_memory ADD CONSTRAINT user_ai_memory_user_id_key UNIQUE (user_id);
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_token_key UNIQUE (token);
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE users ADD CONSTRAINT users_referral_code_key UNIQUE (referral_code);
ALTER TABLE users ADD CONSTRAINT users_telegram_id_key UNIQUE (telegram_id);
ALTER TABLE vehicles ADD CONSTRAINT vehicles_license_plate_key UNIQUE (license_plate);
ALTER TABLE volcano_status ADD CONSTRAINT volcano_status_name_normalized_key UNIQUE (name_normalized);
ALTER TABLE _agent_route_knowledge_legacy ADD CONSTRAINT ark_place_shape CHECK ((((kind)::text <> 'place'::text) OR ((activity_type IS NULL) AND (location_type IS NOT NULL)))) NOT VALID;
ALTER TABLE accommodation_availability ADD CONSTRAINT accommodation_availability_available_rooms_check CHECK ((available_rooms >= 0));
ALTER TABLE accommodation_availability ADD CONSTRAINT accommodation_availability_price_override_check CHECK ((price_override >= (0)::numeric));
ALTER TABLE accommodation_bookings ADD CONSTRAINT accommodation_bookings_adults_check CHECK ((adults > 0));
ALTER TABLE accommodation_bookings ADD CONSTRAINT accommodation_bookings_children_check CHECK ((children >= 0));
ALTER TABLE accommodation_bookings ADD CONSTRAINT accommodation_bookings_nights_check CHECK ((nights > 0));
ALTER TABLE accommodation_bookings ADD CONSTRAINT accommodation_bookings_payment_status_check CHECK (((payment_status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'refunded'::character varying, 'partially_refunded'::character varying])::text[])));
ALTER TABLE accommodation_bookings ADD CONSTRAINT accommodation_bookings_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'cancelled'::character varying, 'completed'::character varying, 'no_show'::character varying])::text[])));
ALTER TABLE accommodation_bookings ADD CONSTRAINT check_dates CHECK ((check_out_date > check_in_date));
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_cleanliness_rating_check CHECK (((cleanliness_rating >= 1) AND (cleanliness_rating <= 5)));
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_location_rating_check CHECK (((location_rating >= 1) AND (location_rating <= 5)));
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_overall_rating_check CHECK (((overall_rating >= 1) AND (overall_rating <= 5)));
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_service_rating_check CHECK (((service_rating >= 1) AND (service_rating <= 5)));
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_value_rating_check CHECK (((value_rating >= 1) AND (value_rating <= 5)));
ALTER TABLE accommodation_rooms ADD CONSTRAINT accommodation_rooms_available_rooms_check CHECK ((available_rooms >= 0));
ALTER TABLE accommodation_rooms ADD CONSTRAINT accommodation_rooms_max_guests_check CHECK ((max_guests > 0));
ALTER TABLE accommodation_rooms ADD CONSTRAINT accommodation_rooms_room_type_check CHECK (((room_type)::text = ANY ((ARRAY['single'::character varying, 'double'::character varying, 'twin'::character varying, 'triple'::character varying, 'suite'::character varying, 'family'::character varying, 'dormitory'::character varying])::text[])));
ALTER TABLE accommodations ADD CONSTRAINT accommodations_rating_check CHECK (((rating >= (0)::numeric) AND (rating <= (5)::numeric)));
ALTER TABLE accommodations ADD CONSTRAINT accommodations_star_rating_check CHECK (((star_rating >= 1) AND (star_rating <= 5)));
ALTER TABLE accommodations ADD CONSTRAINT accommodations_total_rooms_check CHECK ((total_rooms > 0));
ALTER TABLE accommodations ADD CONSTRAINT accommodations_type_check CHECK (((type)::text = ANY ((ARRAY['hotel'::character varying, 'hostel'::character varying, 'apartment'::character varying, 'guesthouse'::character varying, 'resort'::character varying, 'camping'::character varying, 'glamping'::character varying, 'cottage'::character varying])::text[])));
ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_execution_status_check CHECK (((execution_status)::text = ANY ((ARRAY['pending'::character varying, 'assigned'::character varying, 'in_progress'::character varying, 'done'::character varying, 'failed'::character varying])::text[])));
ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'expired'::character varying])::text[])));
ALTER TABLE agent_bookings ADD CONSTRAINT agent_bookings_commission_status_check CHECK (((commission_status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'cancelled'::character varying])::text[])));
ALTER TABLE agent_bookings ADD CONSTRAINT agent_bookings_payment_status_check CHECK (((payment_status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'failed'::character varying])::text[])));
ALTER TABLE agent_bookings ADD CONSTRAINT agent_bookings_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'completed'::character varying, 'cancelled'::character varying])::text[])));
ALTER TABLE agent_clients ADD CONSTRAINT agent_clients_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'prospect'::character varying])::text[])));
ALTER TABLE agent_commissions ADD CONSTRAINT agent_commissions_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'cancelled'::character varying])::text[])));
ALTER TABLE agent_experiments ADD CONSTRAINT agent_experiments_status_check CHECK ((status = ANY (ARRAY['running'::text, 'paused'::text, 'completed'::text])));
ALTER TABLE agent_experiments ADD CONSTRAINT agent_experiments_winner_check CHECK ((winner = ANY (ARRAY['a'::text, 'b'::text, 'tie'::text])));
ALTER TABLE agent_referral_events ADD CONSTRAINT agent_referral_events_event_type_check CHECK (((event_type)::text = ANY ((ARRAY['click'::character varying, 'booking'::character varying])::text[])));
ALTER TABLE agent_run_history ADD CONSTRAINT agent_run_history_status_check CHECK (((status)::text = ANY ((ARRAY['success'::character varying, 'partial'::character varying, 'failed'::character varying])::text[])));
ALTER TABLE agent_sdk_sessions ADD CONSTRAINT agent_sdk_sessions_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'fail'::text, 'timeout'::text])));
ALTER TABLE agent_sdk_sessions ADD CONSTRAINT agent_sdk_sessions_variant_check CHECK ((variant = ANY (ARRAY['classic'::text, 'sdk'::text])));
ALTER TABLE board_meeting_sessions ADD CONSTRAINT board_meeting_sessions_status_check CHECK (((status)::text = ANY ((ARRAY['running'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])));
ALTER TABLE booking_change_requests ADD CONSTRAINT booking_change_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'awaiting_payment'::text, 'completed'::text, 'cancelled'::text])));
ALTER TABLE booking_transfers ADD CONSTRAINT booking_transfers_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'rejected'::character varying, 'completed'::character varying])::text[])));
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check CHECK (((payment_status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'refunded'::character varying])::text[])));
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'awaiting_payment'::character varying, 'deposit_paid'::character varying, 'confirmed'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'cancelled'::character varying, 'cancelled_by_tourist'::character varying, 'cancelled_by_operator'::character varying, 'refunded'::character varying])::text[])));
ALTER TABLE bookings ADD CONSTRAINT chk_guests_count_positive CHECK ((guests_count > 0));
ALTER TABLE cancellation_policies ADD CONSTRAINT cancellation_policies_days_before_check CHECK ((days_before >= 0));
ALTER TABLE cancellation_policies ADD CONSTRAINT cancellation_policies_refund_percent_check CHECK (((refund_percent >= (0)::numeric) AND (refund_percent <= (100)::numeric)));
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_role_check CHECK (((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying])::text[])));
ALTER TABLE collections ADD CONSTRAINT collections_rule_kind_check CHECK (((rule_kind IS NULL) OR ((rule_kind)::text = ANY ((ARRAY['place'::character varying, 'route'::character varying])::text[]))));
ALTER TABLE commission_payouts ADD CONSTRAINT commission_payouts_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'paid'::character varying, 'failed'::character varying])::text[])));
ALTER TABLE danger_assessments ADD CONSTRAINT danger_assessments_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)));
ALTER TABLE danger_assessments ADD CONSTRAINT danger_assessments_risk_level_check CHECK ((risk_level = ANY (ARRAY['low'::text, 'moderate'::text, 'high'::text, 'critical'::text])));
ALTER TABLE danger_assessments ADD CONSTRAINT danger_assessments_risk_score_check CHECK (((risk_score >= 0) AND (risk_score <= 100)));
ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_status_check CHECK (((status)::text = ANY ((ARRAY['valid'::character varying, 'expiring'::character varying, 'expired'::character varying])::text[])));
ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_type_check CHECK (((type)::text = ANY ((ARRAY['license'::character varying, 'passport'::character varying, 'medical'::character varying, 'background_check'::character varying, 'contract'::character varying, 'other'::character varying])::text[])));
ALTER TABLE driver_schedules ADD CONSTRAINT driver_schedules_type_check CHECK (((type)::text = ANY ((ARRAY['available'::character varying, 'booked'::character varying, 'maintenance'::character varying, 'off'::character varying, 'sick'::character varying, 'vacation'::character varying])::text[])));
ALTER TABLE drivers ADD CONSTRAINT drivers_rating_check CHECK (((rating >= (0)::numeric) AND (rating <= (5)::numeric)));
ALTER TABLE drivers ADD CONSTRAINT drivers_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'suspended'::character varying, 'on_leave'::character varying])::text[])));
ALTER TABLE eco_balances ADD CONSTRAINT eco_balances_no_overdraft CHECK (((balance >= 0) OR (account ~~ 'system:%'::text)));
ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_claims_amounts_sane CHECK (((eco_amount > 0) AND (rub_amount >= (0)::numeric)));
ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_claims_operator_named CHECK (((payer <> 'operator'::text) OR (operator_id IS NOT NULL)));
ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_claims_payer_known CHECK ((payer = ANY (ARRAY['platform'::text, 'operator'::text])));
ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_claims_status_known CHECK ((status = ANY (ARRAY['pending'::text, 'settled'::text, 'waived'::text])));
ALTER TABLE eco_ledger ADD CONSTRAINT eco_ledger_accounts_differ CHECK ((debit_account <> credit_account));
ALTER TABLE eco_ledger ADD CONSTRAINT eco_ledger_amount_positive CHECK ((amount > 0));
ALTER TABLE eco_ledger ADD CONSTRAINT eco_ledger_operation_known CHECK ((operation = ANY (ARRAY['opening'::text, 'emit'::text, 'redeem'::text, 'transfer'::text, 'expire'::text, 'refund'::text, 'adjust'::text])));
ALTER TABLE eco_points ADD CONSTRAINT eco_points_category_check CHECK (((category)::text = ANY ((ARRAY['recycling'::character varying, 'cleaning'::character varying, 'conservation'::character varying, 'education'::character varying])::text[])));
ALTER TABLE emergency_contacts ADD CONSTRAINT chk_emergency_contacts_purpose CHECK (((purpose IS NULL) OR ((purpose)::text = ANY ((ARRAY['emergency'::character varying, 'registration'::character varying, 'consultation'::character varying, 'permit'::character varying])::text[]))));
ALTER TABLE emergency_contacts ADD CONSTRAINT chk_emergency_contacts_source CHECK (((source IS NULL) OR ((source)::text = ANY ((ARRAY['code'::character varying, 'visitkamchatka'::character varying, 'seed'::character varying, 'verified'::character varying])::text[]))));
ALTER TABLE faqs ADD CONSTRAINT faqs_priority_check CHECK (((priority >= 1) AND (priority <= 100)));
ALTER TABLE gear_rentals ADD CONSTRAINT gear_rentals_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'active'::character varying, 'completed'::character varying, 'cancelled'::character varying, 'overdue'::character varying])::text[])));
ALTER TABLE guide_availability ADD CONSTRAINT guide_availability_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6)));
ALTER TABLE guide_earnings ADD CONSTRAINT guide_earnings_payment_status_check CHECK (((payment_status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'cancelled'::character varying])::text[])));
ALTER TABLE guide_groups ADD CONSTRAINT guide_groups_status_check CHECK (((status)::text = ANY ((ARRAY['forming'::character varying, 'ready'::character varying, 'departed'::character varying, 'returned'::character varying])::text[])));
ALTER TABLE guide_reviews ADD CONSTRAINT guide_reviews_communication_rating_check CHECK (((communication_rating >= 1) AND (communication_rating <= 5)));
ALTER TABLE guide_reviews ADD CONSTRAINT guide_reviews_knowledge_rating_check CHECK (((knowledge_rating >= 1) AND (knowledge_rating <= 5)));
ALTER TABLE guide_reviews ADD CONSTRAINT guide_reviews_professionalism_rating_check CHECK (((professionalism_rating >= 1) AND (professionalism_rating <= 5)));
ALTER TABLE guide_reviews ADD CONSTRAINT guide_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE guide_schedule ADD CONSTRAINT guide_schedule_status_check CHECK (((status)::text = ANY ((ARRAY['scheduled'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'cancelled'::character varying])::text[])));
ALTER TABLE kamchatka_routes ADD CONSTRAINT chk_routes_kamchatka_bbox CHECK (((lat IS NULL) OR (lng IS NULL) OR (((lat >= (50)::numeric) AND (lat <= (64)::numeric)) AND ((lng >= (155)::numeric) AND (lng <= (170)::numeric)))));
ALTER TABLE lead_followups ADD CONSTRAINT lead_followups_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'skipped'::character varying, 'cancelled'::character varying])::text[])));
ALTER TABLE lead_proposals ADD CONSTRAINT lead_proposals_conversion_prob_check CHECK (((conversion_prob >= 0) AND (conversion_prob <= 100)));
ALTER TABLE lead_proposals ADD CONSTRAINT lead_proposals_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'sent'::character varying, 'accepted'::character varying, 'declined'::character varying, 'expired'::character varying])::text[])));
ALTER TABLE leads ADD CONSTRAINT leads_ai_score_check CHECK (((ai_score >= 0) AND (ai_score <= 100)));
ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'ai_processing'::character varying, 'ai_qualified'::character varying, 'proposal_sent'::character varying, 'awaiting_confirm'::character varying, 'contacted'::character varying, 'qualified'::character varying, 'converted'::character varying, 'lost'::character varying])::text[])));
ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_amount_check CHECK ((amount > 0));
ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_type_check CHECK (((type)::text = ANY ((ARRAY['earn'::character varying, 'redeem'::character varying, 'expire'::character varying, 'refund'::character varying])::text[])));
ALTER TABLE mchs_group_registrations ADD CONSTRAINT mchs_group_registrations_status_check CHECK (((status)::text = ANY ((ARRAY['submitted'::character varying, 'registered'::character varying, 'rejected'::character varying, 'failed'::character varying])::text[])));
ALTER TABLE mchs_registrations ADD CONSTRAINT mchs_registrations_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'submitted'::character varying, 'confirmed'::character varying, 'rejected'::character varying])::text[])));
ALTER TABLE notification_log ADD CONSTRAINT notification_log_channel_check CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'push'::character varying, 'sms'::character varying, 'in_app'::character varying])::text[])));
ALTER TABLE notification_log ADD CONSTRAINT notification_log_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'failed'::character varying, 'delivered'::character varying, 'bounced'::character varying])::text[])));
ALTER TABLE notifications ADD CONSTRAINT notifications_priority_check CHECK (((priority)::text = ANY ((ARRAY['low'::character varying, 'normal'::character varying, 'high'::character varying, 'urgent'::character varying])::text[])));
ALTER TABLE operator_ai_actions ADD CONSTRAINT operator_ai_actions_status_check CHECK ((status = ANY (ARRAY['pending_approval'::text, 'executed'::text, 'rejected'::text, 'expired'::text])));
ALTER TABLE operator_applications ADD CONSTRAINT operator_applications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE operator_bookings ADD CONSTRAINT participants_valid CHECK ((participants > 0));
ALTER TABLE operator_bookings ADD CONSTRAINT price_valid CHECK ((final_price >= (0)::numeric));
ALTER TABLE operator_payouts ADD CONSTRAINT operator_payouts_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'PROCESSING'::character varying, 'PAID'::character varying, 'FAILED'::character varying])::text[])));
ALTER TABLE operator_staff ADD CONSTRAINT operator_staff_employment_type_check CHECK ((employment_type = ANY (ARRAY['staff'::text, 'contractor'::text, 'self_employed'::text])));
ALTER TABLE operator_staff ADD CONSTRAINT operator_staff_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'manager'::text, 'guide'::text])));
ALTER TABLE operator_tour_reviews ADD CONSTRAINT operator_tour_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE operator_tours ADD CONSTRAINT participants_valid CHECK ((max_participants >= min_participants));
ALTER TABLE operator_tours ADD CONSTRAINT price_positive CHECK ((base_price > (0)::numeric));
ALTER TABLE operator_vehicles ADD CONSTRAINT operator_vehicles_capacity_check CHECK ((capacity > 0));
ALTER TABLE operator_vehicles ADD CONSTRAINT operator_vehicles_vehicle_type_check CHECK ((vehicle_type = ANY (ARRAY['minibus'::text, 'bus'::text, 'van'::text, '4x4'::text, 'boat'::text, 'helicopter'::text, 'other'::text])));
ALTER TABLE outreach_queue ADD CONSTRAINT outreach_queue_status_check CHECK (((status)::text = ANY ((ARRAY['found'::character varying, 'contacted'::character varying, 'replied'::character varying, 'registered'::character varying, 'declined'::character varying])::text[])));
ALTER TABLE partner_prospects ADD CONSTRAINT partner_prospects_status_check CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'agreed'::text, 'declined'::text])));
ALTER TABLE partners ADD CONSTRAINT partners_category_check CHECK (((category)::text = ANY ((ARRAY['operator'::character varying, 'guide'::character varying, 'transfer'::character varying, 'stay'::character varying, 'gear'::character varying, 'agent'::character varying, 'souvenir'::character varying, 'cars'::character varying, 'restaurant'::character varying])::text[])));
ALTER TABLE partners ADD CONSTRAINT partners_profile_status_check CHECK ((profile_status = ANY (ARRAY['none'::text, 'pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE partners ADD CONSTRAINT partners_registry_status_check CHECK (((registry_status)::text = ANY ((ARRAY['unknown'::character varying, 'verified'::character varying, 'not_found'::character varying, 'mismatch'::character varying])::text[])));
ALTER TABLE partners ADD CONSTRAINT partners_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'active'::character varying, 'suspended'::character varying, 'rejected'::character varying])::text[])));
ALTER TABLE place_safety_reports ADD CONSTRAINT place_safety_reports_note_check CHECK ((char_length(note) <= 300));
ALTER TABLE places ADD CONSTRAINT chk_places_kamchatka_bbox CHECK (((lat IS NULL) OR (lng IS NULL) OR ((((lat)::double precision >= (50.0)::double precision) AND ((lat)::double precision <= (62.0)::double precision)) AND (((lng)::double precision >= (154.0)::double precision) AND ((lng)::double precision <= (170.0)::double precision))))) NOT VALID;
ALTER TABLE places ADD CONSTRAINT places_shape_check CHECK (((activity_type IS NULL) AND (location_type IS NOT NULL))) NOT VALID;
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_discount_type_check CHECK (((discount_type)::text = ANY ((ARRAY['percentage'::character varying, 'fixed'::character varying])::text[])));
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_discount_value_check CHECK ((discount_value > (0)::numeric));
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_max_uses_check CHECK ((max_uses > 0));
ALTER TABLE rag_feedback ADD CONSTRAINT rag_feedback_rating_check CHECK ((rating = ANY (ARRAY['-1'::integer, 1])));
ALTER TABLE rag_quality_log ADD CONSTRAINT rag_quality_log_completeness_score_check CHECK (((completeness_score >= 1) AND (completeness_score <= 5)));
ALTER TABLE rag_quality_log ADD CONSTRAINT rag_quality_log_relevance_score_check CHECK (((relevance_score >= 1) AND (relevance_score <= 5)));
ALTER TABLE referrals ADD CONSTRAINT referrals_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'expired'::character varying])::text[])));
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'skipped'::text])));
ALTER TABLE reviews ADD CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE route_registration_notifications ADD CONSTRAINT route_registration_notifications_channel_check CHECK (((channel)::text = ANY ((ARRAY['telegram'::character varying, 'email'::character varying, 'max'::character varying, 'none'::character varying, 'telegram+email'::character varying, 'admin_only'::character varying])::text[])));
ALTER TABLE route_registration_notifications ADD CONSTRAINT route_registration_notifications_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])));
ALTER TABLE route_registration_notifications ADD CONSTRAINT route_registration_notifications_step_check CHECK (((step >= 1) AND (step <= 4)));
ALTER TABLE route_registrations ADD CONSTRAINT route_registrations_group_size_check CHECK (((group_size >= 1) AND (group_size <= 30)));
ALTER TABLE route_registrations ADD CONSTRAINT route_registrations_mchs_status_check CHECK (((mchs_status)::text = ANY ((ARRAY['not_submitted'::character varying, 'submitted'::character varying, 'confirmed'::character varying, 'rejected'::character varying])::text[])));
ALTER TABLE route_registrations ADD CONSTRAINT route_registrations_trip_kind_check CHECK (((trip_kind)::text = ANY ((ARRAY['day'::character varying, 'multi'::character varying])::text[])));
ALTER TABLE route_templates ADD CONSTRAINT route_templates_difficulty_check CHECK (((difficulty)::text = ANY ((ARRAY['easy'::character varying, 'medium'::character varying, 'hard'::character varying])::text[])));
ALTER TABLE safety_alerts ADD CONSTRAINT safety_alerts_severity_check CHECK (((severity)::text = ANY ((ARRAY['critical'::character varying, 'important'::character varying, 'info'::character varying])::text[])));
ALTER TABLE safety_alerts ADD CONSTRAINT safety_alerts_zone_check CHECK (((zone)::text = ANY ((ARRAY['avachinsky'::character varying, 'western'::character varying, 'eastern'::character varying, 'northern'::character varying, 'all'::character varying])::text[])));
ALTER TABLE sos_events ADD CONSTRAINT sos_events_source_check CHECK (((source)::text = ANY ((ARRAY['direct'::character varying, 'mesh_relay'::character varying])::text[])));
ALTER TABLE sos_events ADD CONSTRAINT sos_events_status_check CHECK (((status)::text = ANY ((ARRAY['sent'::character varying, 'acknowledged'::character varying, 'resolved'::character varying, 'false_alarm'::character varying])::text[])));
ALTER TABLE tg_conversations ADD CONSTRAINT tg_conversations_mode_check CHECK (((mode)::text = ANY ((ARRAY['admin'::character varying, 'tourist'::character varying, 'max'::character varying, 'telegram'::character varying])::text[])));
ALTER TABLE tg_conversations ADD CONSTRAINT tg_conversations_role_check CHECK (((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying])::text[])));
ALTER TABLE tg_ratings ADD CONSTRAINT tg_ratings_rating_check CHECK ((rating = ANY (ARRAY[1, 5])));
ALTER TABLE tour_availability ADD CONSTRAINT booked_valid CHECK (((booked_slots >= 0) AND (booked_slots <= available_slots)));
ALTER TABLE tour_availability ADD CONSTRAINT slots_valid CHECK ((available_slots > 0));
ALTER TABLE tour_departures ADD CONSTRAINT tour_departures_status_check CHECK ((status = ANY (ARRAY['active'::text, 'sold_out'::text, 'cancelled'::text, 'archived'::text])));
ALTER TABLE tour_payments ADD CONSTRAINT tour_payments_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'HELD'::character varying, 'RELEASED'::character varying, 'REFUNDED'::character varying, 'DISPUTED'::character varying, 'FAILED'::character varying])::text[])));
ALTER TABLE tour_pricing_rules ADD CONSTRAINT tour_pricing_rules_rule_type_check CHECK (((rule_type)::text = ANY ((ARRAY['season_peak'::character varying, 'season_low'::character varying, 'early_bird'::character varying, 'last_minute'::character varying, 'occupancy_high'::character varying, 'group_discount'::character varying, 'weekend'::character varying])::text[])));
ALTER TABLE tour_transfer_requests ADD CONSTRAINT tour_transfer_requests_reason_check CHECK ((reason = ANY (ARRAY['weather'::text, 'guide_sick'::text, 'force_majeure'::text, 'capacity'::text, 'other'::text])));
ALTER TABLE tour_transfer_requests ADD CONSTRAINT tour_transfer_requests_status_check CHECK ((status = ANY (ARRAY['searching'::text, 'proposed'::text, 'accepted'::text, 'rejected'::text, 'completed'::text, 'expired'::text])));
ALTER TABLE tours ADD CONSTRAINT tours_difficulty_check CHECK (((difficulty)::text = ANY ((ARRAY['easy'::character varying, 'medium'::character varying, 'hard'::character varying])::text[])));
ALTER TABLE trail_reports ADD CONSTRAINT trail_reports_report_type_check CHECK (((report_type)::text = ANY ((ARRAY['bear'::character varying, 'rockfall'::character varying, 'weather'::character varying, 'other'::character varying])::text[])));
ALTER TABLE trail_reports ADD CONSTRAINT trail_reports_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[])));
ALTER TABLE trail_reports ADD CONSTRAINT trail_reports_text_check CHECK (((length(text) >= 3) AND (length(text) <= 500)));
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_driver_rating_check CHECK (((driver_rating >= 1) AND (driver_rating <= 5)));
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_punctuality_rating_check CHECK (((punctuality_rating >= 1) AND (punctuality_rating <= 5)));
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_vehicle_rating_check CHECK (((vehicle_rating >= 1) AND (vehicle_rating <= 5)));
ALTER TABLE transfer_transactions ADD CONSTRAINT transfer_transactions_type_check CHECK (((type)::text = ANY ((ARRAY['booking'::character varying, 'refund'::character varying, 'fuel'::character varying, 'maintenance'::character varying, 'driver_payment'::character varying, 'insurance'::character varying, 'fine'::character varying, 'other'::character varying])::text[])));
ALTER TABLE transfers ADD CONSTRAINT transfers_passengers_check CHECK ((passengers > 0));
ALTER TABLE transfers ADD CONSTRAINT transfers_payment_status_check CHECK (((payment_status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'refunded'::character varying, 'partially_refunded'::character varying])::text[])));
ALTER TABLE transfers ADD CONSTRAINT transfers_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE transfers ADD CONSTRAINT transfers_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'assigned'::character varying, 'confirmed'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'cancelled'::character varying, 'delayed'::character varying])::text[])));
ALTER TABLE user_place_photos ADD CONSTRAINT user_place_photos_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['tourist'::character varying, 'operator'::character varying, 'guide'::character varying, 'transfer'::character varying, 'agent'::character varying, 'admin'::character varying])::text[])));
ALTER TABLE vehicle_documents ADD CONSTRAINT vehicle_documents_status_check CHECK (((status)::text = ANY ((ARRAY['valid'::character varying, 'expiring'::character varying, 'expired'::character varying])::text[])));
ALTER TABLE vehicle_documents ADD CONSTRAINT vehicle_documents_type_check CHECK (((type)::text = ANY ((ARRAY['insurance'::character varying, 'registration'::character varying, 'inspection'::character varying, 'license'::character varying, 'other'::character varying])::text[])));
ALTER TABLE vehicles ADD CONSTRAINT vehicles_capacity_check CHECK ((capacity > 0));
ALTER TABLE vehicles ADD CONSTRAINT vehicles_category_check CHECK (((category)::text = ANY ((ARRAY['economy'::character varying, 'comfort'::character varying, 'business'::character varying, 'premium'::character varying])::text[])));
ALTER TABLE vehicles ADD CONSTRAINT vehicles_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'maintenance'::character varying, 'inactive'::character varying])::text[])));
ALTER TABLE vehicles ADD CONSTRAINT vehicles_type_check CHECK (((type)::text = ANY ((ARRAY['car'::character varying, 'minivan'::character varying, 'bus'::character varying, 'helicopter'::character varying, 'boat'::character varying])::text[])));
ALTER TABLE volcano_status ADD CONSTRAINT volcano_status_aviation_color_code_check CHECK ((aviation_color_code = ANY (ARRAY['green'::text, 'yellow'::text, 'orange'::text, 'red'::text, 'unassigned'::text])));
ALTER TABLE weather_alerts ADD CONSTRAINT severity_valid CHECK (((severity)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying])::text[])));
ALTER TABLE _route_description_cache_legacy ADD CONSTRAINT route_description_cache_route_id_fkey FOREIGN KEY (route_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE accommodation_assets ADD CONSTRAINT accommodation_assets_accommodation_id_fkey FOREIGN KEY (accommodation_id) REFERENCES accommodations(id) ON DELETE CASCADE;
ALTER TABLE accommodation_assets ADD CONSTRAINT accommodation_assets_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE accommodation_availability ADD CONSTRAINT accommodation_availability_accommodation_id_fkey FOREIGN KEY (accommodation_id) REFERENCES accommodations(id) ON DELETE CASCADE;
ALTER TABLE accommodation_availability ADD CONSTRAINT accommodation_availability_room_id_fkey FOREIGN KEY (room_id) REFERENCES accommodation_rooms(id) ON DELETE CASCADE;
ALTER TABLE accommodation_bookings ADD CONSTRAINT accommodation_bookings_accommodation_id_fkey FOREIGN KEY (accommodation_id) REFERENCES accommodations(id);
ALTER TABLE accommodation_bookings ADD CONSTRAINT accommodation_bookings_room_id_fkey FOREIGN KEY (room_id) REFERENCES accommodation_rooms(id);
ALTER TABLE accommodation_bookings ADD CONSTRAINT accommodation_bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_accommodation_id_fkey FOREIGN KEY (accommodation_id) REFERENCES accommodations(id);
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES accommodation_bookings(id);
ALTER TABLE accommodation_reviews ADD CONSTRAINT accommodation_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE accommodation_rooms ADD CONSTRAINT accommodation_rooms_accommodation_id_fkey FOREIGN KEY (accommodation_id) REFERENCES accommodations(id) ON DELETE CASCADE;
ALTER TABLE accommodations ADD CONSTRAINT accommodations_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES agent_approvals(id);
ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id);
ALTER TABLE agent_bookings ADD CONSTRAINT agent_bookings_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES users(id);
ALTER TABLE agent_bookings ADD CONSTRAINT agent_bookings_client_id_fkey FOREIGN KEY (client_id) REFERENCES agent_clients(id);
ALTER TABLE agent_bookings ADD CONSTRAINT agent_bookings_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES operator_tours(id);
ALTER TABLE agent_clients ADD CONSTRAINT agent_clients_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE agent_commissions ADD CONSTRAINT agent_commissions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES users(id);
ALTER TABLE agent_commissions ADD CONSTRAINT agent_commissions_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES agent_bookings(id);
ALTER TABLE agent_knowledge_links ADD CONSTRAINT agent_knowledge_links_from_slug_fkey FOREIGN KEY (from_slug) REFERENCES agent_knowledge(slug) ON DELETE CASCADE;
ALTER TABLE agent_knowledge_links ADD CONSTRAINT agent_knowledge_links_to_slug_fkey FOREIGN KEY (to_slug) REFERENCES agent_knowledge(slug) ON DELETE CASCADE;
ALTER TABLE agent_memory_edits ADD CONSTRAINT agent_memory_edits_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES agent_memory(id) ON DELETE CASCADE;
ALTER TABLE agent_referral_events ADD CONSTRAINT agent_referral_events_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES operator_bookings(id);
ALTER TABLE agent_referral_events ADD CONSTRAINT agent_referral_events_link_id_fkey FOREIGN KEY (link_id) REFERENCES agent_referral_links(id);
ALTER TABLE agent_referral_links ADD CONSTRAINT agent_referral_links_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES users(id);
ALTER TABLE agent_referral_links ADD CONSTRAINT agent_referral_links_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES operator_tours(id);
ALTER TABLE agent_sdk_sessions ADD CONSTRAINT agent_sdk_sessions_experiment_id_fkey FOREIGN KEY (experiment_id) REFERENCES agent_experiments(id) ON DELETE SET NULL;
ALTER TABLE approval_execution_log ADD CONSTRAINT approval_execution_log_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES agent_approvals(id) ON DELETE CASCADE;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE board_meeting_sessions ADD CONSTRAINT board_meeting_sessions_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES users(id);
ALTER TABLE booking_change_requests ADD CONSTRAINT booking_change_requests_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES operator_bookings(id);
ALTER TABLE booking_change_requests ADD CONSTRAINT booking_change_requests_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES operator_staff(id);
ALTER TABLE booking_change_requests ADD CONSTRAINT booking_change_requests_new_tour_id_fkey FOREIGN KEY (new_tour_id) REFERENCES operator_tours(id);
ALTER TABLE booking_change_requests ADD CONSTRAINT booking_change_requests_old_tour_id_fkey FOREIGN KEY (old_tour_id) REFERENCES operator_tours(id);
ALTER TABLE booking_change_requests ADD CONSTRAINT booking_change_requests_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id);
ALTER TABLE booking_change_requests ADD CONSTRAINT booking_change_requests_refund_request_id_fkey FOREIGN KEY (refund_request_id) REFERENCES refund_requests(id);
ALTER TABLE booking_group_members ADD CONSTRAINT booking_group_members_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES operator_bookings(id) ON DELETE CASCADE;
ALTER TABLE booking_transfers ADD CONSTRAINT booking_transfers_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id);
ALTER TABLE booking_transfers ADD CONSTRAINT booking_transfers_from_operator_id_fkey FOREIGN KEY (from_operator_id) REFERENCES partners(id);
ALTER TABLE booking_transfers ADD CONSTRAINT booking_transfers_to_operator_id_fkey FOREIGN KEY (to_operator_id) REFERENCES partners(id);
ALTER TABLE booking_waivers ADD CONSTRAINT booking_waivers_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES operator_bookings(id) ON DELETE CASCADE;
ALTER TABLE booking_waivers ADD CONSTRAINT booking_waivers_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE bookings ADD CONSTRAINT bookings_departure_id_fkey FOREIGN KEY (departure_id) REFERENCES tour_departures(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES tours(id);
ALTER TABLE bookings ADD CONSTRAINT bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE cancellation_policies ADD CONSTRAINT cancellation_policies_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE cancellation_policies ADD CONSTRAINT cancellation_policies_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE channel_orders ADD CONSTRAINT channel_orders_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES operator_tours(id) ON DELETE SET NULL;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE client_communications ADD CONSTRAINT client_communications_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE client_communications ADD CONSTRAINT client_communications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES users(id);
ALTER TABLE client_communications ADD CONSTRAINT client_communications_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id);
ALTER TABLE collections ADD CONSTRAINT collections_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE commission_payouts ADD CONSTRAINT commission_payouts_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES users(id);
ALTER TABLE contingency_rules ADD CONSTRAINT contingency_rules_alternative_tour_id_fkey FOREIGN KEY (alternative_tour_id) REFERENCES operator_tours(id);
ALTER TABLE contingency_rules ADD CONSTRAINT contingency_rules_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id);
ALTER TABLE contingency_rules ADD CONSTRAINT contingency_rules_primary_tour_id_fkey FOREIGN KEY (primary_tour_id) REFERENCES operator_tours(id);
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id);
ALTER TABLE conversation_participants ADD CONSTRAINT conversation_participants_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE conversation_participants ADD CONSTRAINT conversation_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD CONSTRAINT conversations_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE conversations ADD CONSTRAINT conversations_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES tours(id) ON DELETE SET NULL;
ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE driver_schedules ADD CONSTRAINT driver_schedules_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE driver_schedules ADD CONSTRAINT driver_schedules_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE SET NULL;
ALTER TABLE driver_schedules ADD CONSTRAINT driver_schedules_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE drivers ADD CONSTRAINT drivers_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE drivers ADD CONSTRAINT drivers_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE eco_compensation_claims ADD CONSTRAINT eco_compensation_claims_ledger_id_fkey FOREIGN KEY (ledger_id) REFERENCES eco_ledger(id);
ALTER TABLE evo_evolution_log ADD CONSTRAINT evo_evolution_log_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES evo_growth_issues(id) ON DELETE SET NULL;
ALTER TABLE evo_feedback ADD CONSTRAINT evo_feedback_evolution_id_fkey FOREIGN KEY (evolution_id) REFERENCES evo_evolution_log(id) ON DELETE SET NULL;
ALTER TABLE evo_growth_issues ADD CONSTRAINT evo_growth_issues_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES evo_growth_scans(id) ON DELETE CASCADE;
ALTER TABLE gear_availability ADD CONSTRAINT gear_availability_gear_item_id_fkey FOREIGN KEY (gear_item_id) REFERENCES gear_items(id) ON DELETE CASCADE;
ALTER TABLE gear_items ADD CONSTRAINT gear_items_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE gear_rentals ADD CONSTRAINT gear_rentals_gear_id_fkey FOREIGN KEY (gear_id) REFERENCES gear_items(id) ON DELETE CASCADE;
ALTER TABLE guide_availability ADD CONSTRAINT guide_availability_guide_id_fkey FOREIGN KEY (guide_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE guide_certifications ADD CONSTRAINT guide_certifications_guide_id_fkey FOREIGN KEY (guide_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE guide_earnings ADD CONSTRAINT guide_earnings_guide_id_fkey FOREIGN KEY (guide_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE guide_earnings ADD CONSTRAINT guide_earnings_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES guide_schedule(id) ON DELETE SET NULL;
ALTER TABLE guide_earnings ADD CONSTRAINT guide_earnings_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES tours(id);
ALTER TABLE guide_groups ADD CONSTRAINT guide_groups_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES guide_schedule(id) ON DELETE CASCADE;
ALTER TABLE guide_reviews ADD CONSTRAINT guide_reviews_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE guide_reviews ADD CONSTRAINT guide_reviews_guide_id_fkey FOREIGN KEY (guide_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE guide_reviews ADD CONSTRAINT guide_reviews_tourist_id_fkey FOREIGN KEY (tourist_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE guide_schedule ADD CONSTRAINT guide_schedule_guide_id_fkey FOREIGN KEY (guide_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE guide_schedule ADD CONSTRAINT guide_schedule_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES tours(id);
ALTER TABLE kuzmich_engagement_signals ADD CONSTRAINT kuzmich_engagement_signals_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE kuzmich_engagement_signals ADD CONSTRAINT kuzmich_engagement_signals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE lead_activity_log ADD CONSTRAINT lead_activity_log_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE lead_followups ADD CONSTRAINT lead_followups_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE lead_proposals ADD CONSTRAINT lead_proposals_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE lead_proposals ADD CONSTRAINT lead_proposals_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE SET NULL;
ALTER TABLE leads ADD CONSTRAINT leads_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE SET NULL;
ALTER TABLE leads ADD CONSTRAINT leads_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES lead_proposals(id) ON DELETE SET NULL;
ALTER TABLE location_real_time_status ADD CONSTRAINT fk_lrts_place FOREIGN KEY (agent_route_id) REFERENCES places(ark_id) ON DELETE CASCADE;
ALTER TABLE location_safety_profile ADD CONSTRAINT fk_lsp_place FOREIGN KEY (agent_route_id) REFERENCES places(ark_id) ON DELETE CASCADE;
ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE mchs_group_registrations ADD CONSTRAINT mchs_group_registrations_operator_partner_id_fkey FOREIGN KEY (operator_partner_id) REFERENCES partners(id);
ALTER TABLE mchs_group_registrations ADD CONSTRAINT mchs_group_registrations_operator_user_id_fkey FOREIGN KEY (operator_user_id) REFERENCES users(id);
ALTER TABLE mchs_registrations ADD CONSTRAINT mchs_registrations_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id);
ALTER TABLE mchs_registrations ADD CONSTRAINT mchs_registrations_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id);
ALTER TABLE message_templates ADD CONSTRAINT message_templates_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE notification_log ADD CONSTRAINT notification_log_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE octo_api_keys ADD CONSTRAINT octo_api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE octo_api_keys ADD CONSTRAINT octo_api_keys_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE octo_booking_log ADD CONSTRAINT octo_booking_log_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES octo_api_keys(id);
ALTER TABLE octo_booking_log ADD CONSTRAINT octo_booking_log_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES operator_bookings(id);
ALTER TABLE octo_webhook_log ADD CONSTRAINT octo_webhook_log_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES octo_api_keys(id);
ALTER TABLE octo_webhook_log ADD CONSTRAINT octo_webhook_log_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES operator_bookings(id);
ALTER TABLE official_registry_operators ADD CONSTRAINT official_registry_operators_matched_partner_id_fkey FOREIGN KEY (matched_partner_id) REFERENCES partners(id) ON DELETE SET NULL;
ALTER TABLE operator_ai_actions ADD CONSTRAINT operator_ai_actions_actor_staff_id_fkey FOREIGN KEY (actor_staff_id) REFERENCES operator_staff(id);
ALTER TABLE operator_ai_actions ADD CONSTRAINT operator_ai_actions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES operator_staff(id);
ALTER TABLE operator_ai_actions ADD CONSTRAINT operator_ai_actions_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id);
ALTER TABLE operator_ai_config ADD CONSTRAINT operator_ai_config_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE operator_applications ADD CONSTRAINT operator_applications_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE operator_applications ADD CONSTRAINT operator_applications_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id);
ALTER TABLE operator_applications ADD CONSTRAINT operator_applications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE operator_bookings ADD CONSTRAINT operator_bookings_alternative_offered_tour_id_fkey FOREIGN KEY (alternative_offered_tour_id) REFERENCES operator_tours(id);
ALTER TABLE operator_bookings ADD CONSTRAINT operator_bookings_octo_api_key_id_fkey FOREIGN KEY (octo_api_key_id) REFERENCES octo_api_keys(id);
ALTER TABLE operator_bookings ADD CONSTRAINT operator_bookings_operator_tour_id_fkey FOREIGN KEY (operator_tour_id) REFERENCES operator_tours(id);
ALTER TABLE operator_bookings ADD CONSTRAINT operator_bookings_option_id_fkey FOREIGN KEY (option_id) REFERENCES tour_options(id);
ALTER TABLE operator_bookings ADD CONSTRAINT operator_bookings_referral_link_id_fkey FOREIGN KEY (referral_link_id) REFERENCES agent_referral_links(id);
ALTER TABLE operator_payouts ADD CONSTRAINT operator_payouts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE operator_payouts ADD CONSTRAINT operator_payouts_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id);
ALTER TABLE operator_settings ADD CONSTRAINT operator_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE operator_signups ADD CONSTRAINT operator_signups_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE operator_signups ADD CONSTRAINT operator_signups_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE operator_staff ADD CONSTRAINT operator_staff_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE operator_staff ADD CONSTRAINT operator_staff_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE operator_stats_cache ADD CONSTRAINT operator_stats_cache_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE operator_tour_reviews ADD CONSTRAINT operator_tour_reviews_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES operator_tours(id);
ALTER TABLE operator_tour_reviews ADD CONSTRAINT operator_tour_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE operator_tour_tags ADD CONSTRAINT operator_tour_tags_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE operator_tours ADD CONSTRAINT fk_ot_route FOREIGN KEY (route_id) REFERENCES kamchatka_routes(id) ON DELETE SET NULL;
ALTER TABLE operator_tours ADD CONSTRAINT operator_tours_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE operator_tours ADD CONSTRAINT operator_tours_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE operator_vehicles ADD CONSTRAINT operator_vehicles_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE partner_assets ADD CONSTRAINT partner_assets_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE partner_assets ADD CONSTRAINT partner_assets_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE partner_integrations ADD CONSTRAINT partner_integrations_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE partners ADD CONSTRAINT fk_partners_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE partners ADD CONSTRAINT partners_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE partners ADD CONSTRAINT partners_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES users(id);
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE referrals ADD CONSTRAINT referrals_referred_id_fkey FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE referrals ADD CONSTRAINT referrals_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES operator_bookings(id);
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES operator_staff(id);
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES partners(id);
ALTER TABLE review_assets ADD CONSTRAINT review_assets_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE review_assets ADD CONSTRAINT review_assets_review_id_fkey FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE;
ALTER TABLE reviews ADD CONSTRAINT reviews_place_id_fkey FOREIGN KEY (place_id) REFERENCES places(ark_id) ON DELETE SET NULL;
ALTER TABLE reviews ADD CONSTRAINT reviews_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES tours(id);
ALTER TABLE reviews ADD CONSTRAINT reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE route_description_cache ADD CONSTRAINT route_description_cache_route_id_fkey1 FOREIGN KEY (route_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE route_passport_ocr ADD CONSTRAINT route_passport_ocr_route_id_fkey FOREIGN KEY (route_id) REFERENCES kamchatka_routes(id) ON DELETE CASCADE;
ALTER TABLE route_registration_notifications ADD CONSTRAINT route_registration_notifications_registration_id_fkey FOREIGN KEY (registration_id) REFERENCES route_registrations(id) ON DELETE CASCADE;
ALTER TABLE route_registrations ADD CONSTRAINT route_registrations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE route_subcategories ADD CONSTRAINT route_subcategories_category_slug_fkey FOREIGN KEY (category_slug) REFERENCES route_categories(slug) ON DELETE CASCADE;
ALTER TABLE route_tags ADD CONSTRAINT route_tags_category_slug_fkey FOREIGN KEY (category_slug) REFERENCES route_categories(slug) ON DELETE SET NULL;
ALTER TABLE route_waypoints ADD CONSTRAINT fk_rw_place FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE CASCADE;
ALTER TABLE route_waypoints ADD CONSTRAINT fk_rw_route FOREIGN KEY (route_id) REFERENCES kamchatka_routes(id) ON DELETE CASCADE;
ALTER TABLE safety_alerts ADD CONSTRAINT safety_alerts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sos_events ADD CONSTRAINT sos_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE tour_assets ADD CONSTRAINT tour_assets_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE tour_assets ADD CONSTRAINT tour_assets_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES tours(id) ON DELETE CASCADE;
ALTER TABLE tour_availability ADD CONSTRAINT tour_availability_operator_tour_id_fkey FOREIGN KEY (operator_tour_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE tour_availability_alternatives ADD CONSTRAINT tour_availability_alternatives_alternative_tour_id_fkey FOREIGN KEY (alternative_tour_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE tour_availability_alternatives ADD CONSTRAINT tour_availability_alternatives_availability_id_fkey FOREIGN KEY (availability_id) REFERENCES tour_availability(id) ON DELETE CASCADE;
ALTER TABLE tour_departures ADD CONSTRAINT tour_departures_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES tours(id) ON DELETE CASCADE;
ALTER TABLE tour_options ADD CONSTRAINT tour_options_operator_tour_id_fkey FOREIGN KEY (operator_tour_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE tour_payments ADD CONSTRAINT tour_payments_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES operator_bookings(id) ON DELETE RESTRICT;
ALTER TABLE tour_payments ADD CONSTRAINT tour_payments_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id);
ALTER TABLE tour_pricing_rules ADD CONSTRAINT tour_pricing_rules_operator_tour_id_fkey FOREIGN KEY (operator_tour_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE tour_selection_events ADD CONSTRAINT tour_selection_events_item_id_fkey FOREIGN KEY (item_id) REFERENCES tour_selection_items(id) ON DELETE SET NULL;
ALTER TABLE tour_selection_events ADD CONSTRAINT tour_selection_events_selection_id_fkey FOREIGN KEY (selection_id) REFERENCES tour_selections(id) ON DELETE CASCADE;
ALTER TABLE tour_selection_items ADD CONSTRAINT tour_selection_items_operator_tour_id_fkey FOREIGN KEY (operator_tour_id) REFERENCES operator_tours(id) ON DELETE CASCADE;
ALTER TABLE tour_selection_items ADD CONSTRAINT tour_selection_items_selection_id_fkey FOREIGN KEY (selection_id) REFERENCES tour_selections(id) ON DELETE CASCADE;
ALTER TABLE tour_selections ADD CONSTRAINT tour_selections_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tour_selections ADD CONSTRAINT tour_selections_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE SET NULL;
ALTER TABLE tour_transfer_requests ADD CONSTRAINT tour_transfer_requests_from_partner_id_fkey FOREIGN KEY (from_partner_id) REFERENCES partners(id);
ALTER TABLE tour_transfer_requests ADD CONSTRAINT tour_transfer_requests_to_partner_id_fkey FOREIGN KEY (to_partner_id) REFERENCES partners(id);
ALTER TABLE tours ADD CONSTRAINT tours_guide_id_fkey FOREIGN KEY (guide_id) REFERENCES partners(id);
ALTER TABLE tours ADD CONSTRAINT tours_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id);
ALTER TABLE tours ADD CONSTRAINT tours_route_id_fkey FOREIGN KEY (route_id) REFERENCES kamchatka_routes(id) ON DELETE SET NULL;
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE;
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transfer_reviews ADD CONSTRAINT transfer_reviews_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE;
ALTER TABLE transfer_routes ADD CONSTRAINT transfer_routes_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE transfer_transactions ADD CONSTRAINT transfer_transactions_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE transfer_transactions ADD CONSTRAINT transfer_transactions_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE transfer_transactions ADD CONSTRAINT transfer_transactions_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE SET NULL;
ALTER TABLE transfer_transactions ADD CONSTRAINT transfer_transactions_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE transfers ADD CONSTRAINT transfers_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE transfers ADD CONSTRAINT transfers_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE transfers ADD CONSTRAINT transfers_route_id_fkey FOREIGN KEY (route_id) REFERENCES transfer_routes(id) ON DELETE SET NULL;
ALTER TABLE transfers ADD CONSTRAINT transfers_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transfers ADD CONSTRAINT transfers_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE user_achievements ADD CONSTRAINT user_achievements_achievement_id_fkey FOREIGN KEY (achievement_id) REFERENCES eco_achievements(id);
ALTER TABLE user_achievements ADD CONSTRAINT user_achievements_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE user_ai_memory ADD CONSTRAINT user_ai_memory_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_eco_activities ADD CONSTRAINT user_eco_activities_eco_point_id_fkey FOREIGN KEY (eco_point_id) REFERENCES eco_points(id);
ALTER TABLE user_eco_activities ADD CONSTRAINT user_eco_activities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE user_eco_points ADD CONSTRAINT user_eco_points_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE user_role_history ADD CONSTRAINT user_role_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES users(id);
ALTER TABLE user_role_history ADD CONSTRAINT user_role_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE user_trips ADD CONSTRAINT user_trips_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users ADD CONSTRAINT users_active_trip_id_fkey FOREIGN KEY (active_trip_id) REFERENCES user_trips(id) ON DELETE SET NULL;
ALTER TABLE users ADD CONSTRAINT users_referred_by_fkey FOREIGN KEY (referred_by) REFERENCES users(id);
ALTER TABLE vehicle_documents ADD CONSTRAINT vehicle_documents_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE CASCADE;
ALTER TABLE volcano_status ADD CONSTRAINT volcano_status_place_ark_id_fkey FOREIGN KEY (place_ark_id) REFERENCES places(ark_id) ON DELETE SET NULL;
ALTER TABLE weather_alert_bookings ADD CONSTRAINT weather_alert_bookings_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES weather_alerts(id) ON DELETE CASCADE;
ALTER TABLE weather_alert_bookings ADD CONSTRAINT weather_alert_bookings_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES operator_bookings(id) ON DELETE CASCADE;
ALTER TABLE weather_alerts ADD CONSTRAINT weather_alerts_operator_tour_id_fkey FOREIGN KEY (operator_tour_id) REFERENCES operator_tours(id);

-- ══ indexes (487) ══════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_provider_providerAccountId_key" ON public.accounts USING btree (provider, "providerAccountId");
CREATE INDEX IF NOT EXISTS agent_experiments_created_idx ON public.agent_experiments USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_experiments_intent_idx ON public.agent_experiments USING btree (intent);
CREATE INDEX IF NOT EXISTS agent_experiments_status_idx ON public.agent_experiments USING btree (status);
CREATE INDEX IF NOT EXISTS agent_sdk_sessions_agent_idx ON public.agent_sdk_sessions USING btree (agent_id);
CREATE INDEX IF NOT EXISTS agent_sdk_sessions_created_idx ON public.agent_sdk_sessions USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_sdk_sessions_exp_idx ON public.agent_sdk_sessions USING btree (experiment_id);
CREATE INDEX IF NOT EXISTS agent_sdk_sessions_intent_idx ON public.agent_sdk_sessions USING btree (intent);
CREATE INDEX IF NOT EXISTS agent_sdk_sessions_variant_idx ON public.agent_sdk_sessions USING btree (variant);
CREATE INDEX IF NOT EXISTS ai_route_images_created_idx ON public.ai_route_images USING btree (created_at);
CREATE INDEX IF NOT EXISTS ai_route_images_photo_verified_idx ON public.ai_route_images USING btree (photo_verified);
CREATE UNIQUE INDEX IF NOT EXISTS ai_route_images_route_id_idx ON public.ai_route_images USING btree (route_id);
CREATE INDEX IF NOT EXISTS chat_sessions_updated_idx ON public.chat_sessions USING btree (updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx ON public.chat_sessions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_assets_accommodation ON public.accommodation_assets USING btree (accommodation_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_availability_date ON public.accommodation_availability USING btree (date);
CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_accommodation ON public.accommodation_bookings USING btree (accommodation_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_dates ON public.accommodation_bookings USING btree (check_in_date, check_out_date);
CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_room ON public.accommodation_bookings USING btree (room_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_status ON public.accommodation_bookings USING btree (status);
CREATE INDEX IF NOT EXISTS idx_accommodation_bookings_user ON public.accommodation_bookings USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_reviews_accommodation ON public.accommodation_reviews USING btree (accommodation_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_reviews_user ON public.accommodation_reviews USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_rooms_accommodation ON public.accommodation_rooms USING btree (accommodation_id);
CREATE INDEX IF NOT EXISTS idx_accommodation_rooms_price ON public.accommodation_rooms USING btree (price_per_night);
CREATE INDEX IF NOT EXISTS idx_accommodation_rooms_type ON public.accommodation_rooms USING btree (room_type);
CREATE INDEX IF NOT EXISTS idx_accommodations_active ON public.accommodations USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_accommodations_partner ON public.accommodations USING btree (partner_id);
CREATE INDEX IF NOT EXISTS idx_accommodations_price ON public.accommodations USING btree (price_per_night_from);
CREATE INDEX IF NOT EXISTS idx_accommodations_rating ON public.accommodations USING btree (rating DESC);
CREATE INDEX IF NOT EXISTS idx_accommodations_type ON public.accommodations USING btree (type);
CREATE INDEX IF NOT EXISTS idx_accommodations_zone ON public.accommodations USING btree (location_zone);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_partner ON public.affiliate_clicks USING btree (partner, clicked_at);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_source ON public.affiliate_clicks USING btree (source, clicked_at);
CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_partner_date ON public.affiliate_payouts USING btree (partner, received_at);
CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_status ON public.affiliate_payouts USING btree (status);
CREATE INDEX IF NOT EXISTS idx_agent_actions_agent ON public.agent_actions USING btree (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_execution ON public.agent_approvals USING btree (execution_status, executor_agent_id) WHERE ((execution_status)::text = 'assigned'::text);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_status ON public.agent_approvals USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_bookings_agent ON public.agent_bookings USING btree (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_bookings_client ON public.agent_bookings USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_agent_bookings_status ON public.agent_bookings USING btree (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_bookings_tour ON public.agent_bookings USING btree (tour_id);
CREATE INDEX IF NOT EXISTS idx_agent_clients_agent ON public.agent_clients USING btree (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_clients_status ON public.agent_clients USING btree (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_commissions_agent ON public.agent_commissions USING btree (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_commissions_booking ON public.agent_commissions USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_agent_commissions_status ON public.agent_commissions USING btree (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_experiments_status ON public.agent_experiments USING btree (status, intent);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_agent_updated ON public.agent_knowledge USING btree (agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_market_created ON public.agent_market_payments USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_market_payment_id ON public.agent_market_payments USING btree (payment_id);
CREATE INDEX IF NOT EXISTS idx_agent_market_status ON public.agent_market_payments USING btree (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON public.agent_memory USING btree (agent_id, memory_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_created_at ON public.agent_memory USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_agent_memory_edits_agent_id ON public.agent_memory_edits USING btree (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_edits_memory_id ON public.agent_memory_edits USING btree (memory_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_expires ON public.agent_memory USING btree (expires_at) WHERE (expires_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_agent_memory_tags ON public.agent_memory USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_agent_memory_tier ON public.agent_memory USING btree (agent_id, memory_tier);
CREATE INDEX IF NOT EXISTS idx_agent_route_knowledge_category ON public._agent_route_knowledge_legacy USING btree (category);
CREATE INDEX IF NOT EXISTS idx_agent_route_knowledge_route_id ON public._agent_route_knowledge_legacy USING btree (route_id);
CREATE INDEX IF NOT EXISTS idx_agent_route_knowledge_search_tsv ON public._agent_route_knowledge_legacy USING gin (to_tsvector('russian'::regconfig, search_text));
CREATE INDEX IF NOT EXISTS idx_agent_route_knowledge_title_tsv ON public._agent_route_knowledge_legacy USING gin (to_tsvector('russian'::regconfig, title));
CREATE INDEX IF NOT EXISTS idx_agent_route_zone ON public._agent_route_knowledge_legacy USING btree (zone);
CREATE INDEX IF NOT EXISTS idx_agent_run_history_agent_id ON public.agent_run_history USING btree (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_history_status ON public.agent_run_history USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_actions_log_action_type ON public.ai_actions_log USING btree (action_type);
CREATE INDEX IF NOT EXISTS idx_ai_actions_log_created_at ON public.ai_actions_log USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_actions_partner ON public.operator_ai_actions USING btree (partner_id);
CREATE INDEX IF NOT EXISTS idx_ai_actions_pending_expires ON public.operator_ai_actions USING btree (expires_at) WHERE (status = 'pending_approval'::text);
CREATE INDEX IF NOT EXISTS idx_ai_actions_status ON public.operator_ai_actions USING btree (status);
CREATE INDEX IF NOT EXISTS idx_ak_agent_id ON public.agent_knowledge USING btree (agent_id);
CREATE INDEX IF NOT EXISTS idx_ak_metadata ON public.agent_knowledge USING gin (metadata);
CREATE INDEX IF NOT EXISTS idx_ak_search_vector ON public.agent_knowledge USING gin (search_vector);
CREATE INDEX IF NOT EXISTS idx_ak_title_trgm ON public.agent_knowledge USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ak_type ON public.agent_knowledge USING btree (type);
CREATE INDEX IF NOT EXISTS idx_ak_updated ON public.agent_knowledge USING btree (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_akl_from ON public.agent_knowledge_links USING btree (from_slug);
CREATE INDEX IF NOT EXISTS idx_akl_to ON public.agent_knowledge_links USING btree (to_slug);
CREATE INDEX IF NOT EXISTS idx_alert_bookings_booking ON public.weather_alert_bookings USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON public.external_alerts USING btree (expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_ark_activity_type ON public._agent_route_knowledge_legacy USING btree (activity_type);
CREATE INDEX IF NOT EXISTS idx_ark_kind ON public._agent_route_knowledge_legacy USING btree (kind);
CREATE INDEX IF NOT EXISTS idx_ark_location_type ON public._agent_route_knowledge_legacy USING btree (location_type);
CREATE INDEX IF NOT EXISTS idx_ark_visible ON public._agent_route_knowledge_legacy USING btree (is_visible) WHERE (is_visible = true);
CREATE INDEX IF NOT EXISTS idx_articles_visible ON public.articles USING btree (is_visible, title);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON public.audit_log USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON public.audit_log USING btree (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs USING btree (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON public.audit_logs USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_avail_alternatives_tour ON public.tour_availability_alternatives USING btree (alternative_tour_id);
CREATE INDEX IF NOT EXISTS idx_board_sessions_started ON public.board_meeting_sessions USING btree (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_booking_transfers_booking ON public.booking_transfers USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_transfers_from ON public.booking_transfers USING btree (from_operator_id, status);
CREATE INDEX IF NOT EXISTS idx_booking_transfers_to ON public.booking_transfers USING btree (to_operator_id, status);
CREATE INDEX IF NOT EXISTS idx_booking_waivers_user ON public.booking_waivers USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_availability_idempotent ON public.operator_bookings USING btree (availability_id, octo_api_key_id) WHERE ((availability_id IS NOT NULL) AND (octo_api_key_id IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX IF NOT EXISTS idx_bookings_date ON public.bookings USING btree (date);
CREATE INDEX IF NOT EXISTS idx_bookings_departure_id ON public.bookings USING btree (departure_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_octo_uuid ON public.operator_bookings USING btree (octo_uuid) WHERE (octo_uuid IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bookings_start_date ON public.bookings USING btree (start_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON public.bookings USING btree (status);
CREATE INDEX IF NOT EXISTS idx_bookings_tour ON public.bookings USING btree (tour_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON public.bookings USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_cancellation_policies_partner ON public.cancellation_policies USING btree (partner_id, tour_id, days_before DESC);
CREATE INDEX IF NOT EXISTS idx_change_requests_booking ON public.booking_change_requests USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_change_requests_partner_status ON public.booking_change_requests USING btree (partner_id, status);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON public.chat_messages USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON public.chat_messages USING btree ("timestamp");
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_session_id ON public.chat_sessions USING btree (session_id) WHERE (session_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_session_id_full ON public.chat_sessions USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON public.chat_sessions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON public.chat_sessions USING btree (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_comms_booking_id ON public.client_communications USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_client_comms_created_at ON public.client_communications USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_comms_recipient_id ON public.client_communications USING btree (recipient_id);
CREATE INDEX IF NOT EXISTS idx_client_comms_sender_id ON public.client_communications USING btree (sender_id);
CREATE INDEX IF NOT EXISTS idx_collections_public ON public.collections USING btree (is_public, view_count DESC);
CREATE INDEX IF NOT EXISTS idx_collections_slug ON public.collections USING btree (slug);
CREATE INDEX IF NOT EXISTS idx_collections_tags ON public.collections USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_commission_payouts_agent ON public.commission_payouts USING btree (agent_id);
CREATE INDEX IF NOT EXISTS idx_commission_payouts_status ON public.commission_payouts USING btree (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_contingency_active ON public.contingency_rules USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_contingency_primary ON public.contingency_rules USING btree (primary_tour_id);
CREATE INDEX IF NOT EXISTS idx_contingency_priority ON public.contingency_rules USING btree (priority);
CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON public.conversation_messages USING btree (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_created ON public.conversation_messages USING btree (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_messages_sender ON public.conversation_messages USING btree (sender_id);
CREATE INDEX IF NOT EXISTS idx_conv_participants_conv ON public.conversation_participants USING btree (conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_participants_user ON public.conversation_participants USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_booking ON public.conversations USING btree (booking_id) WHERE (booking_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_conversations_type ON public.conversations USING btree (type);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON public.conversations USING btree (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crowd_log_today ON public.crowd_log USING btree (agent_route_id, checkin_at);
CREATE INDEX IF NOT EXISTS idx_danger_assessments_risk_level ON public.danger_assessments USING btree (risk_level, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_danger_assessments_zone_time ON public.danger_assessments USING btree (zone, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_departures_start_date ON public.tour_departures USING btree (start_date);
CREATE INDEX IF NOT EXISTS idx_departures_status ON public.tour_departures USING btree (status);
CREATE INDEX IF NOT EXISTS idx_departures_tour_id ON public.tour_departures USING btree (tour_id);
CREATE INDEX IF NOT EXISTS idx_driver_documents_driver_id ON public.driver_documents USING btree (driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_documents_expiry ON public.driver_documents USING btree (expiry_date);
CREATE INDEX IF NOT EXISTS idx_driver_documents_status ON public.driver_documents USING btree (status);
CREATE INDEX IF NOT EXISTS idx_driver_schedules_date ON public.driver_schedules USING btree (date);
CREATE INDEX IF NOT EXISTS idx_driver_schedules_driver_id ON public.driver_schedules USING btree (driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_schedules_transfer_id ON public.driver_schedules USING btree (transfer_id);
CREATE INDEX IF NOT EXISTS idx_driver_schedules_type ON public.driver_schedules USING btree (type);
CREATE INDEX IF NOT EXISTS idx_drivers_license_number ON public.drivers USING btree (license_number);
CREATE INDEX IF NOT EXISTS idx_drivers_operator_id ON public.drivers USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_drivers_rating ON public.drivers USING btree (rating);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON public.drivers USING btree (status);
CREATE INDEX IF NOT EXISTS idx_drivers_vehicle_id ON public.drivers USING btree (vehicle_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eco_claims_ledger ON public.eco_compensation_claims USING btree (ledger_id);
CREATE INDEX IF NOT EXISTS idx_eco_claims_operator ON public.eco_compensation_claims USING btree (operator_id) WHERE (operator_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_eco_claims_pending ON public.eco_compensation_claims USING btree (payer, created_at DESC) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_eco_ledger_credit ON public.eco_ledger USING btree (credit_account, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eco_ledger_debit ON public.eco_ledger USING btree (debit_account, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eco_ledger_expires ON public.eco_ledger USING btree (expires_at) WHERE (expires_at IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eco_ledger_idempotency ON public.eco_ledger USING btree (source, source_ref) WHERE (source_ref IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_eco_points_active ON public.eco_points USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_eco_points_category ON public.eco_points USING btree (category);
CREATE INDEX IF NOT EXISTS idx_email_templates_is_active ON public.email_templates USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_email_templates_type ON public.email_templates USING btree (type);
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_source_purpose ON public.emergency_contacts USING btree (source, purpose);
CREATE INDEX IF NOT EXISTS idx_emergency_zone ON public.emergency_contacts USING btree (zone, contact_type);
CREATE INDEX IF NOT EXISTS idx_engagement_tour ON public.kuzmich_engagement_signals USING btree (tour_id);
CREATE INDEX IF NOT EXISTS idx_engagement_unpushed ON public.kuzmich_engagement_signals USING btree (created_at) WHERE (pushed_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_engagement_user ON public.kuzmich_engagement_signals USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_evo_growth_issues_model_status ON public.evo_growth_issues USING btree (model, status);
CREATE INDEX IF NOT EXISTS idx_evo_growth_issues_reportable ON public.evo_growth_issues USING btree (status) WHERE (github_issue_url IS NULL);
CREATE INDEX IF NOT EXISTS idx_evo_issues_category ON public.evo_growth_issues USING btree (category);
CREATE INDEX IF NOT EXISTS idx_evo_issues_fault_side ON public.evo_growth_issues USING btree (fault_side, status);
CREATE INDEX IF NOT EXISTS idx_evo_issues_status ON public.evo_growth_issues USING btree (status, severity);
CREATE INDEX IF NOT EXISTS idx_evo_review_ledger_last ON public.evo_review_ledger USING btree (last_reviewed_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_exec_log_approval ON public.approval_execution_log USING btree (approval_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_tools_category ON public.external_tools USING btree (category);
CREATE INDEX IF NOT EXISTS idx_external_tools_click_count ON public.external_tools USING btree (click_count DESC);
CREATE INDEX IF NOT EXISTS idx_external_tools_fts ON public.external_tools USING gin (search_vector);
CREATE INDEX IF NOT EXISTS idx_external_tools_use_count ON public.external_tools USING btree (use_count DESC);
CREATE INDEX IF NOT EXISTS idx_external_tools_verified ON public.external_tools USING btree (verified) WHERE (verified = true);
CREATE INDEX IF NOT EXISTS idx_faqs_category ON public.faqs USING btree (category);
CREATE INDEX IF NOT EXISTS idx_faqs_priority ON public.faqs USING btree (priority);
CREATE INDEX IF NOT EXISTS idx_funnel_events_step_time ON public.funnel_events USING btree (step, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_events_time ON public.funnel_events USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_gear_availability_item_date ON public.gear_availability USING btree (gear_item_id, date);
CREATE INDEX IF NOT EXISTS idx_gear_items_category ON public.gear_items USING btree (category);
CREATE INDEX IF NOT EXISTS idx_gear_items_is_active ON public.gear_items USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_gear_items_partner_id ON public.gear_items USING btree (partner_id);
CREATE INDEX IF NOT EXISTS idx_gear_rentals_dates ON public.gear_rentals USING btree (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_gear_rentals_gear_id ON public.gear_rentals USING btree (gear_id);
CREATE INDEX IF NOT EXISTS idx_gear_rentals_status ON public.gear_rentals USING btree (status);
CREATE INDEX IF NOT EXISTS idx_group_members_booking ON public.booking_group_members USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_guide_availability_guide_id ON public.guide_availability USING btree (guide_id);
CREATE INDEX IF NOT EXISTS idx_guide_certifications_guide_id ON public.guide_certifications USING btree (guide_id);
CREATE INDEX IF NOT EXISTS idx_guide_earnings_guide_id ON public.guide_earnings USING btree (guide_id);
CREATE INDEX IF NOT EXISTS idx_guide_earnings_payment_status ON public.guide_earnings USING btree (payment_status);
CREATE INDEX IF NOT EXISTS idx_guide_groups_schedule_id ON public.guide_groups USING btree (schedule_id);
CREATE INDEX IF NOT EXISTS idx_guide_reviews_guide_id ON public.guide_reviews USING btree (guide_id);
CREATE INDEX IF NOT EXISTS idx_guide_reviews_rating ON public.guide_reviews USING btree (rating);
CREATE INDEX IF NOT EXISTS idx_guide_schedule_guide_id ON public.guide_schedule USING btree (guide_id);
CREATE INDEX IF NOT EXISTS idx_guide_schedule_start_time ON public.guide_schedule USING btree (start_time);
CREATE INDEX IF NOT EXISTS idx_guide_schedule_status ON public.guide_schedule USING btree (status);
CREATE INDEX IF NOT EXISTS idx_guide_schedule_tour_date ON public.guide_schedule USING btree (tour_date);
CREATE INDEX IF NOT EXISTS idx_intelligence_sources_active ON public.intelligence_sources USING btree (active, domain);
CREATE INDEX IF NOT EXISTS idx_kamchatka_routes_category ON public.kamchatka_routes USING btree (category);
CREATE INDEX IF NOT EXISTS idx_kamchatka_routes_slug ON public.kamchatka_routes USING btree (slug);
CREATE INDEX IF NOT EXISTS idx_kamchatka_routes_title ON public.kamchatka_routes USING gin (to_tsvector('russian'::regconfig, title));
CREATE INDEX IF NOT EXISTS idx_lead_activity_log_created ON public.lead_activity_log USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_activity_log_lead ON public.lead_activity_log USING btree (lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_followups_lead ON public.lead_followups USING btree (lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_followups_scheduled ON public.lead_followups USING btree (scheduled_at) WHERE ((status)::text = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_lead_proposals_lead ON public.lead_proposals USING btree (lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_proposals_operator ON public.lead_proposals USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_lead_proposals_status ON public.lead_proposals USING btree (status);
CREATE INDEX IF NOT EXISTS idx_leads_ai_score ON public.leads USING btree (ai_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_leads_created ON public.leads USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_operator ON public.leads USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_leads_route_id ON public.leads USING btree (route_id) WHERE (route_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_leads_source_channel ON public.leads USING btree (source_channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON public.leads USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_agent_day ON public.llm_usage_log USING btree (agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_dedup ON public.loyalty_transactions USING btree (user_id, source, booking_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_expires_at ON public.loyalty_transactions USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_type ON public.loyalty_transactions USING btree (type);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_user_id ON public.loyalty_transactions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_lt_expires ON public.loyalty_transactions USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_lt_source ON public.loyalty_transactions USING btree (source);
CREATE INDEX IF NOT EXISTS idx_lt_type ON public.loyalty_transactions USING btree (type);
CREATE INDEX IF NOT EXISTS idx_lt_user ON public.loyalty_transactions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_max_login_sessions_expires ON public.max_login_sessions USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_mchs_group_reg_operator_partner ON public.mchs_group_registrations USING btree (operator_partner_id);
CREATE INDEX IF NOT EXISTS idx_mchs_group_reg_operator_user ON public.mchs_group_registrations USING btree (operator_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mchs_group_reg_status ON public.mchs_group_registrations USING btree (status);
CREATE INDEX IF NOT EXISTS idx_mchs_registrations_booking_id ON public.mchs_registrations USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_mchs_registrations_created_at ON public.mchs_registrations USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mchs_registrations_operator_id ON public.mchs_registrations USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_mchs_registrations_status ON public.mchs_registrations USING btree (status);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_created ON public.mcp_tool_calls USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_tool ON public.mcp_tool_calls USING btree (tool, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_templates_type ON public.message_templates USING btree (template_type);
CREATE INDEX IF NOT EXISTS idx_message_templates_user_id ON public.message_templates USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_notification_id ON public.notification_log USING btree (notification_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_sent_at ON public.notification_log USING btree (sent_at);
CREATE INDEX IF NOT EXISTS idx_notification_log_status ON public.notification_log USING btree (status);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications USING btree (is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_priority ON public.notifications USING btree (priority);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON public.notifications USING btree (type);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_octo_api_keys_key ON public.octo_api_keys USING btree (api_key) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_octo_api_keys_operator ON public.octo_api_keys USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_octo_booking_log_booking ON public.octo_booking_log USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_octo_webhook_log_key ON public.octo_webhook_log USING btree (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_bookings_booking_date ON public.operator_bookings USING btree (booking_date) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_op_bookings_operator_date ON public.operator_bookings USING btree (booking_date) INCLUDE (operator_tour_id, booking_status, final_price, participants) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_op_tours_agent_route ON public.operator_tours USING btree (agent_route_id) WHERE (agent_route_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_operator_applications_partner ON public.operator_applications USING btree (partner_id);
CREATE INDEX IF NOT EXISTS idx_operator_applications_status ON public.operator_applications USING btree (status);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_booking_status ON public.operator_bookings USING btree (booking_status);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_created_at ON public.operator_bookings USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_date ON public.operator_bookings USING btree (booking_date);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_deleted ON public.operator_bookings USING btree (deleted_at) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_email ON public.operator_bookings USING btree (tourist_email);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_payment ON public.operator_bookings USING btree (payment_status);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_referral ON public.operator_bookings USING btree (referral_link_id) WHERE (referral_link_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_status ON public.operator_bookings USING btree (booking_status);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_tochka_qr ON public.operator_bookings USING btree (tochka_qr_id) WHERE (tochka_qr_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_tour ON public.operator_bookings USING btree (operator_tour_id);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_tour_date_active ON public.operator_bookings USING btree (operator_tour_id, booking_date) WHERE ((booking_status)::text <> ALL ((ARRAY['cancelled'::character varying, 'rejected'::character varying])::text[]));
CREATE INDEX IF NOT EXISTS idx_operator_bookings_tour_daterange ON public.operator_bookings USING btree (operator_tour_id, booking_date, end_date);
CREATE INDEX IF NOT EXISTS idx_operator_bookings_uon_request_id ON public.operator_bookings USING btree (uon_request_id) WHERE (uon_request_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_operator_payouts_operator ON public.operator_payouts USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_operator_payouts_status ON public.operator_payouts USING btree (status);
CREATE INDEX IF NOT EXISTS idx_operator_signups_partner ON public.operator_signups USING btree (partner_id);
CREATE INDEX IF NOT EXISTS idx_operator_signups_user ON public.operator_signups USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_operator_staff_email ON public.operator_staff USING btree (email);
CREATE INDEX IF NOT EXISTS idx_operator_staff_max ON public.operator_staff USING btree (max_chat_id);
CREATE INDEX IF NOT EXISTS idx_operator_staff_partner ON public.operator_staff USING btree (partner_id);
CREATE INDEX IF NOT EXISTS idx_operator_staff_tg ON public.operator_staff USING btree (telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_operator_tour_reviews_tour ON public.operator_tour_reviews USING btree (tour_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_tour_reviews_user ON public.operator_tour_reviews USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_operator_tours_agent_route ON public.operator_tours USING btree (agent_route_id) WHERE (agent_route_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_operator_tours_catalog ON public.operator_tours USING btree (base_price) WHERE ((is_active = true) AND (deleted_at IS NULL) AND (is_published = true));
CREATE INDEX IF NOT EXISTS idx_operator_tours_deleted ON public.operator_tours USING btree (deleted_at) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_operator_tours_is_active ON public.operator_tours USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_operator_tours_location ON public.operator_tours USING btree (location_type, activity_type);
CREATE INDEX IF NOT EXISTS idx_operator_tours_operator_id ON public.operator_tours USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_operator_tours_published ON public.operator_tours USING btree (is_published);
CREATE INDEX IF NOT EXISTS idx_operator_tours_route ON public.operator_tours USING btree (route_id);
CREATE INDEX IF NOT EXISTS idx_operator_tours_route_id ON public.operator_tours USING btree (route_id) WHERE (route_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_operator_tours_season ON public.operator_tours USING btree (season_start, season_end);
CREATE INDEX IF NOT EXISTS idx_operator_vehicles_partner ON public.operator_vehicles USING btree (partner_id);
CREATE INDEX IF NOT EXISTS idx_outreach_queue_email ON public.outreach_queue USING btree (email) WHERE (email IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_outreach_queue_status ON public.outreach_queue USING btree (status);
CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON public.page_views USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_page_views_edge ON public.page_views USING btree (from_path, path) WHERE (from_path IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_page_views_human ON public.page_views USING btree (created_at) WHERE (is_bot = false);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON public.page_views USING btree (path);
CREATE INDEX IF NOT EXISTS idx_page_views_session ON public.page_views USING btree (session_id, created_at) WHERE (session_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_partner_integrations_partner ON public.partner_integrations USING btree (partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_prospects_name ON public.partner_prospects USING btree (lower((name)::text));
CREATE INDEX IF NOT EXISTS idx_partner_prospects_status ON public.partner_prospects USING btree (status);
CREATE INDEX IF NOT EXISTS idx_partners_category ON public.partners USING btree (category);
CREATE INDEX IF NOT EXISTS idx_partners_external_source ON public.partners USING btree (external_source) WHERE (external_source IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_partners_legal_inn ON public.partners USING btree (((legal_info ->> 'inn'::text))) WHERE (legal_info IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_partners_max_chat_id ON public.partners USING btree (max_chat_id) WHERE (max_chat_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_partners_public ON public.partners USING btree (is_public) WHERE (is_public = true);
CREATE INDEX IF NOT EXISTS idx_partners_registry_status ON public.partners USING btree (registry_status);
CREATE INDEX IF NOT EXISTS idx_partners_slug ON public.partners USING btree (slug) WHERE (slug IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_partners_telegram_chat_id ON public.partners USING btree (telegram_chat_id) WHERE (telegram_chat_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_user_category ON public.partners USING btree (user_id, category);
CREATE INDEX IF NOT EXISTS idx_partners_user_id ON public.partners USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_partners_verified ON public.partners USING btree (is_verified);
CREATE INDEX IF NOT EXISTS idx_partners_website ON public.partners USING btree (website) WHERE (website IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_partners_widget_enabled ON public.partners USING btree (id) WHERE (widget_enabled = true);
CREATE INDEX IF NOT EXISTS idx_place_aliases_alias_lower ON public.place_aliases USING btree (lower(TRIM(BOTH FROM alias)));
CREATE INDEX IF NOT EXISTS idx_place_aliases_alias_trgm ON public.place_aliases USING gin (alias gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_place_aliases_place ON public.place_aliases USING btree (place_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_dedupe_key ON public.places USING btree (dedupe_key) WHERE ((dedupe_key IS NOT NULL) AND (is_visible = true));
CREATE INDEX IF NOT EXISTS idx_places_merged_into ON public.places USING btree (merged_into_id) WHERE (merged_into_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_slug ON public.places USING btree (slug) WHERE (slug IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_source_url_unique ON public.places USING btree (source_name, source_url) WHERE ((source_url IS NOT NULL) AND (source_name IS NOT NULL) AND (is_visible = true));
CREATE INDEX IF NOT EXISTS idx_pricing_rules_tour ON public.tour_pricing_rules USING btree (operator_tour_id) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON public.promo_codes USING btree (code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_is_active ON public.promo_codes USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_psr_created ON public.place_safety_reports USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_psr_place_created ON public.place_safety_reports USING btree (place_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON public.push_subscriptions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_pwa_installs_first_seen ON public.pwa_installs USING btree (first_seen);
CREATE INDEX IF NOT EXISTS idx_query_expansion_log_created_at ON public.query_expansion_log USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_rag_feedback_created_at ON public.rag_feedback USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_id ON public.rag_feedback USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rag_quality_created ON public.rag_quality_log USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rdc_generated ON public._route_description_cache_legacy USING btree (generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_real_time_open_capacity ON public.location_real_time_status USING btree (is_open, recommender_status);
CREATE INDEX IF NOT EXISTS idx_referral_events_link ON public.agent_referral_events USING btree (link_id, event_type);
CREATE INDEX IF NOT EXISTS idx_referral_links_agent ON public.agent_referral_links USING btree (agent_id);
CREATE INDEX IF NOT EXISTS idx_referral_links_code ON public.agent_referral_links USING btree (code) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON public.referrals USING btree (referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_id ON public.referrals USING btree (referred_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON public.referrals USING btree (referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON public.referrals USING btree (referrer_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_booking ON public.refund_requests USING btree (booking_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_partner_status ON public.refund_requests USING btree (partner_id, status);
CREATE INDEX IF NOT EXISTS idx_registry_operators_inn ON public.official_registry_operators USING btree (inn) WHERE (inn IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_registry_operators_matched ON public.official_registry_operators USING btree (matched_partner_id);
CREATE INDEX IF NOT EXISTS idx_reviews_place_id ON public.reviews USING btree (place_id) WHERE (place_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON public.reviews USING btree (rating);
CREATE INDEX IF NOT EXISTS idx_reviews_tour ON public.reviews USING btree (tour_id);
CREATE INDEX IF NOT EXISTS idx_road_edges_from ON public.road_graph_edges USING btree (from_node);
CREATE INDEX IF NOT EXISTS idx_road_edges_to ON public.road_graph_edges USING btree (to_node);
CREATE INDEX IF NOT EXISTS idx_road_nodes_lat ON public.road_graph_nodes USING btree (lat);
CREATE INDEX IF NOT EXISTS idx_road_nodes_lng ON public.road_graph_nodes USING btree (lng);
CREATE INDEX IF NOT EXISTS idx_route_notifications_reg_id ON public.route_registration_notifications USING btree (registration_id);
CREATE INDEX IF NOT EXISTS idx_route_registrations_end_date ON public.route_registrations USING btree (end_date);
CREATE INDEX IF NOT EXISTS idx_route_registrations_escalation ON public.route_registrations USING btree (completed_at, end_date) WHERE (completed_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_route_registrations_mchs_status ON public.route_registrations USING btree (mchs_status);
CREATE INDEX IF NOT EXISTS idx_route_registrations_start_date ON public.route_registrations USING btree (start_date);
CREATE INDEX IF NOT EXISTS idx_route_registrations_user_id ON public.route_registrations USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_route_registrations_watchdog ON public.route_registrations USING btree (expected_return_at) WHERE ((completed_at IS NULL) AND (expected_return_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_route_subcategories_category ON public.route_subcategories USING btree (category_slug);
CREATE INDEX IF NOT EXISTS idx_route_tags_category ON public.route_tags USING btree (category_slug);
CREATE INDEX IF NOT EXISTS idx_route_tags_type ON public.route_tags USING btree (tag_type);
CREATE INDEX IF NOT EXISTS idx_route_templates_activities ON public.route_templates USING gin (activities) WHERE (jsonb_array_length(activities) > 0);
CREATE INDEX IF NOT EXISTS idx_route_templates_category_subcategory ON public.route_templates USING btree (category, subcategory);
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_templates_dedupe_key ON public.route_templates USING btree (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_route_templates_district ON public.route_templates USING btree (district) WHERE (district IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_route_templates_features ON public.route_templates USING gin (features) WHERE (jsonb_array_length(features) > 0);
CREATE INDEX IF NOT EXISTS idx_route_templates_subcategory ON public.route_templates USING btree (subcategory) WHERE (subcategory IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_route_templates_tags ON public.route_templates USING gin (tags) WHERE (jsonb_array_length(tags) > 0);
CREATE INDEX IF NOT EXISTS idx_route_waypoints_place ON public.route_waypoints USING btree (place_id);
CREATE INDEX IF NOT EXISTS idx_route_waypoints_route ON public.route_waypoints USING btree (route_id);
CREATE INDEX IF NOT EXISTS idx_safety_alerts_active ON public.safety_alerts USING btree (is_active, active_from, active_until) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_safety_alerts_zone ON public.safety_alerts USING btree (zone) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_smart_notify_user_time ON public.smart_notifications_log USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sos_events_created_at ON public.sos_events USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sos_events_user_id ON public.sos_events USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_category ON public.support_tickets USING btree (category, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON public.support_tickets USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_settings_category ON public.system_settings USING btree (category);
CREATE INDEX IF NOT EXISTS idx_tg_booking_flow_updated ON public.tg_booking_flow USING btree (updated_at);
CREATE INDEX IF NOT EXISTS idx_tg_conv_chat_created ON public.tg_conversations USING btree (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_conv_chat_platform ON public.tg_conversations USING btree (chat_id, platform, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_conv_user_id ON public.tg_conversations USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tg_ratings_created ON public.tg_ratings USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tour_availability_date ON public.tour_availability USING btree (date);
CREATE INDEX IF NOT EXISTS idx_tour_availability_status ON public.tour_availability USING btree (weather_status);
CREATE INDEX IF NOT EXISTS idx_tour_availability_tour ON public.tour_availability USING btree (operator_tour_id);
CREATE INDEX IF NOT EXISTS idx_tour_availability_tour_date ON public.tour_availability USING btree (operator_tour_id, date) WHERE ((is_cancelled = false) AND (deleted_at IS NULL));
CREATE INDEX IF NOT EXISTS idx_tour_departures_active ON public.tour_departures USING btree (tour_id, start_date) WHERE (status = 'active'::text);
CREATE INDEX IF NOT EXISTS idx_tour_departures_start_date ON public.tour_departures USING btree (start_date);
CREATE INDEX IF NOT EXISTS idx_tour_departures_status ON public.tour_departures USING btree (status);
CREATE INDEX IF NOT EXISTS idx_tour_departures_tour_id ON public.tour_departures USING btree (tour_id);
CREATE INDEX IF NOT EXISTS idx_tour_options_tour ON public.tour_options USING btree (operator_tour_id);
CREATE INDEX IF NOT EXISTS idx_tour_payments_booking ON public.tour_payments USING btree (booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tour_payments_cp_tx ON public.tour_payments USING btree (cp_transaction_id) WHERE (cp_transaction_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tour_payments_operator ON public.tour_payments USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_tour_payments_release ON public.tour_payments USING btree (release_after) WHERE ((status)::text = 'HELD'::text);
CREATE INDEX IF NOT EXISTS idx_tour_payments_status ON public.tour_payments USING btree (status);
CREATE INDEX IF NOT EXISTS idx_tour_selection_events_sel ON public.tour_selection_events USING btree (selection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tour_selection_items_sel ON public.tour_selection_items USING btree (selection_id, "position");
CREATE INDEX IF NOT EXISTS idx_tour_selections_code ON public.tour_selections USING btree (code);
CREATE INDEX IF NOT EXISTS idx_tour_selections_operator ON public.tour_selections USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_tour_tags_tag ON public.operator_tour_tags USING btree (tag);
CREATE INDEX IF NOT EXISTS idx_tours_active ON public.tours USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_tours_created_at ON public.tours USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_tours_difficulty ON public.tours USING btree (difficulty);
CREATE INDEX IF NOT EXISTS idx_tours_guide ON public.tours USING btree (guide_id);
CREATE INDEX IF NOT EXISTS idx_tours_is_active ON public.tours USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_tours_operator ON public.tours USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_tours_operator_id ON public.tours USING btree (operator_id) WHERE (operator_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tours_price ON public.tours USING btree (price);
CREATE INDEX IF NOT EXISTS idx_tours_route_id ON public.tours USING btree (route_id);
CREATE INDEX IF NOT EXISTS idx_trail_reports_status_created ON public.trail_reports USING btree (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_reviews_driver_id ON public.transfer_reviews USING btree (driver_id);
CREATE INDEX IF NOT EXISTS idx_transfer_reviews_rating ON public.transfer_reviews USING btree (rating);
CREATE INDEX IF NOT EXISTS idx_transfer_reviews_transfer_id ON public.transfer_reviews USING btree (transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_reviews_vehicle_id ON public.transfer_reviews USING btree (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_transfer_routes_from_to ON public.transfer_routes USING btree (from_location, to_location);
CREATE INDEX IF NOT EXISTS idx_transfer_routes_is_active ON public.transfer_routes USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_transfer_routes_operator_id ON public.transfer_routes USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_transfer_routes_popular ON public.transfer_routes USING btree (popular);
CREATE INDEX IF NOT EXISTS idx_transfer_transactions_date ON public.transfer_transactions USING btree (date);
CREATE INDEX IF NOT EXISTS idx_transfer_transactions_operator_id ON public.transfer_transactions USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_transfer_transactions_transfer_id ON public.transfer_transactions USING btree (transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_transactions_type ON public.transfer_transactions USING btree (type);
CREATE INDEX IF NOT EXISTS idx_transfers_booking_reference ON public.transfers USING btree (booking_reference);
CREATE INDEX IF NOT EXISTS idx_transfers_created_at ON public.transfers USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_driver_id ON public.transfers USING btree (driver_id);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON public.tour_transfer_requests USING btree (from_partner_id);
CREATE INDEX IF NOT EXISTS idx_transfers_operator_id ON public.transfers USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_transfers_payment_status ON public.transfers USING btree (payment_status);
CREATE INDEX IF NOT EXISTS idx_transfers_pickup_datetime ON public.transfers USING btree (pickup_datetime);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON public.transfers USING btree (status);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON public.tour_transfer_requests USING btree (to_partner_id);
CREATE INDEX IF NOT EXISTS idx_transfers_user_id ON public.transfers USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_transfers_vehicle_id ON public.transfers USING btree (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_user_ai_memory_last_updated ON public.user_ai_memory USING btree (last_updated);
CREATE INDEX IF NOT EXISTS idx_user_ai_memory_user_id ON public.user_ai_memory USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_user_place_photos_pending ON public.user_place_photos USING btree (status) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_user_place_photos_place ON public.user_place_photos USING btree (place_id) WHERE (status = 'approved'::text);
CREATE INDEX IF NOT EXISTS idx_user_place_photos_user ON public.user_place_photos USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_user_role_history_user_id ON public.user_role_history USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON public.user_sessions USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON public.user_sessions USING btree (token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_trips_share_token ON public.user_trips USING btree (share_token) WHERE (share_token IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_user_trips_user_id ON public.user_trips USING btree (user_id) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_users_active_trip ON public.users USING btree (active_trip_id) WHERE (active_trip_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users USING btree (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_max_user_id ON public.users USING btree (max_user_id) WHERE (max_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_password_hash ON public.users USING btree (password_hash);
CREATE INDEX IF NOT EXISTS idx_users_phone ON public.users USING btree (phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON public.users USING btree (referral_code) WHERE (referral_code IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users USING btree (role);
CREATE INDEX IF NOT EXISTS idx_users_telegram_chat_id ON public.users USING btree (telegram_chat_id) WHERE (telegram_chat_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_expiry ON public.vehicle_documents USING btree (expiry_date);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_status ON public.vehicle_documents USING btree (status);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle_id ON public.vehicle_documents USING btree (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_license_plate ON public.vehicles USING btree (license_plate);
CREATE INDEX IF NOT EXISTS idx_vehicles_operator_id ON public.vehicles USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON public.vehicles USING btree (status);
CREATE INDEX IF NOT EXISTS idx_vehicles_type ON public.vehicles USING btree (type);
CREATE INDEX IF NOT EXISTS idx_volcano_status_place ON public.volcano_status USING btree (place_ark_id) WHERE (place_ark_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_weather_alerts_date ON public.weather_alerts USING btree (alert_date);
CREATE INDEX IF NOT EXISTS idx_weather_alerts_processed ON public.weather_alerts USING btree (processed);
CREATE INDEX IF NOT EXISTS idx_weather_alerts_tour ON public.weather_alerts USING btree (operator_tour_id);
CREATE INDEX IF NOT EXISTS idx_wishes_stakeholder ON public.stakeholder_wishes USING btree (stakeholder, created_at DESC);
CREATE INDEX IF NOT EXISTS legislation_docs_category_idx ON public.legislation_docs USING btree (category);
CREATE INDEX IF NOT EXISTS legislation_docs_fts_idx ON public.legislation_docs USING gin (to_tsvector('russian'::regconfig, ((((COALESCE(title, ''::text) || ' '::text) || COALESCE(summary, ''::text)) || ' '::text) || COALESCE(full_text, ''::text))));
CREATE UNIQUE INDEX IF NOT EXISTS legislation_docs_source_url_idx ON public.legislation_docs USING btree (source_url);
CREATE INDEX IF NOT EXISTS llm_usage_log_created_idx ON public.llm_usage_log USING btree (created_at);
CREATE INDEX IF NOT EXISTS llm_usage_log_route_idx ON public.llm_usage_log USING btree (route);
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_sessionToken_key" ON public.sessions USING btree ("sessionToken");
CREATE INDEX IF NOT EXISTS tourist_incidents_date_idx ON public.tourist_incidents USING btree (incident_date DESC);
CREATE INDEX IF NOT EXISTS tours_ai_tags_idx ON public.tours USING gin (ai_tags);
CREATE INDEX IF NOT EXISTS uon_sync_log_created_idx ON public.uon_sync_log USING btree (created_at);
CREATE INDEX IF NOT EXISTS uon_sync_log_operator_idx ON public.uon_sync_log USING btree (operator_id) WHERE (operator_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accommodation_availability_object_date ON public.accommodation_availability USING btree (accommodation_id, date) WHERE (room_id IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accommodation_availability_room_date ON public.accommodation_availability USING btree (accommodation_id, room_id, date) WHERE (room_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_registry_operators_name_norm ON public.official_registry_operators USING btree (name_normalized);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_telegram_id ON public.users USING btree (telegram_id);
CREATE INDEX IF NOT EXISTS users_recommended_at_idx ON public.users USING btree (recommended_at) WHERE (recommended_at IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_place_aliases_place_alias ON public.place_aliases USING btree (place_id, lower(TRIM(BOTH FROM alias)));
CREATE UNIQUE INDEX IF NOT EXISTS verification_tokens_identifier_token_key ON public.verification_tokens USING btree (identifier, token);
CREATE UNIQUE INDEX IF NOT EXISTS verification_tokens_token_key ON public.verification_tokens USING btree (token);

-- ══ functions (19) ══════════════════════════════
CREATE OR REPLACE FUNCTION public.ark_view_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO kamchatka_routes
    (id, dedupe_key, slug, title, description, category,
     source_url, source_name, metadata, is_visible,
     activity_type, zone, created_at, updated_at)
  VALUES (
    COALESCE(NEW.id, gen_random_uuid()),
    COALESCE(NEW.route_dedupe_key, NEW.title),
    LOWER(REGEXP_REPLACE(COALESCE(NEW.title, 'route'), '[^a-zа-я0-9]+', '-', 'g')),
    NEW.title,
    NEW.description,
    COALESCE(NEW.category, 'ekskursii'),
    NEW.source_url,
    NEW.source_name,
    COALESCE(NEW.payload, '{}'),
    COALESCE(NEW.is_visible, TRUE),
    NEW.activity_type,
    NEW.zone,
    NOW(),
    NOW()
  )
  ON CONFLICT (dedupe_key) DO UPDATE
    SET title       = EXCLUDED.title,
        description = COALESCE(EXCLUDED.description, kamchatka_routes.description),
        source_url  = EXCLUDED.source_url,
        updated_at  = NOW();

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.ark_view_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE places
  SET
    name          = COALESCE(NEW.title,         name),
    description   = COALESCE(NEW.description,   description),
    category      = COALESCE(NEW.category,       category),
    lat           = COALESCE(NEW.lat,            lat),
    lng           = COALESCE(NEW.lng,            lng),
    is_visible    = COALESCE(NEW.is_visible,     is_visible),
    location_type = COALESCE(NEW.location_type,  location_type),
    activity_type = COALESCE(NEW.activity_type,  activity_type),
    zone          = COALESCE(NEW.zone,           zone),
    embedding     = COALESCE(NEW.embedding,      embedding),
    updated_at    = NOW()
  WHERE ark_id = OLD.id;

  IF NOT FOUND THEN
    UPDATE kamchatka_routes
    SET
      title         = COALESCE(NEW.title,         title),
      description   = COALESCE(NEW.description,   description),
      category      = COALESCE(NEW.category,       category),
      lat           = COALESCE(NEW.lat::numeric,   lat),
      lng           = COALESCE(NEW.lng::numeric,   lng),
      is_visible    = COALESCE(NEW.is_visible,     is_visible),
      activity_type = COALESCE(NEW.activity_type,  activity_type),
      zone          = COALESCE(NEW.zone,           zone),
      metadata      = COALESCE(NEW.payload,        metadata),
      embedding     = COALESCE(NEW.embedding,      embedding),
      updated_at    = NOW()
    WHERE COALESCE(ark_id, id) = OLD.id;
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.calculate_nights()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.nights := NEW.check_out_date - NEW.check_in_date;
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.eco_contribution_is_not_transferable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.debit_account LIKE 'contrib:%' AND NEW.operation <> 'adjust' THEN
    RAISE EXCEPTION
      'Вклад не отчуждается: списание с % запрещено (операция %). Тратится только польза (user:*).',
      NEW.debit_account, NEW.operation;
  END IF;

  -- Зачислять на счёт вклада можно только выпуском или переносом: перевод
  -- вклада от другого держателя — это та же продажа, только с другой стороны.
  IF NEW.credit_account LIKE 'contrib:%' AND NEW.operation NOT IN ('emit', 'opening', 'adjust') THEN
    RAISE EXCEPTION
      'На счёт вклада % нельзя зачислить операцией % — только emit/opening/adjust.',
      NEW.credit_account, NEW.operation;
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.eco_ledger_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'eco_ledger — журнал только на дозапись, операция % запрещена', TG_OP;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.external_tools_fts_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.search_vector := to_tsvector('simple',
    coalesce(NEW.name, '') || ' ' ||
    coalesce(NEW.description, '') || ' ' ||
    coalesce(array_to_string(NEW.tags, ' '), '')
  );
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_leads_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.recalculate_commission(p_operator_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_booking_count INT;
  v_start_rate    NUMERIC(4,2);
  v_new_rate      NUMERIC(4,2);
BEGIN
  SELECT COUNT(*) INTO v_booking_count
  FROM operator_bookings ob
  JOIN operator_tours ot ON ot.id = ob.operator_tour_id
  WHERE ot.operator_id = p_operator_id
    AND ob.booking_status = 'completed'
    AND ob.deleted_at IS NULL;

  SELECT commission_start INTO v_start_rate
  FROM partners WHERE id = p_operator_id;

  v_new_rate := CASE
    WHEN v_booking_count >= 200 THEN GREATEST(5.00, v_start_rate - 8.00)
    WHEN v_booking_count >= 100 THEN GREATEST(5.00, v_start_rate - 6.00) -- was -8 at 200+
    WHEN v_booking_count >=  50 THEN GREATEST(5.00, v_start_rate - 6.00)
    WHEN v_booking_count >=  10 THEN GREATEST(5.00, v_start_rate - 3.00)
    ELSE v_start_rate
  END;

  UPDATE partners
  SET commission_current = v_new_rate, updated_at = NOW()
  WHERE id = p_operator_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.set_user_trips_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $function$
;
CREATE OR REPLACE FUNCTION public.slugify_ru(input text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  result text;
BEGIN
  result := lower(trim(input));
  result := replace(result, 'щ', 'shch');
  result := replace(result, 'ш', 'sh');
  result := replace(result, 'ч', 'ch');
  result := replace(result, 'ж', 'zh');
  result := replace(result, 'ю', 'yu');
  result := replace(result, 'я', 'ya');
  result := replace(result, 'ё', 'yo');
  result := replace(result, 'ъ', '');
  result := replace(result, 'ь', '');
  result := replace(result, 'а', 'a');
  result := replace(result, 'б', 'b');
  result := replace(result, 'в', 'v');
  result := replace(result, 'г', 'g');
  result := replace(result, 'д', 'd');
  result := replace(result, 'е', 'e');
  result := replace(result, 'з', 'z');
  result := replace(result, 'и', 'i');
  result := replace(result, 'й', 'y');
  result := replace(result, 'к', 'k');
  result := replace(result, 'л', 'l');
  result := replace(result, 'м', 'm');
  result := replace(result, 'н', 'n');
  result := replace(result, 'о', 'o');
  result := replace(result, 'п', 'p');
  result := replace(result, 'р', 'r');
  result := replace(result, 'с', 's');
  result := replace(result, 'т', 't');
  result := replace(result, 'у', 'u');
  result := replace(result, 'ф', 'f');
  result := replace(result, 'х', 'kh');
  result := replace(result, 'ц', 'ts');
  result := replace(result, 'э', 'e');
  result := replace(result, 'ы', 'y');
  result := replace(result, 'і', 'i');
  -- Replace spaces and non-alphanumeric with dash
  result := regexp_replace(result, '[^a-z0-9]+', '-', 'g');
  -- Remove leading/trailing dashes
  result := trim(both '-' from result);
  RETURN result;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.sync_partner_company_name()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    NEW.company_name := NEW.name;
  END IF;
  IF NEW.company_name IS DISTINCT FROM OLD.company_name THEN
    NEW.name := NEW.company_name;
  END IF;
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.translit_ru_slug(txt text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE v TEXT;
BEGIN
  v := lower(coalesce(txt, ''));
  -- многобуквенные сначала (translate умеет только 1→1)
  v := replace(v, 'ё', 'yo');
  v := replace(v, 'ж', 'zh');
  v := replace(v, 'ц', 'ts');
  v := replace(v, 'ч', 'ch');
  v := replace(v, 'ш', 'sh');
  v := replace(v, 'щ', 'shch');
  v := replace(v, 'ю', 'yu');
  v := replace(v, 'я', 'ya');
  -- однобуквенные 1→1
  v := translate(v, 'абвгдезийклмнопрстуфхыэ', 'abvgdezijklmnoprstufhye');
  -- немые знаки
  v := replace(v, 'ъ', '');
  v := replace(v, 'ь', '');
  -- всё не [a-z0-9] → дефис, схлопнуть, обрезать
  v := regexp_replace(v, '[^a-z0-9]+', '-', 'g');
  v := regexp_replace(v, '^-+|-+$', '', 'g');
  v := left(v, 80);
  v := regexp_replace(v, '-+$', '', 'g');
  RETURN v;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.update_accommodation_rating()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE accommodations
  SET
    rating = (
      SELECT AVG(overall_rating)::DECIMAL(3,2)
      FROM accommodation_reviews
      WHERE accommodation_id = NEW.accommodation_id AND is_visible = true
    ),
    review_count = (
      SELECT COUNT(*)
      FROM accommodation_reviews
      WHERE accommodation_id = NEW.accommodation_id AND is_visible = true
    ),
    updated_at = NOW()
  WHERE id = NEW.accommodation_id;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.update_partner_rating()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    UPDATE partners SET
        rating = (
            SELECT COALESCE(AVG(rating), 0)
            FROM reviews r
            JOIN tours t ON r.tour_id = t.id
            WHERE t.operator_id = COALESCE(NEW.operator_id, OLD.operator_id)
               OR t.guide_id = COALESCE(NEW.guide_id, OLD.guide_id)
        ),
        review_count = (
            SELECT COUNT(*)
            FROM reviews r
            JOIN tours t ON r.tour_id = t.id
            WHERE t.operator_id = COALESCE(NEW.operator_id, OLD.operator_id)
               OR t.guide_id = COALESCE(NEW.guide_id, OLD.guide_id)
        )
    WHERE id = COALESCE(NEW.operator_id, OLD.operator_id)
       OR id = COALESCE(NEW.guide_id, OLD.guide_id);
    
    RETURN COALESCE(NEW, OLD);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.update_safety_alerts_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.update_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.update_tour_departures_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.update_tour_rating()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    UPDATE tours SET
        rating = (
            SELECT COALESCE(AVG(rating), 0)
            FROM reviews
            WHERE tour_id = COALESCE(NEW.tour_id, OLD.tour_id)
        ),
        review_count = (
            SELECT COUNT(*)
            FROM reviews
            WHERE tour_id = COALESCE(NEW.tour_id, OLD.tour_id)
        )
    WHERE id = COALESCE(NEW.tour_id, OLD.tour_id);
    
    RETURN COALESCE(NEW, OLD);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

-- ══ views (10) ══════════════════════════════
CREATE OR REPLACE VIEW tour_details AS
 SELECT t.id,
    t.name,
    t.description,
    t.short_description,
    t.category,
    t.difficulty,
    t.duration,
    t.price,
    t.currency,
    t.season,
    t.coordinates,
    t.requirements,
    t.included,
    t.not_included,
    t.operator_id,
    t.guide_id,
    t.max_group_size,
    t.min_group_size,
    t.rating,
    t.review_count,
    t.is_active,
    t.created_at,
    t.updated_at,
    o.name AS operator_name,
    o.category AS operator_category,
    o.rating AS operator_rating,
    g.name AS guide_name,
    g.rating AS guide_rating,
    array_agg(DISTINCT a.url) AS images
   FROM tours t
     LEFT JOIN partners o ON t.operator_id = o.id
     LEFT JOIN partners g ON t.guide_id = g.id
     LEFT JOIN tour_assets ta ON t.id = ta.tour_id
     LEFT JOIN assets a ON ta.asset_id = a.id
  GROUP BY t.id, o.id, g.id;
CREATE OR REPLACE VIEW partner_details AS
 SELECT p.id,
    p.user_id,
    p.name,
    p.category,
    p.description,
    p.contact,
    p.rating,
    p.review_count,
    p.is_verified,
    p.logo_asset_id,
    p.created_at,
    p.updated_at,
    l.url AS logo_url,
    array_agg(DISTINCT a.url) AS images
   FROM partners p
     LEFT JOIN assets l ON p.logo_asset_id = l.id
     LEFT JOIN partner_assets pa ON p.id = pa.partner_id
     LEFT JOIN assets a ON pa.asset_id = a.id
  GROUP BY p.id, l.url;
CREATE OR REPLACE VIEW v_current_danger AS
 SELECT DISTINCT ON (zone) id,
    zone,
    assessed_at,
    expires_at,
    risk_score,
    risk_level,
    threat_types,
    tourists_at_risk,
    active_tours_count,
    confidence,
    recommended_action,
    analysis_text,
    max_magnitude,
    max_ash_height_m
   FROM danger_assessments
  WHERE expires_at > now()
  ORDER BY zone, assessed_at DESC;
CREATE OR REPLACE VIEW v_tour_daily_occupancy AS
 SELECT b.operator_tour_id,
    d.day::date AS date,
    sum(b.participants) AS occupied
   FROM operator_bookings b
     CROSS JOIN LATERAL generate_series(b.booking_date::timestamp without time zone, COALESCE(b.end_date, b.booking_date)::timestamp without time zone, '1 day'::interval) d(day)
  WHERE (b.booking_status::text = ANY (ARRAY['new'::character varying, 'confirmed'::character varying]::text[])) AND b.deleted_at IS NULL
  GROUP BY b.operator_tour_id, (d.day::date);
CREATE OR REPLACE VIEW agent_route_knowledge AS
 SELECT p.ark_id AS id,
    NULL::text AS route_dedupe_key,
    NULL::uuid AS route_id,
    p.category,
    p.name AS title,
    p.description,
    p.lat,
    p.lng,
    p.source_url,
    p.source_name,
    NULL::tsvector AS search_text,
    '{}'::jsonb AS payload,
    NULL::text AS source_hash,
    NULL::timestamp with time zone AS source_updated_at,
    NULL::timestamp with time zone AS last_synced_at,
    p.created_at,
    p.updated_at,
    p.is_visible,
    p.location_type,
    p.activity_type,
    NULL::text AS kuzmich_review,
    p.zone,
    'place'::text AS kind,
    p.search_count,
    p.embedding
   FROM places p
UNION ALL
 SELECT COALESCE(r.ark_id, r.id) AS id,
    r.dedupe_key AS route_dedupe_key,
    NULL::uuid AS route_id,
    r.category,
    r.title,
    r.description,
    r.lat,
    r.lng,
    r.source_url,
    r.source_name,
    NULL::tsvector AS search_text,
    COALESCE(r.metadata, '{}'::jsonb) AS payload,
    NULL::text AS source_hash,
    NULL::timestamp with time zone AS source_updated_at,
    NULL::timestamp with time zone AS last_synced_at,
    r.created_at,
    r.updated_at,
    r.is_visible,
    NULL::character varying AS location_type,
    r.activity_type,
    NULL::text AS kuzmich_review,
    r.zone,
    'route'::text AS kind,
    r.search_count,
    r.embedding
   FROM kamchatka_routes r;
CREATE OR REPLACE VIEW v_kamchatka_routes_api AS
 SELECT id,
    ark_id,
    slug,
    dedupe_key AS route_dedupe_key,
    title,
    description,
    category,
    activity_type,
    zone,
    lat,
    lng,
    lat IS NOT NULL AND lng IS NOT NULL AS has_coordinates,
    source_url,
    source_name,
    COALESCE(metadata ->> 'import_source'::text, source_name, 'unknown'::text) AS import_source,
    difficulty,
    distance_km,
    duration_hours,
    duration_days,
    elevation_gain_m,
    season,
    route_type,
    geometry,
    hazards,
    equipment,
    mchs_registration_required,
    mchs_phone,
    park_name,
    park_approval_url,
    flora_fauna,
    accessibility,
    is_visible,
    view_count,
    metadata,
    count(*) OVER (PARTITION BY category) AS category_total,
    row_number() OVER (PARTITION BY category ORDER BY title, dedupe_key) AS category_position,
    created_at,
    updated_at,
    updated_at AS source_updated_at
   FROM kamchatka_routes
  WHERE is_visible = true OR is_visible IS NULL;
CREATE OR REPLACE VIEW v_kamchatka_route_groups_api AS
 SELECT category,
    count(*)::integer AS total_routes,
    count(*) FILTER (WHERE has_coordinates)::integer AS total_with_coordinates,
    min(source_updated_at) AS min_source_updated_at,
    max(source_updated_at) AS max_source_updated_at
   FROM v_kamchatka_routes_api
  GROUP BY category
  ORDER BY category;
CREATE OR REPLACE VIEW v_calendar_operator_summary AS
 SELECT t.operator_id,
    b.booking_date AS date,
    count(b.id) AS total_bookings,
    count(b.id) FILTER (WHERE b.booking_status::text = 'new'::text) AS new_bookings,
    count(b.id) FILTER (WHERE b.booking_status::text = 'confirmed'::text) AS confirmed_bookings,
    count(b.id) FILTER (WHERE b.booking_status::text = 'completed'::text) AS completed_bookings,
    count(b.id) FILTER (WHERE b.booking_status::text = 'cancelled'::text) AS cancelled_bookings,
    COALESCE(sum(b.final_price) FILTER (WHERE b.booking_status::text <> 'cancelled'::text), 0::numeric) AS revenue,
    COALESCE(sum(b.participants) FILTER (WHERE b.booking_status::text = ANY (ARRAY['new'::character varying::text, 'confirmed'::character varying::text])), 0::bigint) AS booked_participants
   FROM operator_bookings b
     JOIN operator_tours t ON b.operator_tour_id = t.id
  WHERE b.deleted_at IS NULL
  GROUP BY t.operator_id, b.booking_date;
CREATE OR REPLACE VIEW v_route_marketplace AS
 SELECT ark.id AS route_id,
    ark.route_dedupe_key AS route_slug,
    ark.title AS route_title,
    ark.category AS route_category,
    ark.description AS route_description,
    ark.lat,
    ark.lng,
    ark.payload AS metadata,
    ot.id AS tour_id,
    ot.title AS tour_name,
    COALESCE(ot.short_description, ot.description) AS tour_short_desc,
    ot.tour_image,
    ot.base_price AS tour_price_base,
    ot.price_old,
    COALESCE(ot.price_unit, 'per_person'::character varying) AS price_unit,
    COALESCE(ot.price_old, ot.base_price) AS effective_price,
    ot.duration_hours AS tour_duration_hours,
    ot.duration_type,
    ot.multi_day_count,
    ot.difficulty AS tour_difficulty,
    ot.max_participants AS max_group_size,
    ot.min_participants AS min_group_size,
    COALESCE(ot.rating, 0::numeric) AS tour_rating,
    COALESCE(ot.review_count, 0) AS tour_review_count,
    ot.included,
    ot.season_start,
    ot.season_end,
    p.id AS operator_id,
    COALESCE(p.company_name, p.name) AS operator_name,
    p.slug AS operator_slug,
    p.hero_image AS operator_hero_image,
    COALESCE(p.rating, 0::numeric) AS operator_rating,
    COALESCE(p.review_count, 0) AS operator_review_count,
    COALESCE(p.commission_current, p.commission_rate, 15.00) AS commission_rate,
    p.is_verified AS operator_verified,
    ns.date AS next_departure_date,
    ns.available_slots AS next_departure_slots,
    ns.price_override AS next_departure_price,
    COALESCE(ot.rating, 0::numeric) * 0.7 + (1.0 - COALESCE(p.commission_current, p.commission_rate, 0.15) / 100.0) * 0.3 AS marketplace_score
   FROM operator_tours ot
     JOIN partners p ON p.id = ot.operator_id
     JOIN _agent_route_knowledge_legacy ark ON ark.id = ot.agent_route_id
     LEFT JOIN LATERAL ( SELECT ta.date,
            ta.available_slots,
            ta.base_price_override AS price_override
           FROM tour_availability ta
          WHERE ta.operator_tour_id = ot.id AND ta.is_cancelled = false AND ta.available_slots > COALESCE(ta.booked_slots, 0) AND ta.date >= CURRENT_DATE
          ORDER BY ta.date
         LIMIT 1) ns ON true
  WHERE ot.is_active = true AND ot.is_published = true AND ot.deleted_at IS NULL AND p.is_public = true;
CREATE OR REPLACE VIEW v_calendar_platform_summary AS
 SELECT b.booking_date AS date,
    count(b.id) AS total_bookings,
    count(b.id) FILTER (WHERE b.booking_status::text = 'new'::text) AS new_bookings,
    count(b.id) FILTER (WHERE b.booking_status::text = 'confirmed'::text) AS confirmed_bookings,
    count(b.id) FILTER (WHERE b.booking_status::text = 'cancelled'::text) AS cancelled_bookings,
    count(b.id) FILTER (WHERE b.booking_status::text = 'completed'::text) AS completed_bookings,
    COALESCE(sum(b.final_price) FILTER (WHERE b.booking_status::text <> 'cancelled'::text), 0::numeric) AS revenue,
    count(DISTINCT t.operator_id) AS active_operators,
    count(DISTINCT b.operator_tour_id) AS active_tours,
    COALESCE(sum(b.participants) FILTER (WHERE b.booking_status::text = ANY (ARRAY['new'::character varying::text, 'confirmed'::character varying::text])), 0::bigint) AS booked_participants,
        CASE
            WHEN count(b.id) > 0 THEN round(count(b.id) FILTER (WHERE b.booking_status::text = 'cancelled'::text)::numeric / count(b.id)::numeric, 2)
            ELSE NULL::numeric
        END AS cancellation_rate
   FROM operator_bookings b
     JOIN operator_tours t ON b.operator_tour_id = t.id
  WHERE b.deleted_at IS NULL
  GROUP BY b.booking_date;

-- ══ triggers (41) ══════════════════════════════
CREATE TRIGGER trg_accommodation_availability_updated_at BEFORE UPDATE ON accommodation_availability FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_accommodation_bookings_updated_at BEFORE UPDATE ON accommodation_bookings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_calculate_nights BEFORE INSERT OR UPDATE ON accommodation_bookings FOR EACH ROW EXECUTE FUNCTION calculate_nights();
CREATE TRIGGER trg_update_accommodation_rating AFTER INSERT OR UPDATE ON accommodation_reviews FOR EACH ROW WHEN (new.is_visible = true) EXECUTE FUNCTION update_accommodation_rating();
CREATE TRIGGER trg_accommodation_rooms_updated_at BEFORE UPDATE ON accommodation_rooms FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_accommodations_updated_at BEFORE UPDATE ON accommodations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER agent_knowledge_updated_at BEFORE UPDATE ON agent_knowledge FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER ark_insert INSTEAD OF INSERT ON agent_route_knowledge FOR EACH ROW EXECUTE FUNCTION ark_view_insert();
CREATE TRIGGER ark_update INSTEAD OF UPDATE ON agent_route_knowledge FOR EACH ROW EXECUTE FUNCTION ark_view_update();
CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_chat_sessions_updated_at BEFORE UPDATE ON chat_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_contingency_rules_timestamp BEFORE UPDATE ON contingency_rules FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER update_driver_schedules_updated_at BEFORE UPDATE ON driver_schedules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_drivers_updated_at BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_eco_contribution_not_transferable BEFORE INSERT ON eco_ledger FOR EACH ROW EXECUTE FUNCTION eco_contribution_is_not_transferable();
CREATE TRIGGER trg_eco_ledger_append_only BEFORE DELETE OR UPDATE ON eco_ledger FOR EACH ROW EXECUTE FUNCTION eco_ledger_append_only();
CREATE TRIGGER trg_external_tools_fts BEFORE INSERT OR UPDATE ON external_tools FOR EACH ROW EXECUTE FUNCTION external_tools_fts_update();
CREATE TRIGGER update_guide_certifications_updated_at BEFORE UPDATE ON guide_certifications FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_guide_reviews_updated_at BEFORE UPDATE ON guide_reviews FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_guide_schedule_updated_at BEFORE UPDATE ON guide_schedule FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION fn_leads_updated_at();
CREATE TRIGGER update_message_templates_updated_at BEFORE UPDATE ON message_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_notification_preferences_updated_at BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_operator_bookings_timestamp BEFORE UPDATE ON operator_bookings FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER update_operator_settings_updated_at BEFORE UPDATE ON operator_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_operator_tours_timestamp BEFORE UPDATE ON operator_tours FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_sync_partner_company_name BEFORE UPDATE ON partners FOR EACH ROW EXECUTE FUNCTION sync_partner_company_name();
CREATE TRIGGER update_partners_updated_at BEFORE UPDATE ON partners FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_partner_rating_trigger AFTER INSERT OR DELETE OR UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION update_partner_rating();
CREATE TRIGGER update_reviews_updated_at BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tour_rating_trigger AFTER INSERT OR DELETE OR UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION update_tour_rating();
CREATE TRIGGER trg_safety_alerts_updated_at BEFORE UPDATE ON safety_alerts FOR EACH ROW EXECUTE FUNCTION update_safety_alerts_updated_at();
CREATE TRIGGER trigger_tour_availability_timestamp BEFORE UPDATE ON tour_availability FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_tour_departures_updated_at BEFORE UPDATE ON tour_departures FOR EACH ROW EXECUTE FUNCTION update_tour_departures_updated_at();
CREATE TRIGGER update_tours_updated_at BEFORE UPDATE ON tours FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_transfer_reviews_updated_at BEFORE UPDATE ON transfer_reviews FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_transfer_routes_updated_at BEFORE UPDATE ON transfer_routes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_transfers_updated_at BEFORE UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_user_trips_updated_at BEFORE UPDATE ON user_trips FOR EACH ROW EXECUTE FUNCTION set_user_trips_updated_at();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_vehicles_updated_at BEFORE UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
