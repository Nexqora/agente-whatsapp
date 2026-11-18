import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { toMessages } from "../_shared/agent.ts";
import { handleInbound, processConversation } from "../_shared/handler.ts";
import type { StoredMessage } from "../_shared/types.ts";
import { inbound, makeDeps } from "./fakes.ts";

type Ctx = ReturnType<typeof makeDeps>;

/** Primer mensaje + aceptación del consentimiento. Devuelve el id de conversación. */
async function consented({ deps }: Ctx, first = "Hola, tengo una repostería") {
  await handleInbound(deps, [inbound(first)]);
  const ids = await handleInbound(deps, [inbound("Sí, continuar", { kind: "button", buttonId: "consent_yes" })]);
  return ids[0];
}

Deno.test("el primer mensaje pide consentimiento y no llama a Claude", async () => {
  const t = makeDeps();
  const ids = await handleInbound(t.deps, [inbound("Hola")]);
  assertEquals(ids, []);
  assertEquals(t.wa.sent.length, 1);
  assertEquals(t.wa.sent[0].type, "buttons");
  assertMatch(t.wa.sent[0].body, /nexqora\.test\/privacidad/);
  assertEquals(t.llm.calls.length, 0);
  assertEquals(t.store.contacts[0].consent_prompts, 1);
  assertEquals(t.store.messages.filter((m) => m.direction === "in" && !m.processed_at).length, 1);
});

Deno.test("al aceptar se registra el consentimiento y Claude responde el primer mensaje", async () => {
  const t = makeDeps([{ stop: "end_turn", content: [{ type: "text", text: "¡Hola! ¿Qué quieres que hagan tus clientes?" }] }]);
  const convId = await consented(t);
  assertEquals(t.store.consents, [{ phone: "573001112233", granted: true, legalVersion: "test-1" }]);
  assertEquals(t.store.contacts[0].consent_status, "granted");

  await processConversation(t.deps, convId);
  assertEquals(t.llm.calls.length, 1);
  // Solo el mensaje real llega al modelo; el botón de consentimiento no.
  assertEquals(t.llm.calls[0].messages, [{ role: "user", content: "Hola, tengo una repostería" }]);
  const reply = t.wa.sent.at(-1)!;
  assertEquals(reply.body, "¡Hola! ¿Qué quieres que hagan tus clientes?");
  const stored = t.store.messages.at(-1)!;
  assertEquals([stored.author, stored.in_history], ["bot", true]);
  assertEquals(t.store.messages.filter((m) => m.direction === "in" && !m.processed_at).length, 0);
});

Deno.test("la petición a Claude usa el modelo, fallbacks, caché y herramientas estrictas", async () => {
  const t = makeDeps([{ stop: "end_turn", content: [{ type: "text", text: "Hola" }] }]);
  await processConversation(t.deps, await consented(t));
  const p = t.llm.calls[0] as unknown as Record<string, unknown> & {
    system: { cache_control?: unknown }[];
    tools: { strict?: boolean; name: string }[];
  };
  assertEquals(p.model, "claude-sonnet-5-5");
  assertEquals(p.fallbacks, "default");
  assertEquals(p.betas, ["server-side-fallback-2026-07-01"]);
  assertEquals(p.output_config, { effort: "low" });
  assertEquals(p.system[0].cache_control, { type: "ephemeral" });
  assert(p.tools.every((tool) => tool.strict === true));
  assertEquals(p.tools.map((tool) => tool.name), [
    "listar_soluciones",
    "info_nexqora",
    "guardar_prospecto",
    "agendar_diagnostico",
    "pasar_a_humano",
  ]);
});

Deno.test("al rechazar se borran los textos y no se llama a Claude", async () => {
  const t = makeDeps();
  await handleInbound(t.deps, [inbound("Hola, mi correo es ana@x.co")]);
  const ids = await handleInbound(t.deps, [inbound("No, gracias", { kind: "button", buttonId: "consent_no" })]);
  assertEquals(ids, []);
  assertEquals(t.store.contacts[0].consent_status, "declined");
  assert(t.store.messages.filter((m) => m.direction === "in").every((m) => m.body === null));
  assertMatch(t.wa.sent.at(-1)!.body, /formulario/);
  assertEquals(t.llm.calls.length, 0);
});

Deno.test("después de dos intentos sin respuesta se ofrece el formulario", async () => {
  const t = makeDeps();
  await handleInbound(t.deps, [inbound("Hola")]);
  await handleInbound(t.deps, [inbound("¿cuánto vale una página?")]);
  await handleInbound(t.deps, [inbound("???")]);
  assertEquals(t.wa.sent.map((s) => s.type), ["buttons", "buttons", "text"]);
  assertMatch(t.wa.sent[2].body, /autorización/);
});

Deno.test("un webhook repetido (mismo wamid) no se procesa dos veces", async () => {
  const t = makeDeps();
  const m = inbound("Hola");
  await handleInbound(t.deps, [m]);
  await handleInbound(t.deps, [m]);
  assertEquals(t.store.messages.filter((x) => x.direction === "in").length, 1);
  assertEquals(t.wa.sent.length, 1);
});

Deno.test("BAJA desactiva el seguimiento sin pasar por Claude", async () => {
  const t = makeDeps();
  const ids = await handleInbound(t.deps, [inbound("BAJA")]);
  assertEquals(ids, []);
  assertEquals(t.store.contacts[0].opt_out, true);
  assertMatch(t.wa.sent[0].body, /ALTA/);
});

Deno.test("un audio pasa la conversación al equipo y avisa a la dueña", async () => {
  const t = makeDeps();
  await consented(t);
  const ids = await handleInbound(t.deps, [inbound("", { kind: "audio", text: null })]);
  assertEquals(ids, []);
  assertEquals(t.store.conversations[0].status, "human");
  assertEquals(t.store.conversations[0].handoff_reason, "archivo");
  const template = t.wa.sent.find((s) => s.type === "template")!;
  assertEquals(template.to, "573000000000");
  assertEquals(template.params, ["Laura", "+573001112233", "archivo"]);
});

Deno.test("con la conversación en manos del equipo el bot no responde", async () => {
  const t = makeDeps();
  const convId = await consented(t);
  t.store.conversations[0].status = "human";
  const ids = await handleInbound(t.deps, [inbound("¿Siguen ahí?")]);
  assertEquals(ids, []);
  await processConversation(t.deps, convId);
  assertEquals(t.llm.calls.length, 0);
});

Deno.test("guardar_prospecto crea la ficha con teléfono y descarta correos inválidos", async () => {
  const t = makeDeps([
    {
      stop: "tool_use",
      content: [{
        type: "tool_use",
        name: "guardar_prospecto",
        input: {
          nombre: "Laura",
          negocio: "Dulce Laura",
          sector: "Repostería",
          necesidad: "Recibir pedidos de tortas por la web",
          tiene_sistema_actual: null,
          urgencia: "Diciembre",
          solucion_interes: null,
          correo: "laura@correo.co?bcc=x",
        },
      }],
    },
    { stop: "end_turn", content: [{ type: "text", text: "Listo, ¿agendamos el diagnóstico?" }] },
  ]);
  await processConversation(t.deps, await consented(t));

  assertEquals(t.store.leads.length, 1);
  const lead = t.store.leads[0];
  assertEquals(lead.phone, "+573001112233");
  assertEquals(lead.email, null);
  assertEquals(lead.business_name, "Dulce Laura");
  assertMatch(lead.message, /Necesidad: Recibir pedidos/);
  assertMatch(lead.message, /Origen: WhatsApp/);
  assertEquals(t.store.contacts[0].lead_id, 1);

  // La segunda petición lleva el resultado de la herramienta.
  const second = t.llm.calls[1].messages;
  const last = second.at(-1)!;
  assertEquals(last.role, "user");
  const result = (last.content as { type: string; content: string }[])[0];
  assertEquals(result.type, "tool_result");
  assertMatch(result.content, /correo no parece válido/);
  assertEquals(t.wa.sent.at(-1)!.body, "Listo, ¿agendamos el diagnóstico?");
});

Deno.test("pasar_a_humano marca la conversación y el bot se despide", async () => {
  const t = makeDeps([
    {
      stop: "tool_use",
      content: [{
        type: "tool_use",
        name: "pasar_a_humano",
        input: { motivo: "precio", resumen: "Repostería, quiere pedidos web, pide precio exacto." },
      }],
    },
    { stop: "end_turn", content: [{ type: "text", text: "Te paso con el equipo." }] },
  ]);
  await processConversation(t.deps, await consented(t, "¿Cuánto cuesta exactamente?"));
  assertEquals(t.store.conversations[0].status, "human");
  assertEquals(t.store.conversations[0].handoff_reason, "precio");
  assert(t.wa.sent.some((s) => s.type === "template"));
  assertEquals(t.wa.sent.at(-1)!.body, "Te paso con el equipo.");
});

Deno.test("una negativa del modelo termina en traspaso con mensaje amable", async () => {
  const t = makeDeps([{ stop: "refusal", content: [] }]);
  await processConversation(t.deps, await consented(t));
  assertEquals(t.store.conversations[0].status, "human");
  assertMatch(t.wa.sent.at(-1)!.body, /equipo de Nexqora/);
});

Deno.test("si Claude falla se avisa al cliente y pasa al equipo", async () => {
  const t = makeDeps([]); // sin respuestas: el doble lanza un error
  await processConversation(t.deps, await consented(t));
  assertEquals(t.store.conversations[0].status, "human");
  assertEquals(t.store.conversations[0].handoff_reason, "error");
  assertMatch(t.wa.sent.find((s) => s.type === "text")!.body, /problema/);
  assertEquals(t.store.conversations[0].processing, false);
});

Deno.test("superar el límite por hora pasa al equipo sin gastar tokens", async () => {
  const t = makeDeps();
  t.deps.config = { ...t.deps.config, maxInboundPerHour: 1 };
  await processConversation(t.deps, await consented(t));
  assertEquals(t.llm.calls.length, 0);
  assertEquals(t.store.conversations[0].handoff_reason, "limite");
});

Deno.test("toMessages agrupa turnos seguidos, marca al equipo y empieza por el cliente", () => {
  const msg = (author: StoredMessage["author"], body: string): StoredMessage => ({
    id: body,
    conversation_id: "c",
    wamid: null,
    direction: author === "customer" ? "in" : "out",
    author,
    kind: "text",
    body,
    in_history: true,
    processed_at: null,
    created_at: "",
  });
  assertEquals(
    toMessages([
      msg("bot", "mensaje viejo del bot"),
      msg("customer", "hola"),
      msg("customer", "tengo un consultorio"),
      msg("bot", "¿qué necesitas?"),
      msg("human", "Soy Ana del equipo"),
      msg("customer", "gracias"),
    ]),
    [
      { role: "user", content: "hola\n\ntengo un consultorio" },
      { role: "assistant", content: "¿qué necesitas?\n\n[Equipo Nexqora] Soy Ana del equipo" },
      { role: "user", content: "gracias" },
    ],
  );
});
