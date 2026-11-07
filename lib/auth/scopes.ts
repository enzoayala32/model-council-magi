/**
 * Fase 4b - tabla central de scopes por ruta.
 *
 * REGLA de la fase: ninguna ruta bajo /api/ puede quedar sin scope
 * declarado. Esta tabla es la unica fuente de verdad, y
 * `lib/test-route-scopes.ts` la compara contra el arbol real de
 * `app/api` (todos los `route.ts` del arbol): si se agrega una ruta y no
 * falla. Asi no se puede colar un endpoint sin pensar su nivel de acceso.
 *
 * Jerarquia (de mas alcance a menos): approve > operate > observe.
 * Un dispositivo con scope mayor puede hacer lo que hace uno menor.
 *
 * `public` = la ruta se autentica sola (login y canje de emparejamiento:
 * si exigieran credencial, no se podrian usar para conseguirla).
 *
 * `stepUp` = ademas del scope, exige el segundo factor reciente (Fase 4c)
 * cuando la pide un dispositivo REMOTO. Desde loopback no hace falta: es
 * la PC del operador.
 */

export type DeviceScope = "observe" | "operate" | "approve";
export type RouteScope = DeviceScope | "public";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const SCOPE_LEVELS: Record<DeviceScope, number> = {
  observe: 1,
  operate: 2,
  approve: 3,
};

/** ¿El scope concedido alcanza para el requerido? */
export function scopeSatisfies(granted: DeviceScope, required: DeviceScope): boolean {
  return SCOPE_LEVELS[granted] >= SCOPE_LEVELS[required];
}

export type RouteRule = {
  /** Patrón con `:param`, ej. `/api/agent/tasks/:id`. */
  pattern: string;
  method: HttpMethod;
  scope: RouteScope;
  /** Exige step-up (segundo factor) desde un dispositivo remoto. */
  stepUp?: boolean;
  /** Por qué este nivel. Es para que un revisor no tenga que adivinarlo. */
  note: string;
};

/** Hosts que significan "esta misma maquina": acceso local sin scope. */
export const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "::1"] as const;

export function hostnameOf(hostHeader: string | null): string {
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const firstColon = host.indexOf(":");
  if (firstColon === -1) return host;
  return host.slice(0, firstColon);
}

export function isLoopbackHost(hostHeader: string | null): boolean {
  return (LOOPBACK_HOSTNAMES as readonly string[]).includes(hostnameOf(hostHeader));
}

/**
 * La tabla. Una entrada por (ruta, metodo).
 *
 * Criterio aplicado, para que sea reproducible:
 * - `observe` = no cambia nada en el disco del proyecto ni en el estado de
 *   las corridas, y no gasta cuota de proveedor.
 * - `operate` = crea/cancela/reanuda trabajo, o toca datos de la app
 *   (hilos, proyectos), o lanza llamadas a proveedores que cuestan cuota.
 * - `approve` = aplica o descarta cambios sobre el proyecto real.
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  // ---------- Coding Agent: lectura ----------
  { pattern: "/api/agent/browse", method: "GET", scope: "observe", note: "Lista el arbol de un proyecto. Solo lectura." },
  { pattern: "/api/agent/inspect", method: "GET", scope: "observe", note: "Inspecciona simbolos/estructura. Solo lectura." },
  { pattern: "/api/agent/models", method: "GET", scope: "observe", note: "Catalogo de modelos habilitados." },
  { pattern: "/api/agent/tasks", method: "GET", scope: "observe", note: "Lista de tareas." },
  { pattern: "/api/agent/tasks/:id", method: "GET", scope: "observe", note: "Detalle de una tarea." },
  { pattern: "/api/agent/tasks/:id/events", method: "GET", scope: "observe", note: "SSE de eventos. Es la pantalla de detalle del telefono." },
  { pattern: "/api/agent/tasks/:id/proposals", method: "GET", scope: "observe", note: "Ver diffs propuestos. Ver no es aprobar." },

  // ---------- Coding Agent: trabajo ----------
  { pattern: "/api/agent/tasks", method: "POST", scope: "operate", note: "Crea una tarea: encola trabajo que corre en la PC." },
  { pattern: "/api/agent/tasks/:id/cancel", method: "POST", scope: "operate", note: "Detiene una corrida. No toca el proyecto." },
  { pattern: "/api/agent/tasks/:id", method: "DELETE", scope: "operate", note: "Borra el registro de una tarea." },

  // ---------- Coding Agent: cambios sobre el proyecto ----------
  { pattern: "/api/agent/tasks/:id/apply", method: "POST", scope: "approve", stepUp: true, note: "APLICA cambios al repo. Es la accion mas peligrosa de la API." },
  { pattern: "/api/agent/tasks/:id/discard", method: "POST", scope: "approve", stepUp: true, note: "Descarta propuestas: modifica el estado del workspace." },

  // ---------- Proyectos ----------
  { pattern: "/api/agent/projects", method: "GET", scope: "observe", note: "Lista proyectos registrados." },
  { pattern: "/api/agent/projects", method: "POST", scope: "operate", note: "Registra un proyecto local." },
  { pattern: "/api/agent/projects/:id", method: "DELETE", scope: "operate", note: "Borra un proyecto del registro." },

  // ---------- Consejo ----------
  { pattern: "/api/council/runs", method: "GET", scope: "observe", note: "Lista corridas persistidas." },
  { pattern: "/api/council/runs/:id", method: "GET", scope: "observe", note: "Detalle de una corrida." },
  { pattern: "/api/council/runs/:id/export", method: "GET", scope: "observe", note: "Export Markdown/JSON. Solo lectura." },
  { pattern: "/api/council/runs/compare", method: "GET", scope: "observe", note: "Compara dos corridas." },
  { pattern: "/api/council/runs/:id", method: "DELETE", scope: "operate", note: "Borra una traza. No toca el proyecto ni los hilos." },
  { pattern: "/api/council/model-health", method: "GET", scope: "observe", note: "Salud de modelos." },
  { pattern: "/api/council/ping", method: "POST", scope: "operate", note: "Dispara llamadas reales a proveedores: gasta cuota." },
  { pattern: "/api/council/stream", method: "POST", scope: "operate", note: "Corrida completa del consejo: muchas llamadas, cuota real." },
  { pattern: "/api/council/apply-file-change", method: "POST", scope: "approve", stepUp: true, note: "Aplica propuestas del consejo sobre archivos del proyecto." },

  // ---------- Catalogo de modelos ----------
  { pattern: "/api/models/catalog", method: "GET", scope: "observe", note: "Listado publico de modelos de los proveedores." },

  // ---------- Hilos ----------
  { pattern: "/api/threads", method: "GET", scope: "observe", note: "Historial de conversaciones." },
  { pattern: "/api/threads", method: "POST", scope: "operate", note: "Guarda/actualiza un hilo." },
  { pattern: "/api/threads/:id", method: "GET", scope: "observe", note: "Un hilo." },
  { pattern: "/api/threads/:id", method: "DELETE", scope: "operate", note: "Borra un hilo." },
  { pattern: "/api/threads/:id/favorite", method: "PATCH", scope: "operate", note: "Marca favorito." },
  { pattern: "/api/threads/migrate", method: "POST", scope: "operate", note: "Migra localStorage al server." },

  // ---------- Resiliencia ----------
  { pattern: "/api/provider-resilience/status", method: "GET", scope: "operate", note: "Metadata de credenciales (nunca valores): sirve para saber que key esta en cooldown." },

  // ---------- Autenticacion (se autentican solas) ----------
  { pattern: "/api/auth/token", method: "POST", scope: "public", note: "Login del token de la app. Exigirle credencial seria circular." },
  { pattern: "/api/auth/token", method: "DELETE", scope: "public", note: "Logout local: borra la cookie." },
  { pattern: "/api/pairing", method: "POST", scope: "public", note: "Genera un codigo. Ademas se restringe a loopback dentro de la ruta." },
  { pattern: "/api/pairing/redeem", method: "POST", scope: "public", note: "Canje de codigo. Se autentica con el codigo + rate limiting." },
  { pattern: "/api/auth/step-up", method: "POST", scope: "public", note: "Canje de TOTP por sesion de step-up. Se autentica con el dispositivo + codigo + rate limiting." },
  { pattern: "/api/auth/totp/enroll", method: "POST", scope: "approve", stepUp: true, note: "Inscribe el segundo factor de un dispositivo. Ademas se restringe a loopback dentro de la ruta: anotar un secreto TOTP es tarea de la PC." },

  // ---------- Notificaciones push (Fase 6) ----------
  // La clave pública VAPID no es un secreto (la ve cualquier servicio de push),
  // pero igual se pide credencial: el navegador del operador o el dispositivo
  // emparejado ya la tienen, y así no se filtra qué servidor está configurado.
  { pattern: "/api/push/key", method: "GET", scope: "observe", note: "Clave pública VAPID para suscribirse." },
  // Suscribirse es de observe: cualquier dispositivo que ya entró puede pedir
  // notificaciones. Lo que se le notifica depende de sus preferencias.
  { pattern: "/api/push/subscribe", method: "POST", scope: "observe", note: "Da de alta o actualiza la suscripción del navegador/dispositivo actual." },
  { pattern: "/api/push/subscriptions", method: "GET", scope: "observe", note: "Lista las suscripciones propias." },
  { pattern: "/api/push/subscriptions", method: "PATCH", scope: "observe", note: "Cambia preferencias o pausa una suscripción propia." },
  { pattern: "/api/push/unsubscribe", method: "POST", scope: "observe", note: "Borra una suscripción propia por endpoint." },
  // Enviar una prueba opera sobre el sistema de notificaciones: no es observe.
  { pattern: "/api/push/test", method: "POST", scope: "operate", note: "Envía una notificación de prueba a las suscripciones propias." },

  // ---------- Gestion de dispositivos y auditoria (Fase 4d) ----------
  // Todas se restringen ADICIONALMENTE a loopback dentro de la ruta: ver o
  // cambiar que dispositivos tienen acceso es informacion de la PC. El scope
  // de la tabla cubre el caso (teorico) de que esa restricion se relaje.
  { pattern: "/api/devices", method: "GET", scope: "operate", note: "Lista dispositivos emparejados. Solo loopback." },
  { pattern: "/api/devices/:id", method: "PATCH", scope: "approve", stepUp: true, note: "Renombra o cambia el scope de un dispositivo. Solo loopback." },
  { pattern: "/api/devices/:id", method: "DELETE", scope: "approve", stepUp: true, note: "Revoca un dispositivo. Solo loopback." },
  { pattern: "/api/devices/revoke-all", method: "POST", scope: "approve", stepUp: true, note: "Revoca todos los dispositivos (kill switch de credenciales). Solo loopback." },
  { pattern: "/api/audit", method: "GET", scope: "operate", note: "Registro de actividad. Solo loopback." },
  { pattern: "/api/audit", method: "POST", scope: "approve", stepUp: true, note: "Poda el registro con la retencion configurada. Solo loopback." },
];

/** Escapa los metacaracteres de regex. Escrito sin una clase de caracteres
 *  literal para no depender de escapes frágiles en el fuente. */
function escapeRegExp(value: string): string {
  const specials = [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"];
  let out = "";
  for (const char of value) {
    if (specials.includes(char)) out += "\\";
    out += char;
  }
  return out;
}

/** Convierte un patrón en regex, con `:param` capturando un segmento. */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "([^/]+)" : escapeRegExp(segment)))
    .join("/");
  return new RegExp("^" + escaped + "$");
}

const COMPILED: Array<{ rule: RouteRule; regex: RegExp; params: number }> = ROUTE_RULES.map((rule) => ({
  rule,
  regex: patternToRegex(rule.pattern),
  // Cuantos segmentos dinamicos tiene: menos = mas especifico.
  params: rule.pattern.split("/").filter((segment) => segment.startsWith(":")).length,
}));

/**
 * Regla que aplica a este metodo y path, o null si no esta clasificada.
 *
 * Si varios patrones matchean, gana el MAS ESPECIFICO (menos parametros):
 * es exactamente lo que hace el router de Next, donde `/runs/compare` le
 * gana a `/runs/:id`. Sin esta preferencia, la regla de `/runs/compare`
 * quedaba inalcanzable y la de `:id` se quedaba con un path que no le
 * corresponde.
 */
export function ruleFor(method: string, pathname: string): RouteRule | null {
  const normalizedMethod = method.trim().toUpperCase();
  let best: { rule: RouteRule; params: number } | null = null;
  for (const candidate of COMPILED) {
    if (candidate.rule.method !== normalizedMethod) continue;
    if (!candidate.regex.test(pathname)) continue;
    if (!best || candidate.params < best.params) best = candidate;
  }
  return best ? best.rule : null;
}

/** Regex de un patron (para los tests de cobertura). */
export function patternRegex(pattern: string): RegExp {
  return patternToRegex(pattern);
}
