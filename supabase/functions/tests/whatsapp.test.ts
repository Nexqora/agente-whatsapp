import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseWebhook, verifySignature } from "../_shared/whatsapp.ts";
import { isNo, isOptOut, isYes } from "../_shared/texts.ts";

async function sign(body: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("verifySignature acepta la firma correcta y rechaza las demás", async () => {
  const body = '{"hola":"mundo"}';
  const good = await sign(body, "secreto");
  assert(await verifySignature(body, good, "secreto"));
  assert(!(await verifySignature(body + " ", good, "secreto")));
  assert(!(await verifySignature(body, await sign(body, "otro"), "secreto")));
  assert(!(await verifySignature(body, null, "secreto")));
  assert(!(await verifySignature(body, "sha1=abc", "secreto")));
  assert(!(await verifySignature(body, good, "")));
});

const payload = (phoneNumberId: string, messages: unknown[], statuses: unknown[] = []) => ({
  object: "whatsapp_business_account",
  entry: [{
    changes: [{
      field: "messages",
      value: {
        metadata: { phone_number_id: phoneNumberId },
        contacts: [{ wa_id: "573001112233", profile: { name: "Laura" } }],
        messages,
        statuses,
      },
    }],
  }],
});

Deno.test("parseWebhook lee texto, botones, archivos y estados", () => {
  const parsed = parseWebhook(
    payload("PN1", [
      { id: "w1", from: "573001112233", type: "text", text: { body: "Hola" } },
      {
        id: "w2",
        from: "573001112233",
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "consent_yes", title: "Sí, continuar" } },
      },
      { id: "w3", from: "573001112233", type: "audio", audio: { id: "media" } },
    ], [{ id: "out-1", status: "delivered" }]),
    "PN1",
  );
  assertEquals(parsed.messages.map((m) => [m.kind, m.text, m.buttonId, m.profileName]), [
    ["text", "Hola", null, "Laura"],
    ["button", "Sí, continuar", "consent_yes", "Laura"],
    ["audio", null, null, "Laura"],
  ]);
  assertEquals(parsed.statuses, [{ wamid: "out-1", status: "delivered" }]);
});

Deno.test("parseWebhook ignora otro número y payloads raros", () => {
  assertEquals(parseWebhook(payload("OTRO", [{ id: "w", from: "1", type: "text" }]), "PN1").messages, []);
  assertEquals(parseWebhook(null, "PN1"), { messages: [], statuses: [] });
  assertEquals(parseWebhook({ entry: "x" }, "PN1"), { messages: [], statuses: [] });
});

Deno.test("detección de sí, no y BAJA", () => {
  for (const s of ["Sí", "si claro", "OK", "dale", "Acepto", "yes"]) assert(isYes(s), s);
  for (const s of ["sin duda no sé", "necesito una tienda", "no"]) assert(!isYes(s), s);
  for (const s of ["No", "no gracias"]) assert(isNo(s), s);
  for (const s of ["BAJA", "stop", " Baja "]) assert(isOptOut(s), s);
  assert(!isOptOut("quiero dar de baja mi tienda vieja"));
});
