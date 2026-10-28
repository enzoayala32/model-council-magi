# Fase 0 — Línea base

**Fecha:** 2026-10-28 (Windows, Git Bash)\
**Commit base:** `e65cf07` (`feat(agent): Fase 9G — validación integral del Autonomous Loop`)\
**Entorno:** Node `v22.23.4`, npm `12.2.0`, better-sqlite3 `13.0.3` operativo.\
**Cambios de código en esta fase:** ninguno.

## Comandos ejecutados

1. `npm install` → exit 0. Aviso: 4 paquetes con install scripts bloqueados por la política de allowScripts (`better-sqlite3`, `esbuild`, `sharp`, `unrs-resolver`); `better-sqlite3` ya estaba compilado y se verificó con una consulta en memoria. `npm audit`: 13 vulnerabilidades (1 low, 1 moderate, 10 high, 1 critical), no se aplicó `npm audit fix`.
2. `npx tsc --noEmit` → exit 0, sin salida.
3. 65 scripts de test offline (todos los `agent:test*`, `provider-resilience:test*` y `test-council-resilience`, excluyendo los 3 harness con proveedor real/argumentos manuales) → **63/65 exit 0**.
4. Harness diferidos ejecutados aparte: `agent:test`, `agent:test-runner-real`, `agent:test-model-registry`.

## Resultado global

- **Fase 8 agrupada:** `npm run agent:test-phase8` → exit 0, **480/480** casos.
- **Fase 9 agrupada:** `npm run agent:test-phase9` → exit 0, **1.401/1.401** aserciones.
- **Scripts individuales offline:** 63/65 exit 0.
- **`npx tsc --noEmit`:** exit 0.
- **Fallos preexistentes documentados (no corregidos):** `agent:test-project` sin argumentos y `agent:test-repo-map-tool`.
- **No cuentan como OK:** `agent:test`, `agent:test-runner-real` y `agent:test-model-registry` (detalle abajo).

## Fallos y limitaciones

### 1. `agent:test-project` — exit 1 sin argumentos

El script es un harness manual: imprime `Uso: npm run agent:test-project -- "C:\\ruta\\al\\proyecto" ["Nombre"]` y sale con 1. No es un fallo de código.

Verificación complementaria con argumentos, en un repo git temporal y con `data/council.db` temporal (wrapper que hace `chdir` antes de importar):

```
=== PRUEBA DE ACEPTACIÓN 2A: PASS ===
```

Log: `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs\agent_test-project_with_args.log`.

### 2. `agent:test-repo-map-tool` — exit 1

El comando hijo se arma sin citar la ruta del repo:

```
npx tsx C:\Users\Admin\Desktop\model council\model-council-magi\lib\agent\tools.ts ...
Error: Cannot find module 'C:\Users\Admin\Desktop\model'
```

La ruta del repo contiene un espacio (`model council`), así que el argumento se parte. Es un fallo preexistente del test, dependiente de la ruta; no se corrigió en Fase 0. Log: `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs\agent_test-repo-map-tool.log`.

### 3. Proveedores reales — no validados

`OPENROUTER_API_KEY` está presente en el entorno, pero tanto `agent:test` como `agent:test-runner-real` terminan con:

```
Cannot convert argument to a ByteString because the character at index 12
has a value of 8212 which is greater than 255.
```

En `agent:test`: `stopReason: error`, `pasos: 0`, 0 propuestas. En `agent:test-runner-real`: task `FAILED`, `stopReason: error`. El valor de la key no se imprime ni se commitea. No se cuenta como prueba de proveedor real aprobada.

Logs: `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs\agent_test_with_prompt.log` y `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs\agent_test-runner-real_with_args.log`.

### 4. `agent:test-model-registry` — exit 1, SIN CORRER

Faltan `NVIDIA_API_KEY` y `GEMINI_API_KEY`. El script imprime:

```
=== PRUEBA DE ACEPTACIÓN 2E: SIN CORRER (no cuenta como aprobada) ===
```

Log: `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs\agent_test-model-registry.log`.

## DB y artefactos

- `data/council.db` está ignorado por git (`.gitignore` línea 13).
- Hash antes de la línea base: `ced79f7b4591134f68df66b40314e50acd31c9fcc667531fbf6e1a684cf7d547`.
- Hash después: `5c8abc80fe3a4995b3c96034a4d5a2eb0a7df76dd3883e52ca1c4961e29a58d6`.
- El cambio es esperable: varias suites escriben en la DB real. El propio repo ya lo documenta en `salidas/10-suites-que-escriben-data.txt` (por ejemplo `agent:test-task-state`, `agent:test-runner`, `agent:test-agent-routes`, `agent:test-4a-nogit`, `agent:test-web-search-tool`, `agent:test-provider-resilience`). No se commiteó ni se editó la DB a mano.
- `package-lock.json` y `README.md` sin cambios.
- `git status` solo muestra artefactos untracked de revisión (`MAGI-FASE9-DISENO.md`, `MAGI-ROADMAP-INTEGRAL.md`, `MANIFEST.sha256`, `salidas/`, `scripts/`) y este reporte.

## Tabla de scripts offline

| Script | Exit | Resumen |
|---|---:|---|
| `agent:test-project` | 1 | exit 1 sin args (uso); con args en repo temporal: PASS |
| `agent:test-task-state` | 0 | PASS |
| `agent:test-workspace-manager` | 0 | PASS |
| `agent:test-runner` | 0 | PASS |
| `agent:test-proposal-store` | 0 | 4/4 casos OK |
| `agent:test-apply` | 0 | 5/5 casos OK |
| `agent:test-agent-routes` | 0 | 19/19 casos OK |
| `agent:test-dispatcher` | 0 | exit 0 (5 casos; sin línea de resumen final) |
| `agent:test-delete-and-browse` | 0 | 9/9 casos OK |
| `agent:test-inspect` | 0 | 5/5 casos OK |
| `agent:test-4a-nogit` | 0 | 5/5 casos OK |
| `agent:test-run-script` | 0 | 6/6 casos OK |
| `agent:test-delete-file` | 0 | 6/6 casos OK |
| `agent:test-git-trace` | 0 | 5/5 casos OK |
| `agent:test-tool-policy` | 0 | 15/15 casos OK |
| `agent:test-exec-with-tree-kill` | 0 | 16/16 casos OK |
| `agent:test-search-provider` | 0 | 12/12 casos OK |
| `agent:test-web-search-tool` | 0 | 19/19 casos OK |
| `agent:test-web-search-compat` | 0 | 17/17 casos OK |
| `agent:test-repo-inventory` | 0 | 19/19 casos OK |
| `agent:test-repo-symbols` | 0 | 71/71 casos OK |
| `agent:test-repo-analysis` | 0 | 31/31 casos OK |
| `agent:test-resolution-config` | 0 | 30/30 casos OK |
| `agent:test-dependency-graph` | 0 | 53/53 casos OK |
| `agent:test-dependency-graph-repo` | 0 | 19/19 casos OK |
| `agent:test-repo-map-views` | 0 | 59/59 casos OK |
| `agent:test-repo-map-service` | 0 | 72/72 casos OK |
| `agent:test-repo-map-tool` | 1 | exit 1 (ruta con espacios en comando hijo) |
| `agent:test-provider-resilience` | 0 | 44/44 casos OK |
| `test-council-resilience` | 0 | 66/66 casos OK |
| `agent:test-context-estimate` | 0 | 23/23 casos OK |
| `agent:test-context-budget` | 0 | 43/43 casos OK |
| `agent:test-context-usage` | 0 | 26/26 casos OK |
| `agent:test-context-sensitive` | 0 | 97/97 casos OK |
| `agent:test-context-select` | 0 | 71/71 casos OK |
| `agent:test-context-engine` | 0 | 46/46 casos OK |
| `agent:test-context-history-governor` | 0 | 51/51 casos OK |
| `agent:test-repo-map-snapshot` | 0 | 36/36 casos OK |
| `agent:test-read-range` | 0 | 50/50 casos OK |
| `agent:test-context-loop` | 0 | 37/37 casos OK |
| `agent:test-phase8` | 0 | exit 0 (agrupador; 480/480 total) |
| `agent:test-autonomy-contract` | 0 | 230/230 casos OK |
| `agent:test-autonomy-contract-db` | 0 | 35/35 casos OK |
| `agent:test-autonomy-plan` | 0 | 182/182 casos OK |
| `agent:test-autonomy-ledger` | 0 | 130/130 casos OK |
| `agent:test-autonomy-plan-tools` | 0 | 41/41 casos OK |
| `agent:test-autonomy-verifier` | 0 | 47/47 aserciones OK |
| `agent:test-autonomy-briefing` | 0 | 51/51 aserciones OK |
| `agent:test-autonomy-progress` | 0 | 93/93 aserciones OK |
| `agent:test-autonomy-dispatcher` | 0 | 150/150 aserciones OK |
| `agent:test-autonomy-final-report` | 0 | 64/64 aserciones OK |
| `agent:test-autonomy-cancel` | 0 | 70/70 aserciones OK |
| `agent:test-autonomy-validation` | 0 | 114/114 aserciones OK |
| `agent:test-autonomy-runner` | 0 | 76/76 aserciones OK |
| `agent:test-autonomy-resume` | 0 | 38/38 aserciones OK |
| `agent:test-autonomy-resume-integration` | 0 | 80/80 aserciones OK |
| `agent:test-phase9` | 0 | exit 0 (agrupador; 1.401/1.401 total) |
| `provider-resilience:test-pool` | 0 | 20/20 casos OK |
| `provider-resilience:test-cooldown` | 0 | 19/19 casos OK |
| `provider-resilience:test-classify` | 0 | 32/32 casos OK |
| `provider-resilience:test-config` | 0 | 19/19 casos OK |
| `provider-resilience:test-redact` | 0 | 20/20 casos OK |
| `provider-resilience:test-events` | 0 | 14/14 casos OK |
| `provider-resilience:test-status-route` | 0 | 5/5 casos OK |
| `provider-resilience:test-concurrency` | 0 | 190/190 casos OK |

## Evidencia

- Logs completos: `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs`.
- Resumen estructurado: `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs\summary.json`.
- Este reporte: `salidas/fase-0-linea-base.md`.

## Decisiones y dudas

- **Solo se recibió la Fase 0.** El mensaje menciona “todas las fases de abajo”, pero no incluye Fase 1 ni siguientes. No se inventaron fases ni se tocó código; se ejecutó únicamente la línea base.
- **No se corrigió ningún fallo preexistente.** `agent:test-project` (uso) y `agent:test-repo-map-tool` (ruta con espacios) quedan documentados para que la fase que corresponda decida el arreglo.
- **`npm install` con install scripts bloqueados.** No fue necesario `--ignore-scripts`: `better-sqlite3` funciona y `tsx`/tests corren. Se deja constancia por si el CI tiene otra política.
- **Proveedor real bloqueado por entorno/credencial.** No se marcó como OK. Si se autoriza una key válida, los comandos para reintentar son `npm run agent:test -- "..."` y `npm run agent:test-runner-real -- "<repo>" "<prompt>"`.
