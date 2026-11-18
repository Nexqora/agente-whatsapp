# Plan · Agente de WhatsApp para Nexqora

Fecha: 18 nov 2026 · Estado: borrador para decidir

## 1. Objetivo

Un asistente en el WhatsApp de Nexqora que atiende a quien escribe, entiende qué necesita su negocio, explica las soluciones y planes, deja el contacto registrado en el Admin y pasa la conversación a una persona cuando hace falta.

**Hipótesis de alcance:** primero es el canal de ventas de Nexqora. Se construye multi-negocio desde el inicio para venderlo después como módulo a clientes (encaja con «Clientes y fidelización» y «Catálogo con pedido por WhatsApp»).

Qué **sí** hace (MVP):
- Responder preguntas frecuentes: qué es una aplicación web a medida, soluciones, planes, proceso en 3 pasos (Diagnóstico, Propuesta, Implementación y entrega), tiempos.
- Calificar al prospecto: sector, qué quiere que haga su cliente (pedir, reservar, contactar), urgencia, presupuesto aproximado si lo comparte.
- Crear o actualizar el contacto en `contact_leads` con origen `whatsapp`.
- Proponer agendar el diagnóstico (enlace de agenda).
- Pasar a humano: por petición, por enojo o por un tema que no domina.

Qué **no** hace:
- No da precios (mientras se evalúen internamente), no negocia ni promete fechas.
- No habla de «piloto» ni de pruebas.
- No conversa de temas ajenos a Nexqora. Desde enero de 2026 Meta prohíbe en la API de WhatsApp los chatbots de IA de propósito general; un asistente acotado al negocio sí está permitido. Esto obliga a mantenerlo enfocado.

## 2. Arquitectura

```
Cliente WhatsApp
   │
   ▼
Meta WhatsApp Cloud API ──webhook──► Edge Function `wa-webhook` (Supabase)
                                        │  1. valida firma X-Hub-Signature-256
                                        │  2. guarda en wa_messages (idempotente por wamid)
                                        │  3. responde 200 en < 1 s
                                        ▼
                                  Cola (pgmq o tabla wa_jobs)
                                        │
                                        ▼
                               Edge Function `wa-agent`
                                  │  carga historial + ficha del contacto
                                  │  ¿conversación tomada por humano? → no responde
                                  │  llama a Claude con herramientas
                                  │  envía la respuesta por Graph API
                                  ▼
                          Supabase (contactos, leads, consentimientos)
                                  ▲
                                  │
                         Admin Nexqora · pestaña «WhatsApp»
                         (bandeja, tomar conversación, responder)
```

Decisiones:
- **Canal:** WhatsApp Cloud API de Meta directo, sin intermediario (Twilio, 360dialog). Menos costo y sin dependencia extra. Contra: la verificación del negocio en Meta la hace Nexqora.
- **Backend:** Supabase Edge Functions, que ya están en el stack. Sin servidor nuevo.
- **Modelo:** Claude Sonnet 5.5 para la conversación; Claude Haiku 5.5 para tareas baratas (clasificar intención, resumir la conversación al pasarla a humano). Respuesta de un solo turno, sin streaming (WhatsApp no lo muestra).
- **Asincronía:** el webhook solo guarda y encola. Meta reintenta si no recibe 200 rápido, y eso genera respuestas duplicadas.

## 3. Herramientas del agente

| Herramienta | Qué hace | Lee / escribe |
|---|---|---|
| `listar_soluciones` | Soluciones y en qué plan viene cada una | `site_services`, `site_content` |
| `info_planes` | Esencial / Completo / Integral, sin precios | `site_content` |
| `guardar_prospecto` | Crea o actualiza el contacto con lo calificado | `contact_leads` |
| ~~`registrar_consentimiento`~~ | En la fase 1 pasó a ser una regla fija con botones, sin modelo (ver `agente-whatsapp-fase1.md`) | `consent_log` |
| `agendar_diagnostico` | Devuelve el enlace de agenda (Cal.com o Google Calendar) | — |
| `pasar_a_humano` | Marca la conversación, resume y avisa a la dueña | `wa_conversations` |

Los textos de soluciones y planes salen de las mismas tablas que la landing: si se edita algo en el Admin, el agente lo dice igual. No hay una segunda fuente de verdad.

## 4. Datos (Supabase)

Tablas nuevas (SQL idempotente, RLS: solo admins leen; la Edge Function escribe con la service role):

- `wa_contacts` (id, telefono_e164 único, nombre, idioma, opt_out, creado)
- `wa_conversations` (id, contact_id, estado: `bot` | `humano` | `cerrada`, lead_id, ultima_actividad, ventana_24h_hasta, resumen)
- `wa_messages` (id, conversation_id, wamid único, direccion `in` | `out`, autor `cliente` | `bot` | `humano`, tipo, texto, media_url, estado de entrega, creado)
- `wa_jobs` o cola pgmq para procesar mensajes entrantes

Cambios: `contact_leads.source` con valor `whatsapp`; `consent_log.form` acepta `whatsapp`.

## 5. Conversación

**Primer mensaje** (dentro de la ventana de 24 h que abre el cliente):
> Hola, soy el asistente de Nexqora. Te ayudo a ver qué aplicación web le sirve a tu negocio. Para atenderte guardamos tu número y lo que nos cuentes según nuestra política: nexqora.com/privacidad. ¿Continuamos?

- Si acepta: se registra en `consent_log`. Si no: se ofrece el formulario web y no se guarda nada más que el opt-out.
- «BAJA» o «STOP» en cualquier momento → `opt_out = true` y no se envían más plantillas.

**Calificación** en 3–4 preguntas como máximo, una a la vez: tipo de negocio → qué quiere que haga su cliente → si ya tiene página o sistema → cuándo lo necesita. Después: resumen + propuesta de diagnóstico.

**Pasar a humano** cuando: lo pide, pregunta precio concreto, hay queja, envía audio o documento que el bot no procesa, o hay tres turnos sin avance. El bot avisa: «Te paso con el equipo, te responden en horario hábil (L–V 7–19 h, sáb 8–15 h)».

**Fuera de la ventana de 24 h** solo se escribe con plantillas aprobadas por Meta:
- `seguimiento_diagnostico` (utilidad): recordatorio de la cita.
- `retomar_conversacion` (marketing): una sola vez, a los 3 días, solo si dio consentimiento.

## 6. Admin · pestaña «WhatsApp»

- Bandeja con conversaciones ordenadas por actividad, filtro por estado.
- Vista de chat con el resumen del bot arriba.
- Botón «Tomar conversación» (pausa al bot) y «Devolver al bot».
- Responder desde el Admin (solo dentro de la ventana de 24 h; fuera, elegir plantilla).
- Aviso a la dueña cuando hay un traspaso: plantilla de WhatsApp a su número personal o correo.

## 7. Seguridad y costos

- Validar la firma de Meta en cada webhook; rechazar lo demás.
- Secretos (token de Meta, clave de Anthropic) en Supabase Secrets, nunca en el cliente.
- Límite por número: 30 mensajes/hora y tope diario de tokens por conversación. Si se supera → pasa a humano.
- Inyección de instrucciones: el agente solo tiene las herramientas de la tabla; ninguna borra datos ni lee otros contactos. El texto del cliente nunca cambia las reglas del sistema.
- Datos mínimos: no pedir cédula ni datos que no hagan falta. Retención 12 meses, igual que la política actual.
- **Costos (hipótesis, verificar tarifas vigentes para Colombia):** las conversaciones que abre el cliente no cobran por mensaje de servicio; se cobran las plantillas de marketing y utilidad fuera de ventana. El modelo cuesta del orden de centavos de dólar por conversación. Poner tope mensual en la consola de Anthropic.

## 8. Calidad y medición

- 30–40 conversaciones de prueba escritas a mano (pyme que quiere pedidos, consultorio que quiere citas, alguien que solo pide precio, alguien grosero, alguien que intenta sacar al bot del tema). Se corren en cada cambio del prompt.
- Pruebas Vitest de las herramientas y del webhook con el Supabase falso que ya existe.
- Métricas en PostHog: conversaciones iniciadas, % con consentimiento, % calificadas, diagnósticos agendados, % pasadas a humano, tiempo de primera respuesta, costo por conversación.

## 9. Fases

| Fase | Contenido | Duración estimada |
|---|---|---|
| 0 · Meta | Cuenta Business verificada, número dedicado, app en Meta for Developers, plantillas enviadas a aprobación | 1–2 semanas (depende de Meta) |
| 1 · MVP | Webhook, cola, agente con FAQ + calificación + `guardar_prospecto`, consentimiento, traspaso por aviso | 1–2 semanas |
| 2 · Bandeja | Pestaña WhatsApp en el Admin, tomar y devolver conversación, responder | 1 semana |
| 3 · Seguimiento | Agenda de diagnóstico, plantillas de recordatorio, métricas en PostHog | 1 semana |
| 4 · Producto | Multi-negocio (`tenant_id`), catálogo y pedidos por WhatsApp para clientes, plan comercial | por definir |

## 10. Decisiones pendientes (de la dueña)

1. ¿Número nuevo dedicado o migrar el actual? El que use la API deja de funcionar en la app normal, salvo con la opción de coexistencia de WhatsApp Business. Hay que confirmar que esté disponible para la cuenta.
2. ¿El bot puede dar rangos de precio o siempre pasa a humano?
3. ¿Solo español o también inglés (como la landing)?
4. ¿Quién recibe los traspasos y por qué canal?
5. ¿Herramienta de agenda: Cal.com, Google Calendar u otra?
6. ¿Se vende a clientes (fase 4) y en qué plan entra?
