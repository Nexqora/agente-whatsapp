import type { Button, InboundMessage, WhatsAppSender } from "./types.ts";

const encoder = new TextEncoder();

/** Valida la cabecera X-Hub-Signature-256 que Meta firma con el App Secret. */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=") || !appSecret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const received = header.slice("sha256=".length).toLowerCase();
  if (received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: { wamid: string; status: string }[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? v as Json : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Extrae mensajes y estados del payload de Meta. Ignora lo que llega a otro número. */
export function parseWebhook(payload: unknown, phoneNumberId: string): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], statuses: [] };
  for (const entry of arr(obj(payload).entry)) {
    for (const change of arr(obj(entry).changes)) {
      const value = obj(obj(change).value);
      if (str(obj(value.metadata).phone_number_id) !== phoneNumberId) continue;

      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        const id = str(obj(c).wa_id);
        const name = str(obj(obj(c).profile).name);
        if (id && name) names.set(id, name);
      }

      for (const m of arr(value.messages)) {
        const msg = obj(m);
        const wamid = str(msg.id);
        const from = str(msg.from);
        const type = str(msg.type) ?? "unknown";
        if (!wamid || !from) continue;

        let kind = type;
        let text: string | null = null;
        let buttonId: string | null = null;
        if (type === "text") {
          text = str(obj(msg.text).body);
        } else if (type === "interactive") {
          const reply = obj(obj(msg.interactive).button_reply);
          kind = "button";
          text = str(reply.title);
          buttonId = str(reply.id);
        } else if (type === "button") {
          kind = "button";
          text = str(obj(msg.button).text);
          buttonId = str(obj(msg.button).payload);
        }
        out.messages.push({
          wamid,
          from,
          profileName: names.get(from) ?? null,
          kind,
          text: text?.slice(0, 4000) ?? null,
          buttonId,
        });
      }

      for (const s of arr(value.statuses)) {
        const wamid = str(obj(s).id);
        const status = str(obj(s).status);
        if (wamid && status) out.statuses.push({ wamid, status });
      }
    }
  }
  return out;
}

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
}

/** Cliente mínimo de la WhatsApp Cloud API (Graph API). */
export class WhatsAppClient implements WhatsAppSender {
  constructor(private cfg: WhatsAppConfig, private fetchFn: typeof fetch = fetch) {}

  private async post(payload: Json): Promise<string | null> {
    const url = `https://graph.facebook.com/${this.cfg.graphVersion}/${this.cfg.phoneNumberId}/messages`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    const data = obj(await res.json().catch(() => ({})));
    if (!res.ok) {
      throw new Error(`Graph API ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 500)}`);
    }
    return str(obj(arr(data.messages)[0]).id);
  }

  sendText(to: string, body: string) {
    return this.post({ to, type: "text", text: { body: body.slice(0, 4096), preview_url: true } });
  }

  sendButtons(to: string, body: string, buttons: Button[]) {
    return this.post({
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  sendTemplate(to: string, name: string, lang: string, params: string[]) {
    return this.post({
      to,
      type: "template",
      template: {
        name,
        language: { code: lang },
        components: params.length
          ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
          : [],
      },
    });
  }

  /** Marca como leído y muestra «escribiendo…». Si falla no pasa nada. */
  async markRead(wamid: string): Promise<void> {
    try {
      await this.post({ status: "read", message_id: wamid, typing_indicator: { type: "text" } });
    } catch (err) {
      console.warn("markRead falló", err instanceof Error ? err.message : err);
    }
  }
}
