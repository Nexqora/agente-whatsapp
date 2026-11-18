// Herramientas que Claude puede usar. Ninguna borra datos ni lee otros contactos.
import type { Anthropic } from "./deps.ts";
import type { Contact, Conversation, Knowledge, Store } from "./types.ts";

export interface ToolContext {
  store: Store;
  contact: Contact;
  conversation: Conversation;
  knowledge: Knowledge;
  handOff: (reason: string, summary: string) => Promise<void>;
  state: { handedOff: boolean };
}

const nullableString = (description: string) => ({ type: ["string", "null"], description });

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "listar_soluciones",
    description:
      "Devuelve las soluciones que ofrece Nexqora (título, etiqueta y descripción), tal como están publicadas en la página. Úsala antes de describir o recomendar soluciones.",
    input_schema: {
      type: "object",
      properties: {
        idioma: { type: "string", enum: ["es", "en"], description: "Idioma en que conversa el cliente." },
      },
      required: ["idioma"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "info_nexqora",
    description:
      "Información oficial de Nexqora: planes (Esencial, Completo, Integral), proceso de trabajo, modelo comercial, política de precios y horario de atención humana. Úsala en vez de suponer.",
    input_schema: {
      type: "object",
      properties: {
        tema: {
          type: "string",
          enum: ["planes", "proceso", "modelo_comercial", "precios", "horario_humano", "todo"],
        },
      },
      required: ["tema"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "guardar_prospecto",
    description:
      "Guarda o actualiza la ficha del cliente para que el equipo lo contacte. Llámala en cuanto sepas qué necesita su negocio, y otra vez si aprendes datos nuevos (nombre, negocio, correo). Usa null para lo que no sepas; no inventes datos.",
    input_schema: {
      type: "object",
      properties: {
        nombre: nullableString("Nombre de la persona, si lo dijo."),
        negocio: nullableString("Nombre del negocio, si lo dijo."),
        sector: nullableString("Tipo de negocio: repostería, consultorio, restaurante, etc."),
        necesidad: {
          type: "string",
          description: "Qué quiere que haga la aplicación, en una o dos frases.",
        },
        tiene_sistema_actual: nullableString("Si ya tiene página, tienda o sistema, y cuál."),
        urgencia: nullableString("Para cuándo lo necesita."),
        solucion_interes: nullableString("La solución o el plan que más le encaja, si ya se habló."),
        correo: nullableString("Correo electrónico, solo si el cliente lo escribió."),
      },
      required: [
        "nombre",
        "negocio",
        "sector",
        "necesidad",
        "tiene_sistema_actual",
        "urgencia",
        "solucion_interes",
        "correo",
      ],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "agendar_diagnostico",
    description:
      "Devuelve el enlace para que el cliente agende la llamada de diagnóstico. Úsala cuando el cliente quiera avanzar.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "pasar_a_humano",
    description:
      "Pasa la conversación al equipo de Nexqora. Úsala si el cliente lo pide, si pide un precio concreto o negociar, si hay una queja o molestia, si pregunta algo que no puedes responder con las otras herramientas, o si la conversación no avanza. Después de usarla, despídete; el asistente deja de responder.",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          enum: ["pidio_humano", "precio", "queja", "fuera_de_alcance", "sin_avance", "listo_para_propuesta"],
        },
        resumen: {
          type: "string",
          description: "Resumen para el equipo en 2 a 4 frases: quién es, qué necesita y qué falta.",
        },
      },
      required: ["motivo", "resumen"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const EMAIL_RE = /^[^\s@?&#,]+@[^\s@?&#,]+\.[a-z]{2,}$/i;

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

type Input = Record<string, unknown>;

export async function executeTool(name: string, input: Input, ctx: ToolContext): Promise<string> {
  switch (name) {
    case "listar_soluciones": {
      const en = input.idioma === "en";
      const services = await ctx.store.listServices();
      return JSON.stringify(
        services.map((s) => ({
          titulo: (en && s.title_en) || s.title,
          etiqueta: (en && s.tag_en) || s.tag,
          descripcion: (en && s.description_en) || s.description,
        })),
      );
    }

    case "info_nexqora": {
      const tema = String(input.tema);
      const k = ctx.knowledge;
      if (tema === "todo") {
        const { agenda_url: _a, formulario_url: _f, privacidad_url: _p, ...rest } = k;
        return JSON.stringify(rest);
      }
      return JSON.stringify({ [tema]: k[tema] ?? "Sin información; ofrece pasar con el equipo." });
    }

    case "guardar_prospecto": {
      const name = clean(input.nombre, 100);
      const email = clean(input.correo, 254);
      const service = clean(input.solucion_interes, 100);
      const lines = [
        ["Sector", clean(input.sector, 120)],
        ["Necesidad", clean(input.necesidad, 600)],
        ["Sistema actual", clean(input.tiene_sistema_actual, 300)],
        ["Urgencia", clean(input.urgencia, 120)],
        ["Solución de interés", service],
      ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
      lines.push("Origen: WhatsApp");

      const leadId = await ctx.store.saveLead(ctx.contact, {
        name: name && name.length >= 2 ? name : null,
        business_name: clean(input.negocio, 150) ?? "",
        service: service && service.length >= 2 ? service : null,
        message: lines.join("\n").slice(0, 2000),
        email: email && EMAIL_RE.test(email) ? email : null,
        phone: `+${ctx.contact.phone}`,
      });
      ctx.contact.lead_id = leadId;
      const warn = email && !EMAIL_RE.test(email) ? " El correo no parece válido; pídelo de nuevo." : "";
      return JSON.stringify({ ok: true, mensaje: `Ficha guardada.${warn}` });
    }

    case "agendar_diagnostico": {
      const url = ctx.knowledge.agenda_url;
      return JSON.stringify(
        url
          ? { disponible: true, enlace: url }
          : {
            disponible: false,
            instruccion:
              "No hay agenda en línea. Ofrece que el equipo lo contacte para coordinar y, si acepta, usa pasar_a_humano con motivo listo_para_propuesta.",
          },
      );
    }

    case "pasar_a_humano": {
      await ctx.handOff(String(input.motivo), clean(input.resumen, 1000) ?? "");
      ctx.state.handedOff = true;
      return JSON.stringify({
        ok: true,
        instruccion: `Despídete en una o dos frases y dile que el equipo responde en horario hábil (${
          ctx.knowledge.horario_humano ?? "lunes a viernes de 7:00 a 19:00 y sábados de 8:00 a 15:00"
        }). No hagas más preguntas.`,
      });
    }

    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}
