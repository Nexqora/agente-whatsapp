// Enrutamiento de mensajes entrantes y ciclo de respuesta por conversación.
// Las reglas deterministas (consentimiento, BAJA, archivos, conversación tomada por
// una persona) se resuelven aquí, sin modelo. Solo el texto con consentimiento llega a Claude.
import { type LlmClient, runAgent } from "./agent.ts";
import { handOff } from "./handoff.ts";
import { CONSENT_BUTTONS, isNo, isOptIn, isOptOut, isYes, texts } from "./texts.ts";
import type {
  Config,
  Conversation,
  InboundMessage,
  Knowledge,
  Store,
  WhatsAppSender,
} from "./types.ts";

export interface Deps {
  store: Store;
  wa: WhatsAppSender;
  llm: LlmClient;
  config: Config;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_CONSENT_PROMPTS = 2;
const HISTORY_LIMIT = 40;
const CLAIM_SECONDS = 120;

const nowOf = (d: Deps) => (d.now ? d.now() : new Date());
const sleepOf = (d: Deps) => d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

/** Envía un mensaje fijo y lo guarda fuera del historial del modelo. */
async function sendSystem(d: Deps, conv: Conversation, to: string, body: string) {
  const wamid = await d.wa.sendText(to, body);
  await d.store.insertOutbound({
    conversation_id: conv.id,
    wamid,
    author: "system",
    kind: "text",
    body,
    in_history: false,
  });
}

/**
 * Guarda cada mensaje y aplica las reglas fijas.
 * Devuelve los ids de conversación que el agente debe responder.
 */
export async function handleInbound(d: Deps, messages: InboundMessage[]): Promise<string[]> {
  const toProcess = new Set<string>();
  let knowledge: Knowledge | null = null;
  const getKnowledge = async () => (knowledge ??= await d.store.getKnowledge());

  for (const m of messages) {
    const contact = await d.store.upsertContact(m.from, m.profileName);
    const conv = await d.store.openConversation(contact.id);
    const text = m.text?.trim() ?? "";

    // ¿Es la respuesta a la pregunta de consentimiento?
    const answeringConsent = contact.consent_status !== "granted" &&
      (m.buttonId === "consent_yes" || m.buttonId === "consent_no" ||
        (contact.consent_prompts > 0 && (isYes(text) || isNo(text))));
    const isKeyword = isOptOut(text) || isOptIn(text);

    const inserted = await d.store.insertInbound({
      conversation_id: conv.id,
      wamid: m.wamid,
      kind: m.kind,
      body: m.text,
      in_history: !answeringConsent && !isKeyword,
    });
    if (!inserted) continue; // Meta reintentó: ya se atendió.

    const window = new Date(nowOf(d).getTime() + 24 * 3600 * 1000).toISOString();
    await d.store.touchConversation(conv.id, window);
    await d.wa.markRead(m.wamid);

    // 1. BAJA / ALTA: solo afectan los mensajes de seguimiento (plantillas).
    if (isOptOut(text)) {
      await d.store.updateContact(contact.id, { opt_out: true });
      await d.store.markAllProcessed(conv.id);
      await sendSystem(d, conv, contact.phone, texts.optOut);
      continue;
    }
    if (isOptIn(text)) {
      await d.store.updateContact(contact.id, { opt_out: false });
      await d.store.markAllProcessed(conv.id);
      await sendSystem(d, conv, contact.phone, texts.optIn);
      continue;
    }

    // 2. Consentimiento de datos (Ley 1581): antes de cualquier respuesta del modelo.
    if (contact.consent_status !== "granted") {
      const k = await getKnowledge();
      const yes = m.buttonId === "consent_yes" || (answeringConsent && isYes(text));
      const no = m.buttonId === "consent_no" || (answeringConsent && isNo(text));

      if (yes) {
        await d.store.updateContact(contact.id, {
          consent_status: "granted",
          consent_at: nowOf(d).toISOString(),
          consent_prompts: 0,
        });
        await d.store.logConsent(contact.phone, true, d.config.legalVersion);
        contact.consent_status = "granted";
        // La respuesta de consentimiento no se contesta; sí los mensajes anteriores.
        await d.store.markProcessed(
          (await d.store.unprocessedInbound(conv.id))
            .filter((x) => x.wamid === m.wamid)
            .map((x) => x.id),
        );
        toProcess.add(conv.id);
        continue;
      }

      if (no) {
        await d.store.updateContact(contact.id, { consent_status: "declined", consent_prompts: 0 });
        await d.store.redactConversation(conv.id);
        await d.store.markAllProcessed(conv.id);
        await sendSystem(d, conv, contact.phone, texts.consentDeclined(k));
        continue;
      }

      if (contact.consent_prompts < MAX_CONSENT_PROMPTS) {
        const prompt = texts.consentPrompt(k);
        const wamid = await d.wa.sendButtons(contact.phone, prompt, CONSENT_BUTTONS);
        await d.store.insertOutbound({
          conversation_id: conv.id,
          wamid,
          author: "system",
          kind: "button",
          body: prompt,
          in_history: false,
        });
        await d.store.updateContact(contact.id, {
          consent_status: "pending",
          consent_prompts: contact.consent_prompts + 1,
        });
        contact.consent_prompts += 1;
        // El mensaje queda pendiente: se responde si acepta.
      } else {
        await d.store.markAllProcessed(conv.id);
        await sendSystem(d, conv, contact.phone, texts.consentGaveUp(k));
      }
      continue;
    }

    // 3. Una persona tomó la conversación: el bot no responde.
    if (conv.status === "human") {
      await d.store.markAllProcessed(conv.id);
      continue;
    }

    // 4. Audio, imagen, documento, ubicación…: el bot solo lee texto.
    if (m.kind !== "text" && m.kind !== "button") {
      const k = await getKnowledge();
      await d.store.markAllProcessed(conv.id);
      await sendSystem(d, conv, contact.phone, texts.media(k));
      await handOff(d, conv, contact, "archivo", `El cliente envió un mensaje de tipo ${m.kind}.`);
      continue;
    }

    toProcess.add(conv.id);
  }
  return [...toProcess];
}

/**
 * Responde los mensajes pendientes de una conversación. Agrupa ráfagas (espera
 * `debounceMs`) y repite mientras sigan llegando mensajes durante la respuesta.
 */
export async function processConversation(d: Deps, conversationId: string): Promise<void> {
  await sleepOf(d)(d.config.debounceMs);

  for (let round = 0; round < 3; round++) {
    if (!(await d.store.claimConversation(conversationId, CLAIM_SECONDS))) return;
    const { conversation: conv, contact } = await d.store.getContext(conversationId);
    let knowledge: Knowledge = {};
    try {
      const pending = await d.store.unprocessedInbound(conv.id);
      if (pending.length === 0 || conv.status !== "bot" || contact.consent_status !== "granted") {
        return;
      }
      knowledge = await d.store.getKnowledge();

      // Límites de uso: protegen el costo y frenan abusos.
      const hourAgo = new Date(nowOf(d).getTime() - 3600 * 1000).toISOString();
      const dayAgo = new Date(nowOf(d).getTime() - 24 * 3600 * 1000).toISOString();
      const [inboundLastHour, tokensToday] = await Promise.all([
        d.store.countInboundSince(conv.id, hourAgo),
        d.store.tokensSince(conv.id, dayAgo),
      ]);
      if (inboundLastHour > d.config.maxInboundPerHour || tokensToday > d.config.maxTokensPerDay) {
        await d.store.markProcessed(pending.map((p) => p.id));
        await sendSystem(d, conv, contact.phone, texts.limit(knowledge));
        await handOff(d, conv, contact, "limite", "Se superó el límite de uso del asistente.");
        return;
      }

      const history = (await d.store.history(conv.id, HISTORY_LIMIT)).filter((h) => h.in_history);
      const result = await runAgent(d, { contact, conversation: conv, history, knowledge });

      if (result.text) {
        const wamid = await d.wa.sendText(contact.phone, result.text);
        await d.store.insertOutbound({
          conversation_id: conv.id,
          wamid,
          author: "bot",
          kind: "text",
          body: result.text.slice(0, 4096),
          in_history: true,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
        });
      }
      await d.store.markProcessed(pending.map((p) => p.id));
    } catch (err) {
      console.error("Error respondiendo la conversación", conversationId, err);
      await d.store.markAllProcessed(conv.id).catch(() => {});
      try {
        await sendSystem(d, conv, contact.phone, texts.error(knowledge));
        await handOff(d, conv, contact, "error", "El asistente falló al responder.");
      } catch (inner) {
        console.error("Tampoco se pudo avisar del error", inner);
      }
      return;
    } finally {
      await d.store.releaseConversation(conversationId).catch(() => {});
    }
  }
}
