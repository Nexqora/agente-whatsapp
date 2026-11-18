// Dobles de prueba en memoria: Store, WhatsApp y Claude.
import type { Anthropic } from "../_shared/deps.ts";
import type { LlmClient } from "../_shared/agent.ts";
import type { Deps } from "../_shared/handler.ts";
import type {
  Button,
  Config,
  Contact,
  ContactPatch,
  Conversation,
  InboundMessage,
  Knowledge,
  LeadData,
  NewInbound,
  NewOutbound,
  Service,
  Store,
  StoredMessage,
  WhatsAppSender,
} from "../_shared/types.ts";

type Msg = StoredMessage & { input_tokens?: number; output_tokens?: number };

export class MemoryStore implements Store {
  contacts: Contact[] = [];
  conversations: (Conversation & { processing: boolean; handoff_reason?: string; handoff_summary?: string })[] = [];
  messages: Msg[] = [];
  leads: (LeadData & { id: number })[] = [];
  consents: { phone: string; granted: boolean; legalVersion: string }[] = [];
  knowledge: Knowledge = {
    privacidad_url: "https://nexqora.test/privacidad",
    formulario_url: "https://nexqora.test/#contacto",
    agenda_url: "https://cal.test/nexqora",
    horario_humano: "L–V 7–19 h",
    precios: "Se entregan en la propuesta.",
  };
  services: Service[] = [
    {
      title: "Reservas y citas",
      description: "Agenda en línea",
      tag: "Ventas",
      title_en: "Bookings",
      description_en: "Online booking",
      tag_en: "Sales",
    },
  ];
  private seq = 0;
  private id = () => `id-${++this.seq}`;
  private clock = 0;
  private ts = () => new Date(Date.UTC(2026, 10, 18, 12, 0, 0) + ++this.clock * 1000).toISOString();

  upsertContact(phone: string, profileName: string | null) {
    let c = this.contacts.find((x) => x.phone === phone);
    if (!c) {
      c = {
        id: this.id(),
        phone,
        profile_name: profileName,
        consent_status: "pending",
        consent_prompts: 0,
        opt_out: false,
        lead_id: null,
      };
      this.contacts.push(c);
    }
    return Promise.resolve({ ...c });
  }
  updateContact(id: string, patch: ContactPatch) {
    const c = this.contacts.find((x) => x.id === id)!;
    const { consent_at: _ignored, ...rest } = patch;
    Object.assign(c, rest);
    return Promise.resolve();
  }
  openConversation(contactId: string) {
    let conv = this.conversations.find((x) => x.contact_id === contactId && x.status !== "closed");
    if (!conv) {
      conv = { id: this.id(), contact_id: contactId, status: "bot", processing: false };
      this.conversations.push(conv);
    }
    return Promise.resolve({ id: conv.id, contact_id: conv.contact_id, status: conv.status });
  }
  getContext(conversationId: string) {
    const c = this.conversations.find((x) => x.id === conversationId)!;
    const contact = this.contacts.find((x) => x.id === c.contact_id)!;
    return Promise.resolve({
      conversation: { id: c.id, contact_id: c.contact_id, status: c.status },
      contact: { ...contact },
    });
  }
  insertInbound(msg: NewInbound) {
    if (this.messages.some((m) => m.wamid === msg.wamid)) return Promise.resolve(false);
    this.messages.push({
      id: this.id(),
      ...msg,
      direction: "in",
      author: "customer",
      processed_at: null,
      created_at: this.ts(),
    });
    return Promise.resolve(true);
  }
  insertOutbound(msg: NewOutbound) {
    this.messages.push({
      id: this.id(),
      ...msg,
      direction: "out",
      processed_at: this.ts(),
      created_at: this.ts(),
    });
    return Promise.resolve();
  }
  updateMessageStatus() {
    return Promise.resolve();
  }
  touchConversation() {
    return Promise.resolve();
  }
  claimConversation(id: string) {
    const c = this.conversations.find((x) => x.id === id)!;
    if (c.processing) return Promise.resolve(false);
    c.processing = true;
    return Promise.resolve(true);
  }
  releaseConversation(id: string) {
    this.conversations.find((x) => x.id === id)!.processing = false;
    return Promise.resolve();
  }
  unprocessedInbound(conversationId: string) {
    return Promise.resolve(
      this.messages.filter((m) =>
        m.conversation_id === conversationId && m.direction === "in" && !m.processed_at
      ),
    );
  }
  markProcessed(ids: string[]) {
    for (const m of this.messages) if (ids.includes(m.id)) m.processed_at = this.ts();
    return Promise.resolve();
  }
  markAllProcessed(conversationId: string) {
    for (const m of this.messages) {
      if (m.conversation_id === conversationId && m.direction === "in" && !m.processed_at) {
        m.processed_at = this.ts();
      }
    }
    return Promise.resolve();
  }
  history(conversationId: string, limit: number) {
    return Promise.resolve(
      this.messages.filter((m) => m.conversation_id === conversationId).slice(-limit),
    );
  }
  redactConversation(conversationId: string) {
    for (const m of this.messages) {
      if (m.conversation_id === conversationId && m.direction === "in") {
        m.body = null;
        m.in_history = false;
      }
    }
    return Promise.resolve();
  }
  countInboundSince(conversationId: string) {
    return Promise.resolve(
      this.messages.filter((m) => m.conversation_id === conversationId && m.direction === "in").length,
    );
  }
  tokensSince(conversationId: string) {
    return Promise.resolve(
      this.messages.filter((m) => m.conversation_id === conversationId)
        .reduce((s, m) => s + (m.input_tokens ?? 0) + (m.output_tokens ?? 0), 0),
    );
  }
  logConsent(phone: string, granted: boolean, legalVersion: string) {
    this.consents.push({ phone, granted, legalVersion });
    return Promise.resolve();
  }
  saveLead(contact: Contact, lead: LeadData) {
    const stored = this.contacts.find((x) => x.id === contact.id)!;
    if (stored.lead_id) {
      Object.assign(this.leads.find((l) => l.id === stored.lead_id)!, lead);
      return Promise.resolve(stored.lead_id);
    }
    const id = this.leads.length + 1;
    this.leads.push({ id, ...lead });
    stored.lead_id = id;
    return Promise.resolve(id);
  }
  listServices() {
    return Promise.resolve(this.services);
  }
  getKnowledge() {
    return Promise.resolve(this.knowledge);
  }
  handoff(conversationId: string, reason: string, summary: string) {
    const c = this.conversations.find((x) => x.id === conversationId)!;
    c.status = "human";
    c.handoff_reason = reason;
    c.handoff_summary = summary;
    return Promise.resolve();
  }
}

export class FakeWhatsApp implements WhatsAppSender {
  sent: { to: string; type: string; body: string; buttons?: Button[]; params?: string[] }[] = [];
  read: string[] = [];
  private n = 0;
  sendText(to: string, body: string) {
    this.sent.push({ to, type: "text", body });
    return Promise.resolve(`out-${++this.n}`);
  }
  sendButtons(to: string, body: string, buttons: Button[]) {
    this.sent.push({ to, type: "buttons", body, buttons });
    return Promise.resolve(`out-${++this.n}`);
  }
  sendTemplate(to: string, name: string, _lang: string, params: string[]) {
    this.sent.push({ to, type: "template", body: name, params });
    return Promise.resolve(`out-${++this.n}`);
  }
  markRead(wamid: string) {
    this.read.push(wamid);
    return Promise.resolve();
  }
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> };

/** Claude falso: devuelve respuestas guionadas en orden y guarda cada petición. */
export class ScriptedLlm implements LlmClient {
  calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  constructor(private script: { stop: string; content: Block[] }[]) {}
  create(params: Anthropic.Beta.MessageCreateParamsNonStreaming) {
    // Copia profunda: el agente sigue agregando mensajes al mismo arreglo.
    this.calls.push(structuredClone(params));
    const step = this.script.shift();
    if (!step) throw new Error("ScriptedLlm: no quedan respuestas");
    let i = 0;
    const content = step.content.map((b) =>
      b.type === "text"
        ? { type: "text", text: b.text, citations: null }
        : { type: "tool_use", id: `tu-${++i}`, name: b.name, input: b.input }
    );
    return Promise.resolve({
      id: "msg",
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: step.stop,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage);
  }
}

export const testConfig: Config = {
  model: "claude-sonnet-5-5",
  effort: "low",
  legalVersion: "test-1",
  ownerPhone: "573000000000",
  handoffTemplate: "aviso_traspaso",
  maxInboundPerHour: 30,
  maxTokensPerDay: 300000,
  debounceMs: 0,
};

export function makeDeps(script: { stop: string; content: Block[] }[] = []) {
  const store = new MemoryStore();
  const wa = new FakeWhatsApp();
  const llm = new ScriptedLlm(script);
  const deps: Deps = {
    store,
    wa,
    llm,
    config: testConfig,
    now: () => new Date("2026-11-18T15:00:00Z"),
    sleep: () => Promise.resolve(),
  };
  return { deps, store, wa, llm };
}

let counter = 0;
export function inbound(text: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    wamid: `wamid-${++counter}`,
    from: "573001112233",
    profileName: "Laura",
    kind: "text",
    text,
    buttonId: null,
    ...extra,
  };
}
