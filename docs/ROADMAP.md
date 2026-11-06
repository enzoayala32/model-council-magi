# Roadmap — Consenso IA / Model Council MAGI

Estado de cada frente. Lo que dice "HECHO" se puede comprobar con el
comando o el archivo indicado; lo que dice "EN CURSO" o "PENDIENTE" todavía no.

Leyenda: **HECHO** · **EN CURSO** · **PENDIENTE** · **NO VERIFICADO** (implementado pero sin poder probarlo en el entorno donde se escribió) · **BACKLOG**

---

## 1. Base (ya existía)

| Frente | Estado | Cómo se comprueba |
|---|---|---|
| Consejo multi-modelo con debate, voto y juez de fusión | **HECHO** | `npm run council:test-consensus` (94/94), `npm run council:test-prompts` (79/79) |
| Personas y presets del debate | **HECHO** | `npm run council:test-persona-presets` (45/45) |
| Adjuntos PDF/DOCX → texto | **HECHO** | `npm run council:test-attachment-extraction` (27/27) |
| Orquestador SSE extraído y testeado con proveedor falso | **HECHO** | `npm run council:test-orchestrator` (54/54) |
| Trazas por corrida (tokens, costo, latencia, fallbacks, reintentos) | **HECHO** | `npm run council:test-runs` (107/107), pestaña **Trazas** |
| Export de corrida en Markdown/JSON + comparación de dos corridas | **HECHO** | `/api/council/runs/[id]/export`, `/api/council/runs/compare` |
| Persistencia SQLite (hilos, tasks, proyectos, workspaces, propuestas, ledger) | **HECHO** | `lib/db.ts`, `data/council.db` |
| Coding Agent (loop legacy + Autonomous Loop opt-in) | **HECHO** | `docs/ARQUITECTURA-AGENTE.md` |
| Resiliencia de proveedores (pool, cooldown, clasificación, redacción) | **HECHO** | `npm run provider-resilience:test-*`, `npm run test:live` para lo que requiere red |
| Seguridad de `/api/*` (Host, Origin, Sec-Fetch-Site, Content-Type, token) | **HECHO** | `npm run security:test-proxy` (62/62) |
| Runner unificado + CI (Node 22) | **HECHO** | `npm test` (71/71), `.github/workflows/ci.yml` |

---

## 2. Misión 2 — correcciones (Fase 1 del Plan de trabajo)

| Ítem | Estado | Detalle |
|---|---|---|
| 1.1 Bug ByteString 8212 (`X-Title` con raya larga) | **HECHO** | `lib/http-headers.ts`, 46/46 casos. `npm run agent:test` pasó de fallar a exit 0. |
| 1.2 Login del token (`POST /api/auth/token`) | **HECHO** | 35/35 casos + smoke HTTP con cookie real. |
| 1.3 Host loopback en cualquier puerto | **HECHO** | 62/62 casos en `security:test-proxy`. |
| 1.4 Sin precios inventados en `model-pricing` | **HECHO** | 107/107 en `council:test-runs`. |
| 1.5 Tests aislados de la DB del usuario | **HECHO** | Hash de `data/council.db` idéntico antes/después de `npm test`. |
| 1.6 Housekeeping (`salidas/` ignorado, tope de warnings en CI) | **HECHO** | `.gitignore`, `--max-warnings 37`. |
| 1.7 Plan de división de dispatcher/ledger | **HECHO** (análisis) | `docs/ARQUITECTURA-AGENTE.md`. |

---

## 3. Misión 2 — control remoto desde el teléfono (Fases 3–6)

Principio de diseño: controlar el agente a distancia equivale a ejecución
remota de código en la PC. Por eso PWA servida por el mismo servidor
(nada de app nativa por ahora), túnel privado y autenticado,
emparejamiento por QR, tokens por dispositivo revocables, permisos por
niveles, auditoría y aprobación explícita para todo lo que modifique el
proyecto.

| Ítem | Estado |
|---|---|
| 3.1 Binding LAN + fail-closed + `print-access-urls` | **HECHO** |
| 3.2 PWA `/m` instalable (manifest, SW solo-shell, pantallas) | **HECHO** |
| 3.3 SSE con heartbeat, backoff y reanudación (cliente) | **HECHO** (falta test de corte/reanudación) |
| 3.4 `docs/API-AGENTE.md` | **HECHO** |
| Instalar en Android real / entrar desde otra máquina | **NO VERIFICADO** (sin dispositivo) |
| Nota: no existe "reanudar" en el servidor; reintentar = crear task nueva | **HECHO** |
| 4a Tablas + canje con rate limiting + cookie de dispositivo + auditoría | **HECHO** |
| 4b Scopes `observe`/`operate`/`approve` + autorización central + test de cobertura de rutas | **HECHO** |
| 4c Step-up TOTP para aprobar desde remoto | **HECHO** (RFC 6238, sin dependencias) |
| 4d UI de Dispositivos y Actividad + kill switch `REMOTE_ACCESS=off` | **PENDIENTE** |
| Nota: hasta 4c, `apply`/`discard` desde remoto quedan bloqueados a propósito | **HECHO** |
| 5 | Acceso remoto documentado (Tailscale recomendado, Cloudflare Tunnel alternativa, port-forward desaconsejado) + `npm run doctor:remote` | **PENDIENTE** |
| 6 | Notificaciones push (Web Push/VAPID) con preferencias por dispositivo y coalescencia | **PENDIENTE** |

Lo que depende de un teléfono real o de un túnel queda **NO VERIFICADO**
hasta que el usuario lo pruebe; cada fase trae su checklist manual.

---

## 4. Misión 2 — integración con MCP (Fases 7–9)

| Fase | Qué es | Estado |
|---|---|---|
| 7 | Cliente MCP de **solo lectura**: config validada fuera del repo, allowlist explícita por herramienta, aislamiento de `process.env` para procesos stdio, salida tratada como contenido no confiable | **PENDIENTE** |
| 8 | Herramientas MCP de escritura **solo con aprobación humana** (+ UI de servidores, solo editable desde loopback) | **PENDIENTE** |
| 9 | El consejo y el agente como **servidor MCP** (`/api/mcp`), clientes emparejados como dispositivos, sin herramientas de aprobación expuestas | **PENDIENTE** |

Reglas no negociables: la config de MCP vive fuera del repo y nunca se
lee del workspace del agente (un repo clonado no puede registrar comandos
que se ejecuten); la salida de herramientas MCP es dato, no instrucción.

---

## 4B. Misión 2 — rotación de NVIDIA y catálogo automático

| Ítem | Estado | Cómo se comprueba |
|---|---|---|
| Rotación de `NVIDIA_API_KEY`/`_2…` en draft/debate/voto del consejo | **HECHO** (ya venía de Fase 5E, verificado de nuevo) | `npm run security:test-nvidia-rotation` |
| Rotación en síntesis, juez de fusión y follow-ups (elegían el pool por nombre fijo) | **HECHO** | idem |
| Rotación en el ping de salud de modelos (antes una sola key: mentía el veredicto) | **HECHO** | idem |
| Rotación en el fallback OpenRouter → NVIDIA directo | **HECHO** | idem |
| El modelo NO cambia al rotar keys | **HECHO** | caso `EL MODELO NO CAMBIÓ al rotar` |
| Catálogo automático de modelos con separación gratis/pago | **HECHO** | `npm run council:test-catalog` (45/45) y `/api/models/catalog` |
| Precio de NVIDIA | **NO DISPONIBLE**: su endpoint no publica `pricing`, se muestra “—” | verificado contra `integrate.api.nvidia.com/v1/models` |

---

## 5. Backlog

| Ítem | Estado | Nota |
|---|---|---|
| App nativa Android (Capacitor o TWA) | **BACKLOG** | La PWA cubre el caso; solo si hace falta acceso offline real o notificaciones nativas más ricas. |
| WebAuthn / passkeys como segundo factor | **BACKLOG** | El step-up usa TOTP por ahora (sin dependencias). Passkeys es mejor UX pero más superficie. |
| Retención automática de la DB (poda de corridas/eventos viejos) | **BACKLOG** | Hoy se borra a mano por API (`DELETE /api/council/runs/[id]`). |
| Dividir `dispatcher.ts` y `ledger.ts` | **BACKLOG** (plan listo) | Orden y módulos en `docs/ARQUITECTURA-AGENTE.md`. |
| Bajar el tope de warnings de ESLint (hoy 37) | **BACKLOG** | 27 `no-unused-vars`, 8 `set-state-in-effect`, 2 `<img>`. |

---

## 6. Cómo leer este archivo

Se actualiza al cerrar cada fase del plan de trabajo. El detalle de qué se
hizo, con commits y salidas reales de typecheck/lint/test/build, está en
[`REPORTE-REFACTOR.md`](./REPORTE-REFACTOR.md). Lo que aquí dice HECHO y
allá no tiene evidencia, es un bug de este documento.
