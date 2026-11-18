// Traspaso de una conversación al equipo de Nexqora.
import type { Config, Contact, Conversation, Store, WhatsAppSender } from "./types.ts";

export interface HandoffDeps {
  store: Store;
  wa: WhatsAppSender;
  config: Config;
}

/** Marca la conversación como humana (el bot deja de responder) y avisa a la dueña. */
export async function handOff(
  d: HandoffDeps,
  conv: Conversation,
  contact: Contact,
  reason: string,
  summary: string,
): Promise<void> {
  await d.store.handoff(conv.id, reason, summary.slice(0, 1000));
  conv.status = "human";

  const { ownerPhone, handoffTemplate } = d.config;
  if (!ownerPhone || !handoffTemplate) {
    console.info(`Traspaso a humano (${reason}) para ${contact.phone}; sin aviso configurado.`);
    return;
  }
  try {
    // La plantilla debe tener 3 variables: nombre, teléfono y motivo.
    await d.wa.sendTemplate(ownerPhone, handoffTemplate, "es", [
      contact.profile_name ?? "Sin nombre",
      `+${contact.phone}`,
      reason,
    ]);
  } catch (err) {
    console.error("No se pudo avisar a la dueña", err instanceof Error ? err.message : err);
  }
}
