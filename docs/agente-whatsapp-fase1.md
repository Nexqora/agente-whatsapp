# Agente de WhatsApp · Fase 1: puesta en marcha

Lo que ya está en el código y lo que tienes que hacer tú para activarlo.

## Qué hay en el repositorio

| Archivo | Para qué |
|---|---|
| `supabase/migrations/20261118000000_whatsapp_agent.sql` | Tablas `wa_contacts`, `wa_conversations`, `wa_messages`, ajustes a `contact_leads` y `consent_log`, y el conocimiento del agente en `site_settings` |
| `supabase/functions/whatsapp-webhook/index.ts` | La función que recibe los mensajes de Meta |
| `supabase/functions/_shared/handler.ts` | Reglas fijas: consentimiento, BAJA/ALTA, archivos, conversación tomada por el equipo, límites |
| `supabase/functions/_shared/agent.ts` | Conversación con Claude y uso de herramientas |
| `supabase/functions/_shared/tools.ts` | Herramientas: soluciones, info de Nexqora, guardar prospecto, agenda, pasar a humano |
| `supabase/functions/_shared/prompt.ts` | Instrucciones del asistente |
| `supabase/functions/tests/` | 19 pruebas automáticas (`deno task test`) |

### Cambios frente al plan

- **Una sola función en vez de dos más una cola.** El webhook guarda el mensaje, responde 200 a Meta y Claude trabaja en segundo plano (`EdgeRuntime.waitUntil`). Un bloqueo por conversación evita respuestas dobles, y si llegan varios mensajes seguidos se responden juntos.
- **El consentimiento no lo maneja Claude.** Es una regla fija con dos botones («Sí, continuar» / «No, gracias»), para que nunca dependa del modelo. Si dice que no, se borran los textos que alcanzó a enviar.
- **Los prospectos se guardan en `contact_leads`** con `source = 'whatsapp'` y teléfono, así aparecen en la pestaña Contactos que ya existe.

## Pasos para activarlo

### 1. Revisar y correr el SQL

1. Abre la migración y **revisa el bloque 5** (`wa_agent_knowledge`): los textos de los planes son una propuesta mía. Corrígelos antes de activar, porque el bot los dirá tal cual. Reemplaza también `TU-DOMINIO.com` y, si tienes agenda en línea, pon el enlace en `agenda_url`.
2. Pégala en el editor SQL de Supabase (proyecto *Nexqora's Project*) y córrela. Se puede correr más de una vez.

> **Ojo:** `contact_leads.email` deja de ser obligatorio, porque un prospecto de WhatsApp puede no dar correo. Revisa que `AdminLeads.tsx` y el CSV toleren un correo vacío (`mailtoHref` / `isSafeEmail` con `null`).

### 2. Meta (WhatsApp Cloud API)

1. En [Meta for Developers](https://developers.facebook.com/) crea una app de tipo *Business* y agrégale el producto **WhatsApp**.
2. Verifica el negocio en Meta Business Suite (puede tardar días).
3. Agrega el número que va a usar el bot. Copia el **Phone number ID**.
4. Crea un **usuario del sistema** con permisos `whatsapp_business_messaging` y `whatsapp_business_management`, y genera un **token permanente**. No uses el token temporal de 24 h.
5. En *Configuración de la app → Básica* copia el **App Secret**.
6. Crea la plantilla de aviso para ti (categoría *Utilidad*, idioma español), por ejemplo `aviso_traspaso`:
   > Nueva conversación para atender en WhatsApp. Cliente: {{1}} ({{2}}). Motivo: {{3}}.

   Para que te llegue, escríbele una vez al número del bot desde tu celular personal.

### 3. Secretos en Supabase

En *Project Settings → Edge Functions → Secrets* (o con la CLI):

```bash
supabase secrets set WA_ACCESS_TOKEN=... WA_PHONE_NUMBER_ID=... WA_APP_SECRET=... WA_VERIFY_TOKEN=una-frase-larga-que-tu-inventas ANTHROPIC_API_KEY=... WA_OWNER_PHONE=57300XXXXXXX WA_HANDOFF_TEMPLATE=aviso_traspaso
```

Opcionales (tienen valor por defecto):

| Variable | Por defecto | Qué es |
|---|---|---|
| `WA_MODEL` | `claude-sonnet-5-5` | Modelo de Claude |
| `WA_EFFORT` | `low` | Esfuerzo de razonamiento (`low`, `medium`, `high`) |
| `WA_GRAPH_VERSION` | `v24.0` | Versión de la Graph API. Confírmala en el panel de Meta |
| `WA_LEGAL_VERSION` | `2026-11` | Versión de la política de datos que queda en `consent_log`. Cámbiala junto con `LEGAL_VERSION` de la web |
| `WA_MAX_INBOUND_PER_HOUR` | `30` | Mensajes por hora antes de pasar al equipo |
| `WA_MAX_TOKENS_PER_DAY` | `300000` | Tokens por conversación al día antes de pasar al equipo |
| `WA_DEBOUNCE_MS` | `1500` | Espera para agrupar mensajes seguidos |

### 4. Desplegar

```bash
supabase functions deploy whatsapp-webhook --no-verify-jwt
```

`--no-verify-jwt` es necesario porque Meta no envía un token de Supabase. La seguridad la da la firma `X-Hub-Signature-256`: la función rechaza todo lo que no esté firmado con tu App Secret.

### 5. Conectar el webhook

En Meta → WhatsApp → Configuración:
- **URL de devolución de llamada:** `https://ftmxyxyjufzfblatblqs.supabase.co/functions/v1/whatsapp-webhook`
- **Token de verificación:** el mismo `WA_VERIFY_TOKEN`
- Suscríbete al campo **messages**.

### 6. Probar antes de anunciarlo

1. Escribe desde tu celular: debe llegar la pregunta de datos con dos botones.
2. Recorre los casos de `docs/agente-whatsapp-pruebas.md`.
3. Mira las tablas `wa_messages` y `contact_leads` en Supabase, y los registros de la función (*Edge Functions → whatsapp-webhook → Logs*).
4. Pon un tope de gasto mensual en la consola de Anthropic.

## Cómo tomar una conversación (hasta que exista la bandeja de la fase 2)

**Límite importante de la fase 1:** el bot deja de responder cuando pasa la conversación al equipo, pero todavía no hay pantalla para que tú respondas.
- Si el número usa la **coexistencia** de WhatsApp Business (app y API sobre el mismo número), respondes desde la app del celular. Esas respuestas no quedan en `wa_messages`.
- Sin coexistencia, el número solo funciona por la API: **no lo anuncies al público hasta tener la bandeja de la fase 2.** Úsalo para pruebas internas.

En Supabase, tabla `wa_conversations`:
- `status = 'human'` significa que el bot está detenido en esa conversación.
- Para devolverla al bot: cambia `status` a `bot`.
- Para cerrarla: `status = 'closed'`. El próximo mensaje del cliente abre una conversación nueva.

## Pruebas

```bash
cd supabase/functions
deno task check
deno task test
```

Las pruebas usan dobles en memoria de Supabase, WhatsApp y Claude: no gastan tokens ni envían mensajes.
