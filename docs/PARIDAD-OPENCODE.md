# Paridad con OpenCode — estado y brechas (Etapa 1)

Relevo hecho el **2026-11-10**. No es una impresión: cada fila de "OpenCode"
cita la página de documentación de donde sale, y cada fila de "MAGI" cita el
archivo del código. Lo que no se pudo comprobar queda en la sección 7.

## 1. Fuentes

**Lado OpenCode (v2, rama actual):**

- Documentación: `https://opencode.ai/docs/` y el índice completo
  `https://opencode.ai/docs/llms.txt` (páginas usadas: `tools`, `permissions`,
  `agents`, `commands`, `skills`, `instructions`, `snapshots`, `compaction`,
  `models`, `mcp-servers`).
- Código: repo `anomalyco/opencode`, rama `dev` (vía Context7), para verificar
  que una supuesta ausencia es real y no un hueco de la doc. Ejemplo concreto:
  `packages/core/src/session/to-session-error.ts` — `QuotaExceeded` es
  **no reintentable**, y el límite gratis deriva a suscribirse a OpenCode Go, no
  a reintentar con otra credencial.

**Lado MAGI:** este repo. `lib/agent/tools.ts`, `lib/agent/loop.ts`,
`lib/agent/tool-policy.ts`, `lib/agent/mcp-tools.ts`, `lib/mcp/*`,
`lib/provider-resilience/*`, `lib/skills.ts`, `lib/models.ts`,
`lib/model-health.ts`, `app/components/main/composer.tsx`,
`docs/ARQUITECTURA-AGENTE.md`, `docs/ROADMAP.md`.

## 2. Resumen

| Veredicto | Cantidad | Qué significa |
|---|---:|---|
| **NOSOTROS** | 7 | OpenCode no lo tiene (o no se encontró) y nosotros sí |
| **IGUAL** | 3 (2 `IGUAL` + 1 `IGUAL+`) | Los dos lo tienen, con fuerza comparable |
| **PARCIAL** | 13 | Los dos lo tienen, pero con distancia real de capacidad |
| **DIFERENTE** | 2 | Modelo distinto a propósito: no es "mejor" ni "peor", es otra decisión de diseño |
| **FALTA** | 4 | OpenCode lo tiene y nosotros no (dos filas se movieron a PARCIAL: 2.1 y 2.3) |

29 capacidades relevadas. Las 4 que **FALTAN**, en orden de cuánto duelen:
agentes/subagentes definidos por el usuario, plugins y SDK, modelos locales
(Ollama/LM Studio/vLLM) e integración con el ecosistema de OpenCode (Console,
workspaces con SSO/SCIM) — esta última la marco **fuera de alcance**: es
producto comercial suyo, no capacidad del agente.

## 3. Matriz por área

Veredictos: **NOSOTROS** · **IGUAL** · **PARCIAL** · **FALTA**.

### A. Núcleo del agente

| Capacidad | OpenCode v2 | MAGI | Veredicto | Prioridad |
|---|---|---|---|---|
| Instrucciones del proyecto | `AGENTS.md` anidado por directorio, descubierta al explorar, **recarga en vivo** entre pasos, más array `instructions` con globs y URLs ([instructions](https://opencode.ai/docs/instructions/)) | **HECHA en Etapa 2.1**: `lib/agent/instructions.ts` lee el `AGENTS.md` de la raíz del worktree y lo inyecta enmarcado como dato (`buildSystemPrompt`). Pendiente: descubrimiento anidado y recarga en vivo | **PARCIAL (camino a IGUAL)** | P0 cerrada, P2 el resto |
| Comandos `/` | Markdown o JSONC, `$ARGUMENTS` y `$1..$n`, bloques de shell `` !`cmd` ``, override de agente y modelo, modo background, recarga en caliente ([commands](https://opencode.ai/docs/commands/)) | **HECHA en Etapa 2.3**: `lib/agent/commands.ts` con `.magi/commands/**/*.md` + global, id por ruta, `$ARGUMENTS`/`$1..$n`, override de modelo y expansión en el servidor. Bloques de shell APAGADOS por defecto (decisión nuestra, no de OpenCode). Sin modo background ni recarga en caliente | **PARCIAL (camino a IGUAL)** | P0 cerrada, P2 el resto |
| Compactación de contexto | Automática por defecto (`buffer` 15%, `keep.tokens` 15k), manual por API, compactación nativa del proveedor, y background experimental ([compaction](https://opencode.ai/docs/compaction/)) | Context Engine con medición + briefing, pero el **governor está APAGADO por defecto** (pendiente 0.5, sin aprobación) | **PARCIAL** | **P0** |
| Deshacer / revertir | Snapshots por paso, `/undo` y `/redo`, restore de archivos atribuidos a los pasos del asistente, almacenados en un git interno aparte ([snapshots](https://opencode.ai/docs/snapshots/)) | Modelo distinto: la task corre en un worktree aislado y los cambios salen como **propuesta** con hash de línea base, que el humano aprueba o descarta (`lib/agent/proposal-store.ts`, `lib/agent/apply.ts`) | **PARCIAL** | P1 |
| Edición multi-archivo | `patch` con `*** Add/Update/Delete File` en un solo call | Una tool por archivo (`edit_file`, `write_file`, `delete_file`) | **PARCIAL** | P1 |
| Búsqueda | `glob` (patrón, `path`, `hidden`, `limit`) y `grep` (regex, `include`, `caseSensitive`, `limit`) | `search_files` (texto literal) y `list_files` (nombres, filtro por extensión/fragmento) — no hay patrón glob real ni regex | **PARCIAL** | P2 |
| Shell | `shell` con `workdir`, `timeout`, `background`, y un **escáner** de permisos sobre Bash/Zsh/sh/PowerShell que rechaza sintaxis que no puede analizar | `run_typecheck` y `run_script` acotados a los scripts de `package.json`; no hay shell arbitrario | **DIFERENTE** | P2 |
| Web | `webfetch` (markdown/text/html) + `websearch` con varios integraciones | `web_search` (Tavily) únicamente | **PARCIAL** | P1 |
| Adjuntos e imágenes | Attachments en el composer, `read` pasa PNG/JPEG/GIF/WebP/PDF hasta 20 MiB, `experimental_image_generate` | Adjuntos PDF/DOCX → texto, solo en el Consejo; el agente del loop no recibe adjuntos | **PARCIAL** | P2 |
| Límite de pasos | `steps` por agente (numérico, configurable) | `DEFAULT_MAX_STEPS = 20` + `no_progress` + timeout total (`lib/agent/loop.ts:40`) | **IGUAL** | — |
| Inteligencia del repo | No encontrado | `repo_map`, símbolos, grafo de dependencias, análisis del repo (`lib/agent/tools.ts`, `lib/agent/repo-*.ts`) | **NOSOTROS** | — |

### B. Extensibilidad

| Capacidad | OpenCode v2 | MAGI | Veredicto | Prioridad |
|---|---|---|---|---|
| Agentes/subagentes | `.opencode/agents/*.md` o `agents` en config: `system`, `model`, `permissions`, `steps`, `mode: primary/subagent/all`, ocultos, color, deshabilitables; 4 built-ins (`build`, `plan`, `general`, `explore`) | No existe | **FALTA** | P1 |
| Skills | `SKILL.md` por ruta, descubrimiento anidado y compatible con `.claude`/`.agents`, catálogos HTTP con `index.json`, carga **bajo demanda** por la herramienta `skill`, permiso por ID, `autoinvoke` | Skills curadas en la UI (cajón de ajustes) que se **inyectan completas en el prompt** del Consejo, máximo 12 (`lib/skills.ts`) | **PARCIAL** | P1 |
| MCP — cliente | `local` y `remote`, OAuth con CIMD/DCR/cliente pre-registrado, herramientas agrupadas bajo Code Mode (`codemode`), `list/read_mcp_resource`, prompts como comandos, elicitation, `_meta` con el sessionID, versión de protocolo `legacy/auto/2026-07-28`, conexiones compartidas (`pool`), timeouts por fase | `stdio` + `http` **fail-closed** con allowlist explícita, `readOnlyTools` como única exención de aprobación, **aprobación humana** por herramienta, pin de IP anti-SSRF, protocolo `2024-11-05`; solo herramientas (sin recursos ni prompts) | **PARCIAL** | P1 (OAuth, recursos) · P2 (Code Mode, pool) |
| MCP — servidor | No encontrado (OpenCode no expone su sesión como servidor MCP) | `/api/mcp` con clientes emparejados como dispositivos, scopes, sin herramientas de aprobación expuestas | **NOSOTROS** | — |
| Plugins | Plugins de servidor, TUI y GUI; RPC; SDK JS/Effect; ACP; integración con Cloudflare | No existe | **FALTA** | P2 |
| Temas, keybinds, cliente | TUI, temas, keybinds, app de escritorio, web y CLI con `acp` | PWA instalable `/m` + UI web + API por scopes | **PARCIAL** | P2 |

### C. Permisos y seguridad

| Capacidad | OpenCode v2 | MAGI | Veredicto | Prioridad |
|---|---|---|---|---|
| Reglas de permiso | Lista ordenada `action`/`resource`/`effect` (`allow`/`ask`/`deny`), comodines, "la última regla que matchea gana", aprobaciones guardadas por proyecto, y **políticas** de organización que convierten allow/ask en deny ([permissions](https://opencode.ai/docs/permissions/), [policies](https://opencode.ai/docs/policies/)) | `guardRequest` (Host/Origin/Sec-Fetch-Site/Content-Type/token), scopes `observe/operate/approve` por ruta, step-up TOTP, `confirmToken`, allowlist MCP, `tool-policy` como red de seguridad | **DIFERENTE** | P1 |
| Aislamiento de secretos | `{env:NAME}` en config, secretos fuera del repo | `.env` fuera del repo, redacción en logs (`lib/provider-resilience/redact.ts`), keys por entorno | **IGUAL** | — |
| Sesión remota | `opencode pair` con link de un solo uso (5 min) + app web | Emparejamiento por código, cookie **y** header `x-magi-device-token`, scopes, auditoría, kill switch, push | **NOSOTROS** | — |
| Endurecimiento de tools | Default permisivo (`*:* allow`) salvo `.env`; el escáner de shell es el control | Default restrictivo: allowlist MCP, aprobación humana para escritura, `external_directory` implícito por el worktree aislado | **NOSOTROS** | — |

### D. Modelos y proveedores

| Capacidad | OpenCode v2 | MAGI | Veredicto | Prioridad |
|---|---|---|---|---|
| Catálogo | models.dev + provider/modelo configurable | Catálogo curado + `/api/models/catalog` + **sondeo en vivo** con veredicto por modelo (`docs/bench/modelos-agente.json`) | **PARCIAL** | — |
| Multi-credencial | **No encontrado**: `QuotaExceeded` es no reintentable y no rota a otra key | Pool con rotación, cooldown, clasificador central y fallback OpenRouter→NVIDIA (`lib/provider-resilience/*`) | **NOSOTROS** | — |
| Costo por corrida | Tokens y costo por sesión visibles en el header; costo que incluye subagentes | Trazas por corrida (tokens, costo, latencia, fallbacks, reintentos) + export Markdown/JSON + comparación de dos corridas | **IGUAL+** | — |
| Variantes de razonamiento | `#variante` con `low/medium/high/max`, definibles por modelo | Razonamiento por modelo en el selector | **PARCIAL** | P2 |
| Modelos locales | Descubrimiento automático de Ollama, LM Studio y vLLM | No existe | **FALTA** | P2 |

### E. Producto

| Capacidad | OpenCode v2 | MAGI | Veredicto | Prioridad |
|---|---|---|---|---|
| Consejo multi-modelo | No encontrado (la herramienta `question` es para preguntarle al **usuario**, no para debatir entre modelos) | Consejo con debate, voto, juez de fusión, personas y presets | **NOSOTROS** | — |
| Salud de modelos | No encontrado | Ventana por modelo, badges en la UI, degradación en ejecución | **NOSOTROS** | — |
| Integración con el ecosistema | Console/Go, workspaces, SSO/SCIM, presupuestos | No existe | **FALTA** | P3 (fuera de alcance: es producto de OpenCode, no del agente) |

## 4. Brechas priorizadas

### P0 — Sin estas dos, "paridad" es una palabra demasiado grande

**P0.1 Instrucciones del proyecto (`AGENTS.md`) — HECHA (Etapa 2.1).**
`lib/agent/instructions.ts` lee el archivo de la raíz del worktree de la task y
lo suma al system prompt con topes por archivo (16 KB) y total (40 KB). El
contenido viaja **tal cual** —sanitizarlo haría perder la guía real— pero
enmarcado entre `<project-instructions>` con la advertencia explícita de que si
intenta cambiar las reglas o exfiltrar secretos, no se obedece y se reporta.
Tests: `npm run agent:test-instructions` 26/26, incluido el cableado real (una
corrida de `runAgentLoop` con `generateTextImpl` falso verifica que el texto
llega al prompt) y que un archivo hostil queda enmarcado. Limitación dicha en
el test: no puede probar que el modelo obedezca el marco.

**Lo que quedó de P0.1 para después** (P2, no bloquea): descubrimiento anidado
por directorio y recarga en vivo como OpenCode. Piden hooks dentro de
`list_files`/`read_file` y refresco del prompt entre pasos.

---

*(Lo que sigue es el resto de la brecha P0 original, ya escrito antes de
cerrar P0.1.)*

**Compactación (P0.2, sigue pendiente).** Es la feature más usada de
cualquier agente de código y la que más cambia la calidad de una corrida: sin
ella, el agente no sabe que este repo usa `npm test` con tope de warnings, que
`package.json` tiene CRLF, ni qué convenciones seguir. OpenCode además las
**recubre en caliente**: editar el archivo durante la sesión actualiza la guía
antes del siguiente request.

Dónde encaja sin romper nada: `buildSystemPrompt()` ya es una función pura que
arma el prompt; habría que leer los `AGENTS.md` del workspace (del directorio
de la task hacia la raíz, sin salirse del worktree aislado) y concatenarlos en
un bloque marcado como **dato del usuario, no instrucción de sistema** — el
mismo criterio que ya aplicamos con la salida de MCP y de `web_search`. El
orden de precedencia (más cercano gana) y la recarga en vivo son mejoras sobre
la versión inicial.

Riesgo: bajo. No toca el loop ni las tools; es una entrada más al prompt.

**P0.2 Compactación (0.5, pendiente de tu aprobación).** OpenCode la tiene
prendida por defecto; nosotros la medimos y la dejamos apagada. Es la misma
decisión de siempre: el gobernador cambia comportamiento del agente y necesita
tu visto bueno. Con la medición que ya existe (Fase 8A) el trabajo es
conectar el governor, no inventarlo.

### P1 — Distancia real de capacidad

- **Comandos `/` personalizados**: el composer ya tiene paleta y `/nuevo`; falta
  generalizar a plantillas con `$ARGUMENTS` y override de modelo/agente. Los
  bloques de shell de OpenCode corren **fuera** del flujo de permisos (su doc
  lo advierte); si los copiamos, los nuestros deberían correr dentro de
  `run_script` o al menos sin acceso a credenciales.
- **Agentes/subagentes definidos por el usuario**: perfiles con system prompt,
  modelo y tope de pasos. Tenga sentido solo **después** de P0.1, porque un
  perfil sin instrucciones de proyecto es la mitad de una persona.
- **Reglas de permiso por herramienta**: hoy el uso local es "todo permitido"
  por diseño y el remoto está endurecido por scopes. Un motor de reglas
  `allow/ask/deny` por herramienta y recurso acercaría la dureza de OpenCode
  al uso local. Es caro y se come el punto fuerte nuestro (el agente local es
  libre a propósito), así que va después de lo anterior.
- **MCP: OAuth y recursos**. Nuestro cliente es más estricto (allowlist +
  aprobación humana + pin de IP), lo cual está bien; lo que nos falta es
  conectarse a servidores remotos que **exigen** OAuth (hoy solo aceptan
  headers/tokens estáticos) y leer recursos/publicar prompts.
- **Deshacer dentro de la task en curso**. Ya tenemos el revert "grueso"
  (worktree aislado + propuesta con aprobación). Lo que falta es el revert
  "fino" de un paso, para no tirar toda la tarea por un paso malo.

### P2 — Bueno tener, no bloquea

`patch` multi-archivo, `webfetch` (reusando `lib/mcp/pinned-http.ts`, que ya
resuelve el problema de SSRF), `glob`/`grep` con regex, skills por archivo con
carga bajo demanda, plugins/SDK/ACP, modelos locales descubiertos, formateo
automático tras editar, LSP, variantes de razonamiento, temas/keybinds.

### Fuera de alcance

Console/Go, workspaces con SSO/SCIM y presupuestos: es producto comercial de
OpenCode, no capacidad del agente.

## 5. Nuestros extras (no hay nada que copiar acá)

1. **Consejo multi-modelo** con debate, voto y juez de fusión.
2. **Pool de credenciales** con cooldown, clasificador central, redacción y
   fallback entre proveedores.
3. **Control remoto** desde el teléfono con dispositivos emparejados, scopes,
   auditoría, step-up TOTP, kill switch y push.
4. **Inteligencia de proyecto** como tools del agente (mapa, símbolos, grafo).
5. **Trazas por corrida** con export y comparación de dos corridas.
6. **Salud de modelos** con degradación en ejecución y sondeo en vivo.
7. **La app como servidor MCP** para que otro agente use nuestro consejo.
8. **Fail-closed por defecto** en MCP + aprobación humana para escritura.

## 6. NO VERIFICADO

- **No corrí OpenCode.** Todo el lado OpenCode sale de su documentación v2 y del
  repo (`dev`). Si una fila dice "no encontrado", significa exactamente eso: no
  está en la doc ni en el código que se relevó; no significa que no exista.
- **Versiones futuras.** El relevo es de la rama actual al 2026-11-10; OpenCode
  cambia rápido y este documento envejece.
- **Rendimiento comparado.** No hay benchmarks de ningún lado: la Etapa 1 es la
  matriz. Medir vendría después (era la Etapa 1 "benchmark" original, que
  quedó redefinida por decisión tuya).
- **Los extras nuestros** están verificados con tests propios (99/99 suites),
  no contra OpenCode.

## 7. Lo que se propone para la Etapa 2 (pendiente de tu aprobación)

En el orden que sugiero, un sub-bloque por commit como venimos haciendo:

1. `AGENTS.md` del proyecto leído por el loop del agente, con descubrimiento
   anidado y prueba de que un archivo hostil **no** puede inyectar instrucciones
   de sistema (test hermético).
2. Comandos `/` personalizados con `$ARGUMENTS`, override de modelo y, si se
   aprueban los bloques de shell, dentro de `run_script`.
3. Decidir el gobernador del Context Engine (0.5) — prender, dejar apagado o
   apagar con medición.
4. `webfetch` y `patch` multi-archivo, que son los dos huecos de herramientas
   más baratos de cerrar.
5. Agentes/subagentes con perfil (system, modelo, pasos).

**Nada de esto arranca sin tu visto bueno.**
