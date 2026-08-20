# Consenso IA — Model Council MAGI

> Spanish-language AI model council (draft → debate → synthesis) running mostly-free models via OpenRouter, direct NVIDIA NIM, and direct Google AI Studio, with a MAGI-inspired live status panel — including an optional "MAGI Mode" that assigns each of 3 models a fixed analytical lens (Melchior/Balthasar/Casper). Fork of [sanky369/open-model-council](https://github.com/sanky369/open-model-council).

Le hacés una pregunta a un panel de varios modelos de IA. Cada uno responde por separado, después se **critican entre sí** en una ronda de debate, un modelo juez extrae los consensos y desacuerdos reales, y finalmente un modelo sintetiza todo en una sola respuesta consensuada con el desglose completo de cada paso.

<img width="1232" alt="Consenso IA — pantalla de entrada con el panel MAGI en estado standby" src="open-model-council-ui.png" />

---

## Qué hace

1. **Borradores independientes.** 2 a 10 modelos responden la misma pregunta en paralelo, sin verse entre sí.
2. **Debate.** Cada modelo ve su propio borrador completo + versiones **condensadas** de los borradores de los demás, y produce una crítica + respuesta revisada. Corre hasta un máximo de rondas configurable, pero corta antes si las respuestas convergen (medido por vocabulario compartido entre los modelos); al terminar, cada modelo sobreviviente vota por la respuesta más fuerte del panel.
3. **Juez de fusión.** Un modelo dedicado extrae consenso, contradicciones, insights únicos y vacíos de cobertura entre todos los debates. La sección de contradicciones se muestra en la UI como un **mapa de desacuerdo**: tema por tema, la posición de cada modelo, y el veredicto del juez. Si el proveedor falla, cae a un reporte heurístico local en vez de romper la corrida.
4. **Síntesis final.** Un modelo redacta la respuesta consolidada usando el reporte del juez + todos los borradores/debates.
5. **Preguntas de seguimiento** sugeridas automáticamente, y podés seguir la conversación en el mismo hilo.

Podés inspeccionar cada fase en la UI, ver el **desglose de tokens por paso** (qué fase pesa más — el voto suele ser el más caro, porque manda la respuesta completa de cada modelo a cada votante), y hay una **vista Tribunal** alternativa (estética de terminal ámbar/rojo) para ver el veredicto final de forma más visual.

---

## Modo MAGI

Con **exactamente 3 modelos** seleccionados, podés activar "Modo MAGI" en Ajustes → Investigación. Le asigna a cada asiento una lente analítica fija, inspirada en el sistema del mismo nombre:

- **Melchior** — la científica: rigor empírico, evidencia verificable, precisión técnica.
- **Balthasar** — la guardiana: riesgo primero, quién puede salir perjudicado, consecuencias a largo plazo.
- **Casper** — la defensora: impacto humano real, contexto social, la fricción práctica que una vista puramente técnica se pierde.

Los modelos no "actúan" un personaje — el prompt les pide razonar explícitamente desde ese ángulo analítico, como una lente de revisión profesional, no un rol de ficción. Es una referencia estética a la franquicia (mismos nombres, mismo panel triangular), sin imitar diálogo ni personalidad de los personajes originales.

Cuando está activo y hay una corrida en curso, el panel MAGI (triángulo, con exactamente 3 asientos) muestra **MELCHIOR / BALTHASAR / CASPER** en los nodos en vez del nombre del modelo — el asiento sigue siendo el mismo modelo por debajo, la persona es una capa de encuadre sobre el prompt, no un modelo distinto. Si tenés un conteo distinto de 3 modelos seleccionados, el toggle se queda activado pero sin efecto (te avisa en la nota), y vuelve a aplicarse solo apenas volvés a 3 — no hace falta reactivarlo.

---

## Modelos y proveedores

El panel corre **primariamente con modelos gratuitos**. Podés sumar modelos de pago si tenés crédito cargado en OpenRouter (o querés usar tu propia key de NVIDIA/Google), pero nada de esto es obligatorio para que la app funcione.

| Proveedor | Cómo se llama | Requiere |
|---|---|---|
| **OpenRouter** | Modelos `:free` (Nemotron, GPT-OSS, Gemma, Laguna, North Mini Code) | `OPENROUTER_API_KEY` |
| **NVIDIA NIM** (directo) | Fallback automático para modelos Nemotron + 2 modelos nativos (Llama 3.1 8B, GLM-5.2) | `NVIDIA_API_KEY` (opcional) |
| **Google AI Studio** (directo) | 3 modelos Gemini nativos (3.7 Flash, 3.1 Pro Preview, 2.5 Flash-Lite) | `GEMINI_API_KEY` (opcional) |

**Por qué dos proveedores directos además de OpenRouter:** el pool gratuito de OpenRouter es compartido entre todos sus usuarios, así que los modelos más populares se saturan seguido (HTTP 429). NVIDIA y Google ofrecen sus propios cupos gratuitos, separados de ese pool compartido.

**Fallback automático por modelo:** además del fallback general de síntesis, cada modelo del roster puede declarar su propio `fallbackModelId` en `lib/models.ts` — un segundo motor que se prueba si el primero falla, manteniendo la identidad del asiento en toda la UI (el fallback es un cambio de motor invisible, nunca un modelo distinto que tengas que rastrear). Ya configurado con evidencia real de fallas para los 3 Gemini: `gemini-3.1-pro-preview → gemini-2.5-flash` (el Pro no tiene cupo gratuito, ver nota abajo), y `gemini-3.7-flash`/`gemini-3.5-flash → gemini-2.5-flash` por si el 503 persiste tras los reintentos.

### Nota sobre Gemini 3.1 Pro

Confirmado en vivo: este modelo **no tiene cupo gratuito** en Google AI Studio — necesita un proyecto de Google Cloud con facturación habilitada. Por eso tiene fallback automático a Flash configurado por defecto. Flash y Flash-Lite sí tienen cupo gratuito real.

---

## Ingeniería de resiliencia

El pool gratuito compartido de OpenRouter, y en menor medida las APIs directas de NVIDIA/Google, tienen fallas transitorias frecuentes. El sistema está armado para absorber esto sin romper toda la corrida:

- **Timeout real por llamada** (7 minutos por defecto) que se mantiene armado durante toda la lectura de la respuesta, no solo hasta que llegan los headers.
- **Reintento con backoff exponencial** en 429 (rate limit) y 503 (proveedor saturado), y en errores de red genéricos.
- **Reintento en respuesta vacía** para modelos de razonamiento que gastan todo su presupuesto "pensando" sin emitir contenido visible.
- **Watchdog por fase**, techo firme independiente para juez/síntesis/follow-ups.
- **Fallback de modelo dinámico para la síntesis** (nunca el mismo modelo dos veces) y **fallback por modelo individual** (ver arriba).
- **Indicador de confiabilidad por modelo**: ventana móvil de las últimas 8 llamadas por modelo; si falló ≥40% de las recientes, el selector muestra un ícono de advertencia con el motivo del último fallo al pasar el mouse. En memoria, se reinicia si reiniciás el servidor.
- **Logging detallado por consola** en cada paso.

---

## Agente de archivos (opcional)

Uno de los modelos del consejo puede actuar como **agente de archivos**, con herramientas para leer y proponer cambios sobre el proyecto donde corre el servidor:

- `list_directory`, `read_file` — se ejecutan al toque, sin aprobación.
- `propose_write_file`, `propose_edit_file` — nunca escriben directo a disco. Calculan un diff, lo dejan en espera, y **vos lo aprobás desde la UI**.

**Patchset atómico:** si un mismo turno del modelo propone cambios en varios archivos relacionados, la UI los agrupa (mismo `groupId`) con botones "Aplicar todo / Descartar todo" — al aplicar, se escriben en secuencia y si uno falla a mitad de camino no deja el grupo aplicado a medias.

**Auto-verificación de TypeScript real:** para archivos `.ts`/`.tsx`, corre `tsc --noEmit` de verdad contra el proyecto (no un chequeo simulado): escribe el contenido propuesto en el archivo real, corre el check, y lo restaura al contenido original pase lo que pase (bloque `finally`), serializado en una cola para que dos verificaciones no se pisen entre sí. El badge en la tarjeta pasa de "Verificando…" a "✓ Compila" o "✗ N errores" con el detalle expandible — antes de que decidas aprobar o no.

**Modelo de seguridad**: todo path se resuelve contra `AGENT_FS_ROOT` (por defecto, la carpeta del propio proyecto) y se rechaza si intenta salir de ahí, symlinks incluido.

Se activa desde el conector "Filesystem" en Ajustes, eligiendo qué modelo del panel actual actúa como agente.

> **Nota de build:** al compilar para producción vas a ver un warning de Turbopack ("Encountered unexpected file in NFT list") apuntando a `lib/fs-tools.ts`. No rompe el build ni el `npm run dev`/`npm start` local — es Turbopack avisando que no puede acotar con precisión qué archivos empaquetar en la función serverless, por las operaciones de filesystem dinámicas de esta feature. Solo importa si algún día deployás a Vercel u otra plataforma serverless.

---

## Adjuntos

Podés subir imágenes, archivos de texto, y documentos **PDF/DOCX** — el texto se extrae server-side (`pdf-parse` y `mammoth`) antes de mandarlo al consejo. La extracción es best-effort: un archivo corrupto o escaneado sin OCR no rompe la corrida.

---

## Vista Tribunal

Botón "Tribunal" junto a la respuesta sintetizada — muestra el mismo resultado con una estética alternativa de terminal (ámbar/rojo, tarjetas con esquinas cortadas), con el código de caso, el estado real (resuelto/en disputa según el juez de fusión), y el veredicto de cada modelo.

---

## Panel MAGI

El estado del consejo (en espera, deliberando, completo) se muestra en un panel inspirado en la estética de terminal MAGI — triángulo con líneas conectoras cuando hay 3 modelos (con nombres de persona si Modo MAGI está activo), disposición radial con 4-5, fila simple para el resto. Vive en `app/components/council/`, es autocontenido (estilos con prefijo `.magi*`, no tocan la paleta del resto de la app).

---

## Stack técnico

- **Framework:** Next.js 16 (App Router) + React 19
- **Lenguaje de la UI:** Español
- **Estilos:** CSS plano con sistema de variables (paleta cream/teal estilo Perplexity + panel MAGI independiente)
- **Markdown:** `react-markdown` + `remark-gfm`
- **Íconos:** `lucide-react`
- **Gateways de LLM:** [OpenRouter](https://openrouter.ai) (principal), [NVIDIA NIM](https://build.nvidia.com) y [Google AI Studio](https://aistudio.google.com) (directos)
- **Extracción de documentos:** `pdf-parse`, `mammoth`
- **Persistencia:** `localStorage` del navegador para hilos/skills — sin base de datos

---

## Instalación rápida

### 1. Clonar e instalar

```bash
git clone https://github.com/enzoayala32/model-council-magi.git
cd model-council-magi
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Como mínimo necesitás `OPENROUTER_API_KEY` ([conseguí una gratis acá](https://openrouter.ai/keys)). `NVIDIA_API_KEY` y `GEMINI_API_KEY` son opcionales.

### 3. Correr en desarrollo

```bash
npm run dev
```

Abrí [http://localhost:3000](http://localhost:3000).

### 4. Build de producción

```bash
npm run build
npm start
```

---

## Estructura del proyecto

```
app/
  page.tsx                        # UI completa
  layout.tsx                      # metadata, lang="es"
  globals.css                     # paleta cream/teal + estilos generales
  components/council/              # panel MAGI (autocontenido)
  api/council/route.ts             # variante no-streaming
  api/council/stream/route.ts      # orquesta las fases, personas MAGI, vía SSE
  api/council/apply-file-change/   # aprobación de cambios (incluye grupos atómicos)
  api/council/model-health/        # snapshot de confiabilidad por modelo
lib/
  models.ts                       # catálogo de modelos, fallbackModelId, paneles de fusión
  openrouter.ts                   # cliente OpenRouter
  nvidia.ts                       # cliente NVIDIA NIM directo
  google-ai-studio.ts             # cliente Google AI Studio directo
  llm-shared.ts                   # tipos y clase de error compartidos
  agent-tools.ts                  # herramientas de GitHub
  fs-tools.ts                     # herramientas del agente de archivos + auto-verificación TS
  model-health.ts                 # tracker en memoria de éxito/falla por modelo
  attachment-extraction.ts        # extracción de texto de PDF/DOCX
  skills.ts, threads.ts           # habilidades del agente e hilos guardados
```

---

## Créditos

Fork de [sanky369/open-model-council](https://github.com/sanky369/open-model-council), la implementación original del concepto "Model Council" estilo Perplexity. Esta versión suma: traducción completa al español, proveedores directos de NVIDIA/Google además de OpenRouter con fallback por modelo, ingeniería de resiliencia extensa, agente de archivos con aprobación (patchsets atómicos y auto-verificación de TypeScript real), extracción de PDF/DOCX, mapa de desacuerdo visual, y el panel MAGI con Modo MAGI opcional.
