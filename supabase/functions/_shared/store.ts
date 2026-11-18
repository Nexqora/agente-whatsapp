// Implementación de Store sobre Supabase (service role: salta RLS, solo en el servidor).
import type { SupabaseClient } from "./deps.ts";
import type {
  Contact,
  ContactPatch,
  Conversation,
  Knowledge,
  LeadData,
  NewInbound,
  NewOutbound,
  Service,
  Store,
  StoredMessage,
} from "./types.ts";

const CONTACT_COLS = "id, phone, profile_name, consent_status, consent_prompts, opt_out, lead_id";
const MESSAGE_COLS =
  "id, conversation_id, wamid, direction, author, kind, body, in_history, processed_at, created_at";

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new Error(`Supabase: ${res.error.message}`);
  return res.data;
}

export class SupabaseStore implements Store {
  constructor(private db: SupabaseClient) {}

  async upsertContact(phone: string, profileName: string | null): Promise<Contact> {
    const existing = check(
      await this.db.from("wa_contacts").select(CONTACT_COLS).eq("phone", phone).maybeSingle(),
    ) as Contact | null;
    if (existing) {
      if (profileName && profileName !== existing.profile_name) {
        await this.updateContact(existing.id, { profile_name: profileName.slice(0, 100) });
        existing.profile_name = profileName;
      }
      return existing;
    }
    const res = await this.db.from("wa_contacts")
      .insert({ phone, profile_name: profileName?.slice(0, 100) ?? null })
      .select(CONTACT_COLS).single();
    if (res.error?.code === "23505") return this.upsertContact(phone, profileName); // carrera
    return check(res) as Contact;
  }

  async updateContact(id: string, patch: ContactPatch): Promise<void> {
    check(
      await this.db.from("wa_contacts")
        .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id),
    );
  }

  async openConversation(contactId: string): Promise<Conversation> {
    const cols = "id, contact_id, status";
    const open = check(
      await this.db.from("wa_conversations").select(cols)
        .eq("contact_id", contactId).neq("status", "closed").maybeSingle(),
    ) as Conversation | null;
    if (open) return open;
    const res = await this.db.from("wa_conversations").insert({ contact_id: contactId })
      .select(cols).single();
    if (res.error?.code === "23505") return this.openConversation(contactId);
    return check(res) as Conversation;
  }

  async getContext(conversationId: string) {
    const conversation = check(
      await this.db.from("wa_conversations").select("id, contact_id, status")
        .eq("id", conversationId).single(),
    ) as Conversation;
    const contact = check(
      await this.db.from("wa_contacts").select(CONTACT_COLS).eq("id", conversation.contact_id).single(),
    ) as Contact;
    return { conversation, contact };
  }

  async insertInbound(msg: NewInbound): Promise<boolean> {
    const res = await this.db.from("wa_messages").insert({
      ...msg,
      body: msg.body?.slice(0, 4096) ?? null,
      direction: "in",
      author: "customer",
    });
    if (res.error?.code === "23505") return false;
    check(res);
    return true;
  }

  async insertOutbound(msg: NewOutbound): Promise<void> {
    check(
      await this.db.from("wa_messages").insert({
        ...msg,
        body: msg.body.slice(0, 4096),
        direction: "out",
        processed_at: new Date().toISOString(),
      }),
    );
  }

  async updateMessageStatus(wamid: string, status: string): Promise<void> {
    check(await this.db.from("wa_messages").update({ status }).eq("wamid", wamid));
  }

  async touchConversation(id: string, windowExpiresAt: string): Promise<void> {
    check(
      await this.db.from("wa_conversations").update({
        window_expires_at: windowExpiresAt,
        last_activity_at: new Date().toISOString(),
      }).eq("id", id),
    );
  }

  async claimConversation(id: string, seconds: number): Promise<boolean> {
    const now = new Date();
    const until = new Date(now.getTime() + seconds * 1000).toISOString();
    const rows = check(
      await this.db.from("wa_conversations").update({ processing_until: until })
        .eq("id", id)
        .or(`processing_until.is.null,processing_until.lt.${now.toISOString()}`)
        .select("id"),
    ) as { id: string }[];
    return rows.length > 0;
  }

  async releaseConversation(id: string): Promise<void> {
    check(await this.db.from("wa_conversations").update({ processing_until: null }).eq("id", id));
  }

  async unprocessedInbound(conversationId: string): Promise<StoredMessage[]> {
    return check(
      await this.db.from("wa_messages").select(MESSAGE_COLS)
        .eq("conversation_id", conversationId).eq("direction", "in").is("processed_at", null)
        .order("created_at"),
    ) as StoredMessage[];
  }

  async markProcessed(ids: string[]): Promise<void> {
    if (!ids.length) return;
    check(
      await this.db.from("wa_messages").update({ processed_at: new Date().toISOString() }).in("id", ids),
    );
  }

  async markAllProcessed(conversationId: string): Promise<void> {
    check(
      await this.db.from("wa_messages").update({ processed_at: new Date().toISOString() })
        .eq("conversation_id", conversationId).eq("direction", "in").is("processed_at", null),
    );
  }

  async history(conversationId: string, limit: number): Promise<StoredMessage[]> {
    const rows = check(
      await this.db.from("wa_messages").select(MESSAGE_COLS)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false }).limit(limit),
    ) as StoredMessage[];
    return rows.reverse();
  }

  async redactConversation(conversationId: string): Promise<void> {
    check(
      await this.db.from("wa_messages").update({ body: null, in_history: false })
        .eq("conversation_id", conversationId).eq("direction", "in"),
    );
  }

  async countInboundSince(conversationId: string, sinceIso: string): Promise<number> {
    const res = await this.db.from("wa_messages").select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId).eq("direction", "in").gte("created_at", sinceIso);
    check(res);
    return res.count ?? 0;
  }

  async tokensSince(conversationId: string, sinceIso: string): Promise<number> {
    const rows = check(
      await this.db.from("wa_messages").select("input_tokens, output_tokens")
        .eq("conversation_id", conversationId).eq("author", "bot").gte("created_at", sinceIso),
    ) as { input_tokens: number | null; output_tokens: number | null }[];
    return rows.reduce((sum, r) => sum + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
  }

  async logConsent(phone: string, granted: boolean, legalVersion: string): Promise<void> {
    check(
      await this.db.from("consent_log").insert({
        form: "whatsapp",
        phone: `+${phone}`,
        consents: { datos: granted },
        legal_version: legalVersion,
        lang: "es",
        page: "whatsapp",
      }),
    );
  }

  async saveLead(contact: Contact, lead: LeadData): Promise<number> {
    const row = {
      name: lead.name,
      business_name: lead.business_name,
      service: lead.service,
      message: lead.message,
      phone: lead.phone,
      source: "whatsapp",
      how_found: "WhatsApp",
      ...(lead.email ? { email: lead.email } : {}),
    };
    if (contact.lead_id) {
      check(await this.db.from("contact_leads").update(row).eq("id", contact.lead_id));
      return contact.lead_id;
    }
    const created = check(
      await this.db.from("contact_leads").insert(row).select("id").single(),
    ) as { id: number };
    await this.updateContact(contact.id, { lead_id: created.id });
    return created.id;
  }

  async listServices(): Promise<Service[]> {
    return check(
      await this.db.from("site_services")
        .select("title, description, tag, title_en, description_en, tag_en").order("sort_order"),
    ) as Service[];
  }

  async getKnowledge(): Promise<Knowledge> {
    const row = check(
      await this.db.from("site_settings").select("setting_value")
        .eq("setting_key", "wa_agent_knowledge").maybeSingle(),
    ) as { setting_value: Knowledge } | null;
    return row?.setting_value ?? {};
  }

  async handoff(conversationId: string, reason: string, summary: string): Promise<void> {
    check(
      await this.db.from("wa_conversations").update({
        status: "human",
        handoff_reason: reason,
        handoff_summary: summary,
        handoff_at: new Date().toISOString(),
      }).eq("id", conversationId),
    );
  }
}
