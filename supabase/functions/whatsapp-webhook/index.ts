// Webhook de la WhatsApp Cloud API.
// GET: verificación de Meta. POST: mensajes y estados entrantes.
// Desplegar sin verificación JWT (Meta no envía token de Supabase; la seguridad es la firma):
//   supabase functions deploy whatsapp-webhook --no-verify-jwt
import { Anthropic, createClient } from "../_shared/deps.ts";
import { type Deps, handleInbound, processConversation } from "../_shared/handler.ts";
import { SupabaseStore } from "../_shared/store.ts";
import type { Config } from "../_shared/types.ts";
import { parseWebhook, verifySignature, WhatsAppClient } from "../_shared/whatsapp.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

const phoneNumberId = env("WA_PHONE_NUMBER_ID");
const appSecret = env("WA_APP_SECRET");
const verifyToken = env("WA_VERIFY_TOKEN");

const effort = env("WA_EFFORT", "low");
const config: Config = {
  model: env("WA_MODEL", "claude-sonnet-5-5"),
  effort: effort === "medium" || effort === "high" ? effort : "low",
  legalVersion: env("WA_LEGAL_VERSION", "2026-11"),
  ownerPhone: Deno.env.get("WA_OWNER_PHONE") || null,
  handoffTemplate: Deno.env.get("WA_HANDOFF_TEMPLATE") || null,
  maxInboundPerHour: Number(env("WA_MAX_INBOUND_PER_HOUR", "30")),
  maxTokensPerDay: Number(env("WA_MAX_TOKENS_PER_DAY", "300000")),
  debounceMs: Number(env("WA_DEBOUNCE_MS", "1500")),
};

const anthropic = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY"), maxRetries: 2, timeout: 60_000 });

const deps: Deps = {
  store: new SupabaseStore(
    createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    }),
  ),
  wa: new WhatsAppClient({
    accessToken: env("WA_ACCESS_TOKEN"),
    phoneNumberId,
    graphVersion: env("WA_GRAPH_VERSION", "v24.0"),
  }),
  llm: { create: (params) => anthropic.beta.messages.create(params) },
  config,
};

function background(p: Promise<unknown>) {
  const guarded = p.catch((err) => console.error("Tarea en segundo plano falló", err));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(guarded);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === verifyToken;
    return ok
      ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 })
      : new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get("x-hub-signature-256"), appSecret))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  try {
    const { messages, statuses } = parseWebhook(payload, phoneNumberId);
    await Promise.all(statuses.map((s) => deps.store.updateMessageStatus(s.wamid, s.status)));
    const conversations = await handleInbound(deps, messages);
    // Responder a Meta de inmediato; Claude trabaja en segundo plano.
    for (const id of conversations) background(processConversation(deps, id));
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Error procesando el webhook", err);
    // 500 hace que Meta reintente; los mensajes repetidos se descartan por wamid.
    return new Response("Error", { status: 500 });
  }
});
