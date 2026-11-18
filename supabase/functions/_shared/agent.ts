// Ciclo de herramientas con Claude para producir una respuesta de WhatsApp.
import type { Anthropic } from "./deps.ts";
import { type HandoffDeps, handOff } from "./handoff.ts";
import { contextBlock, SYSTEM_PROMPT } from "./prompt.ts";
import { executeTool, TOOLS } from "./tools.ts";
import type { Contact, Conversation, Knowledge, StoredMessage } from "./types.ts";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export interface LlmClient {
  create(params: Params): Promise<Message>;
}

export interface AgentDeps extends HandoffDeps {
  llm: LlmClient;
  now?: () => Date;
}

export interface AgentInput {
  contact: Contact;
  conversation: Conversation;
  history: StoredMessage[];
  knowledge: Knowledge;
}

export interface AgentResult {
  text: string | null;
  inputTokens: number;
  outputTokens: number;
  handedOff: boolean;
}

const MAX_ITERATIONS = 6;

const FALLBACK_TEXT =
  "Gracias por escribir. Te paso con el equipo de Nexqora para seguir; te responden en horario hábil.";

/** Convierte el historial guardado en mensajes alternos usuario/asistente. */
export function toMessages(history: StoredMessage[]): MessageParam[] {
  const out: { role: "user" | "assistant"; parts: string[] }[] = [];
  for (const h of history) {
    if (!h.body) continue;
    const role = h.author === "customer" ? "user" : "assistant";
    const text = h.author === "human" ? `[Equipo Nexqora] ${h.body}` : h.body;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(text);
    else out.push({ role, parts: [text] });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.map((m) => ({ role: m.role, content: m.parts.join("\n\n") }));
}

export async function runAgent(d: AgentDeps, input: AgentInput): Promise<AgentResult> {
  const messages = toMessages(input.history);
  const result: AgentResult = { text: null, inputTokens: 0, outputTokens: 0, handedOff: false };
  if (!messages.length || messages[messages.length - 1].role !== "user") return result;

  const state = { handedOff: false };
  const ctx = {
    store: d.store,
    contact: input.contact,
    conversation: input.conversation,
    knowledge: input.knowledge,
    state,
    handOff: (reason: string, summary: string) =>
      handOff(d, input.conversation, input.contact, reason, summary),
  };

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: contextBlock(input.contact, d.now ? d.now() : new Date()) },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await d.llm.create({
      model: d.config.model,
      max_tokens: 4000,
      system,
      tools: TOOLS,
      messages,
      output_config: { effort: d.config.effort },
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    result.inputTokens += response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);
    result.outputTokens += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      if (!state.handedOff) await ctx.handOff("fuera_de_alcance", "El asistente no pudo responder este mensaje.");
      result.text = FALLBACK_TEXT;
      result.handedOff = true;
      return result;
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const results: ToolResult[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        try {
          const output = await executeTool(block.name, block.input as Record<string, unknown>, ctx);
          results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        } catch (err) {
          console.error("Herramienta falló", block.name, err);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "La herramienta falló. Continúa sin ella u ofrece pasar con el equipo.",
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    result.text = text || (state.handedOff ? FALLBACK_TEXT : null);
    result.handedOff = state.handedOff;
    if (!result.text) {
      await ctx.handOff("error", "El asistente terminó sin respuesta.");
      result.text = FALLBACK_TEXT;
      result.handedOff = true;
    }
    return result;
  }

  // Demasiadas vueltas de herramientas: mejor que siga una persona.
  if (!state.handedOff) await ctx.handOff("sin_avance", "El asistente no logró cerrar la respuesta.");
  result.text = FALLBACK_TEXT;
  result.handedOff = true;
  return result;
}
