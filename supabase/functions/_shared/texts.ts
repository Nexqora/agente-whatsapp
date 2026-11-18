// Mensajes fijos (no los escribe el modelo). Tono profesional y cercano.
import type { Knowledge } from "./types.ts";

const DEFAULT_HOURS = "lunes a viernes de 7:00 a 19:00 y sábados de 8:00 a 15:00";

export const hours = (k: Knowledge) => k.horario_humano || DEFAULT_HOURS;

export const texts = {
  consentPrompt: (k: Knowledge) =>
    "Hola, soy el asistente de Nexqora. Te ayudo a ver qué aplicación web le sirve a tu negocio.\n\n" +
    "Para atenderte guardamos tu número y lo que nos cuentes, según nuestra política de datos" +
    (k.privacidad_url ? `: ${k.privacidad_url}` : ".") +
    "\n\n¿Continuamos?",
  consentDeclined: (k: Knowledge) =>
    "Entendido, no guardaremos tu información." +
    (k.formulario_url ? ` Si prefieres, puedes escribirnos desde el formulario: ${k.formulario_url}` : ""),
  consentGaveUp: (k: Knowledge) =>
    "Para seguir por aquí necesitamos tu autorización de datos." +
    (k.formulario_url ? ` También puedes escribirnos desde el formulario: ${k.formulario_url}` : ""),
  optOut: "Listo, no te enviaremos más mensajes de seguimiento. Si quieres retomarlos, escribe ALTA.",
  optIn: "Listo, volviste a activar los mensajes de seguimiento.",
  media: (k: Knowledge) =>
    `Por ahora solo puedo leer mensajes de texto. Te paso con el equipo; te responden en horario hábil (${hours(k)}).`,
  limit: (k: Knowledge) =>
    `Te paso con el equipo para seguir la conversación; te responden en horario hábil (${hours(k)}).`,
  error: (k: Knowledge) =>
    `Tuvimos un problema para responderte. Te paso con el equipo; te responden en horario hábil (${hours(k)}).`,
};

export const CONSENT_BUTTONS = [
  { id: "consent_yes", title: "Sí, continuar" },
  { id: "consent_no", title: "No, gracias" },
];

const normalize = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const isYes = (s: string) =>
  /^(si|ok|okay|dale|acepto|autorizo|claro|de acuerdo|continuar|continuemos|listo|vale|yes|sure)\b/
    .test(normalize(s));

export const isNo = (s: string) => /^(no|no gracias|no acepto|no autorizo)\b/.test(normalize(s));

export const isOptOut = (s: string) => /^(baja|stop|parar|cancelar)$/.test(normalize(s));
export const isOptIn = (s: string) => /^(alta|start)$/.test(normalize(s));
