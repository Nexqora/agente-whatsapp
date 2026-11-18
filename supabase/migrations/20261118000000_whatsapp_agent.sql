-- Agente de WhatsApp · fase 1
-- Idempotente: se puede correr varias veces en el editor SQL de Supabase.
-- Toca tablas existentes solo de forma aditiva (columnas nuevas, restricciones ampliadas).

-- ─────────────────────────────────────────────────────────────
-- 1. contact_leads: aceptar prospectos que llegan por WhatsApp
-- ─────────────────────────────────────────────────────────────
alter table public.contact_leads add column if not exists phone text;
alter table public.contact_leads add column if not exists source text not null default 'web';

-- Un prospecto de WhatsApp puede no tener correo todavía.
alter table public.contact_leads alter column email drop not null;

alter table public.contact_leads drop constraint if exists contact_leads_source_check;
alter table public.contact_leads
  add constraint contact_leads_source_check check (source in ('web', 'whatsapp'));

alter table public.contact_leads drop constraint if exists contact_leads_phone_check;
alter table public.contact_leads
  add constraint contact_leads_phone_check check (phone is null or phone ~ '^\+?[0-9]{7,15}$');

alter table public.contact_leads drop constraint if exists contact_leads_email_or_phone;
alter table public.contact_leads
  add constraint contact_leads_email_or_phone check (email is not null or phone is not null);

-- ─────────────────────────────────────────────────────────────
-- 2. consent_log: registrar consentimientos dados por WhatsApp
-- ─────────────────────────────────────────────────────────────
alter table public.consent_log add column if not exists phone text;
alter table public.consent_log alter column email drop not null;

do $$
declare c record;
begin
  -- Quitar la restricción vieja de `form` (contact/referral), sea cual sea su nombre.
  for c in
    select conname from pg_constraint
    where conrelid = 'public.consent_log'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%form%'
      and conname <> 'consent_log_form_check_v2'
  loop
    execute format('alter table public.consent_log drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.consent_log drop constraint if exists consent_log_form_check_v2;
alter table public.consent_log
  add constraint consent_log_form_check_v2 check (form in ('contact', 'referral', 'whatsapp'));

alter table public.consent_log drop constraint if exists consent_log_email_or_phone;
alter table public.consent_log
  add constraint consent_log_email_or_phone check (email is not null or phone is not null);

-- ─────────────────────────────────────────────────────────────
-- 3. Tablas del agente
-- ─────────────────────────────────────────────────────────────
create table if not exists public.wa_contacts (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique check (phone ~ '^[0-9]{7,15}$'),
  profile_name text check (profile_name is null or char_length(profile_name) <= 100),
  consent_status text not null default 'pending'
    check (consent_status in ('pending', 'granted', 'declined')),
  consent_prompts integer not null default 0,
  consent_at timestamptz,
  opt_out boolean not null default false,
  lead_id bigint references public.contact_leads(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wa_conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.wa_contacts(id) on delete cascade,
  status text not null default 'bot' check (status in ('bot', 'human', 'closed')),
  window_expires_at timestamptz,
  processing_until timestamptz,
  handoff_reason text,
  handoff_summary text check (handoff_summary is null or char_length(handoff_summary) <= 1000),
  handoff_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Una sola conversación abierta por contacto.
create unique index if not exists wa_conversations_one_open
  on public.wa_conversations (contact_id) where status <> 'closed';

create table if not exists public.wa_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  wamid text unique,
  direction text not null check (direction in ('in', 'out')),
  author text not null check (author in ('customer', 'bot', 'human', 'system')),
  kind text not null default 'text',
  body text check (body is null or char_length(body) <= 4096),
  in_history boolean not null default true,
  status text,
  input_tokens integer,
  output_tokens integer,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists wa_messages_conversation_created
  on public.wa_messages (conversation_id, created_at);
create index if not exists wa_messages_unprocessed
  on public.wa_messages (conversation_id) where direction = 'in' and processed_at is null;

-- ─────────────────────────────────────────────────────────────
-- 4. Seguridad: solo admins leen y editan. La Edge Function usa la service role.
-- ─────────────────────────────────────────────────────────────
alter table public.wa_contacts enable row level security;
alter table public.wa_conversations enable row level security;
alter table public.wa_messages enable row level security;

drop policy if exists wa_contacts_admin_all on public.wa_contacts;
create policy wa_contacts_admin_all on public.wa_contacts for all to authenticated
  using (exists (select 1 from public.site_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.site_admins a where a.user_id = auth.uid()));

drop policy if exists wa_conversations_admin_all on public.wa_conversations;
create policy wa_conversations_admin_all on public.wa_conversations for all to authenticated
  using (exists (select 1 from public.site_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.site_admins a where a.user_id = auth.uid()));

drop policy if exists wa_messages_admin_all on public.wa_messages;
create policy wa_messages_admin_all on public.wa_messages for all to authenticated
  using (exists (select 1 from public.site_admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.site_admins a where a.user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────
-- 5. Conocimiento del agente (editable desde SQL hoy; desde el Admin en la fase 2)
--    REVISAR ANTES DE ACTIVAR: los textos de planes son una propuesta.
-- ─────────────────────────────────────────────────────────────
insert into public.site_settings (setting_key, setting_value)
values ('wa_agent_knowledge', $json${
  "modelo_comercial": "Nexqora construye aplicaciones web a medida con un modelo de implementación más mensualidad. La mensualidad cubre alojamiento, mantenimiento, soporte y mejoras menores. La plataforma sigue siendo de Nexqora; el cliente es dueño de su contenido y sus datos.",
  "proceso": [
    {"paso": "Diagnóstico", "detalle": "Conversación corta para entender el negocio, qué debe poder hacer su cliente y qué necesita administrar."},
    {"paso": "Propuesta", "detalle": "Propuesta escrita con alcance, plan recomendado y tiempos."},
    {"paso": "Implementación y entrega", "detalle": "Construcción, revisión con el cliente, publicación y capacitación para usar el panel."}
  ],
  "planes": [
    {"nombre": "Esencial", "para_quien": "Negocios que necesitan presencia profesional y que sus clientes los contacten o pidan fácil.", "incluye": ["Página con su marca", "Catálogo con pedido por WhatsApp", "Formulario de contacto", "Panel para editar textos y servicios"]},
    {"nombre": "Completo", "para_quien": "Negocios que quieren vender o agendar en línea y conocer a sus clientes.", "incluye": ["Todo lo de Esencial", "Tienda con pago o reservas y citas", "Clientes y fidelización", "Reportes básicos"]},
    {"nombre": "Integral", "para_quien": "Negocios con procesos propios que quieren automatizar.", "incluye": ["Todo lo de Completo", "Sistemas y automatización a medida", "Reportes avanzados", "Integraciones con otras herramientas"]}
  ],
  "precios": "Los precios dependen del alcance y se entregan en la propuesta después del diagnóstico.",
  "horario_humano": "Lunes a viernes de 7:00 a 19:00 y sábados de 8:00 a 15:00 (hora de Colombia).",
  "agenda_url": "",
  "formulario_url": "https://TU-DOMINIO.com/#contacto",
  "privacidad_url": "https://TU-DOMINIO.com/privacidad"
}$json$::jsonb)
on conflict (setting_key) do nothing;
