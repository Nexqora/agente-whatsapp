// Tipos del dominio y contratos entre módulos. Las implementaciones reales
// (Supabase, Graph API, Claude) y las falsas de las pruebas cumplen estas interfaces.

export type ConsentStatus = "pending" | "granted" | "declined";
export type ConversationStatus = "bot" | "human" | "closed";
export type Author = "customer" | "bot" | "human" | "system";

export interface Contact {
  id: string;
  phone: string; // solo dígitos, con indicativo (573001234567)
  profile_name: string | null;
  consent_status: ConsentStatus;
  consent_prompts: number;
  opt_out: boolean;
  lead_id: number | null;
}

export interface Conversation {
  id: string;
  contact_id: string;
  status: ConversationStatus;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  wamid: string | null;
  direction: "in" | "out";
  author: Author;
  kind: string;
  body: string | null;
  in_history: boolean;
  processed_at: string | null;
  created_at: string;
}

export interface NewInbound {
  conversation_id: string;
  wamid: string;
  kind: string;
  body: string | null;
  in_history: boolean;
}

export interface NewOutbound {
  conversation_id: string;
  wamid: string | null;
  author: Author;
  kind: string;
  body: string;
  in_history: boolean;
  input_tokens?: number;
  output_tokens?: number;
}

export interface LeadData {
  name: string | null;
  business_name: string;
  service: string | null;
  message: string;
  email: string | null;
  phone: string;
}

export interface Service {
  title: string;
  description: string;
  tag: string;
  title_en: string | null;
  description_en: string | null;
  tag_en: string | null;
}

export type Knowledge = Record<string, unknown> & {
  agenda_url?: string;
  formulario_url?: string;
  privacidad_url?: string;
  horario_humano?: string;
};

export interface ContactPatch {
  profile_name?: string | null;
  consent_status?: ConsentStatus;
  consent_prompts?: number;
  consent_at?: string | null;
  opt_out?: boolean;
  lead_id?: number | null;
}

export interface Store {
  upsertContact(phone: string, profileName: string | null): Promise<Contact>;
  updateContact(id: string, patch: ContactPatch): Promise<void>;
  /** Devuelve la conversación abierta del contacto o crea una. */
  openConversation(contactId: string): Promise<Conversation>;
  getContext(conversationId: string): Promise<{ conversation: Conversation; contact: Contact }>;
  /** false si el wamid ya existía (Meta reintentó el webhook). */
  insertInbound(msg: NewInbound): Promise<boolean>;
  insertOutbound(msg: NewOutbound): Promise<void>;
  updateMessageStatus(wamid: string, status: string): Promise<void>;
  touchConversation(id: string, windowExpiresAt: string): Promise<void>;
  /** Bloqueo optimista para que dos ejecuciones no respondan la misma conversación. */
  claimConversation(id: string, seconds: number): Promise<boolean>;
  releaseConversation(id: string): Promise<void>;
  unprocessedInbound(conversationId: string): Promise<StoredMessage[]>;
  markProcessed(ids: string[]): Promise<void>;
  markAllProcessed(conversationId: string): Promise<void>;
  /** Últimos `limit` mensajes en orden cronológico. */
  history(conversationId: string, limit: number): Promise<StoredMessage[]>;
  redactConversation(conversationId: string): Promise<void>;
  countInboundSince(conversationId: string, sinceIso: string): Promise<number>;
  tokensSince(conversationId: string, sinceIso: string): Promise<number>;
  logConsent(phone: string, granted: boolean, legalVersion: string): Promise<void>;
  saveLead(contact: Contact, lead: LeadData): Promise<number>;
  listServices(): Promise<Service[]>;
  getKnowledge(): Promise<Knowledge>;
  handoff(conversationId: string, reason: string, summary: string): Promise<void>;
}

export interface Button {
  id: string;
  title: string; // máx. 20 caracteres (límite de Meta)
}

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<string | null>;
  sendButtons(to: string, body: string, buttons: Button[]): Promise<string | null>;
  sendTemplate(to: string, name: string, lang: string, params: string[]): Promise<string | null>;
  markRead(wamid: string): Promise<void>;
}

export interface Config {
  model: string;
  effort: "low" | "medium" | "high";
  legalVersion: string;
  ownerPhone: string | null;
  handoffTemplate: string | null;
  maxInboundPerHour: number;
  maxTokensPerDay: number;
  debounceMs: number;
}

export interface InboundMessage {
  wamid: string;
  from: string;
  profileName: string | null;
  kind: string; // text | button | audio | image | document | ...
  text: string | null;
  buttonId: string | null;
}
