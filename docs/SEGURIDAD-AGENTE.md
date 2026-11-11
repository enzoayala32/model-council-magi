# Modelo de amenazas: "agente comprometido"

> Fecha: 2026-11-10/11. Este documento existe por el trabajo de seguridad de la
> Etapa 2.6 (puntos 1a-1d). Su razón de ser es una frase: **el agente corre con
> los privilegios del usuario, sobre un workspace que el usuario controla, y su
> prompt puede venir de un sitio que el usuario NO controló** (una página web
> vía `webfetch`, un `AGENTS.md` de un repo clonado, la salida de un servidor
> MCP de terceros). Todo lo de abajo parte de esa asimetría.

## 1. Qué se defiende y de quién

| Actor | Qué controla | Ejemplo |
|---|---|---|
| Usuario | el repo, `.env`, las keys | quiere que el agente trabaje en SU código |
| Agente (modelo) | el contenido de los archivos que escribe | hace lo que le pide el prompt |
| Tercero | texto que llega al prompt | página web, repo clonado, MCP ajeno |

La amenaza no es "el agente se vuelve malvado": es **un tercero que le escribe
al agente** y consigue que ejecute algo con los privilegios del usuario.

## 2. Vías de ejecución evaluadas

Cada fila dice si el vector está **cerrado**, **mitigado** o **abierto**, y con
qué.

### 2.1 Escribir el puntero `.git` de un worktree — CERRADO (1a, 1b)

El vector original de la revisión. En un worktree, `.git` es un archivo-puntero
(`gitdir: ...`). Si el agente lo sobrescribe y apunta a un directorivo que él
mismo crea con `[core] fsmonitor = <comando>` en el `config`, la próxima
operación git de la app ejecuta el comando.

- **1a** rechaza toda ruta con un segmento `.git` en cualquier posición
  (`write_file`, `edit_file`, `patch`, `delete_file` y cualquier tool futura,
  porque todas pasan por `resolveSafePathParaEscribir`), con alias de Windows
  (`.git.`, `.git `, `GIT~1`) y variantes Unicode, y también cuando el destino
  real cae dentro de un `.git` por symlink.
- **1b** es la segunda capa: aunque el puntero se reemplace por OTRA vía, la
  verificación de integridad detiene git antes de ejecutarlo.

Conviene saber qué se vio en la PoC real: en Windows el puntero de un worktree
ya es read-only (EPERM), así que ahí el vector de escritura estaba tapado por el
SO; el que quedaba abierto de verdad era `delete_file`, que borraba el puntero.
En Linux, donde se reprodujo el ataque, los tres estaban abiertos.

### 2.2 `.git/hooks/*` en un workspace de copia — CERRADO (1a + 1b)

Cuando el workspace no es un worktree (modo `copy`) o en los fixtures, `.git`
es un directorio y escribir `.git/hooks/pre-commit` sería escribir un hook.

- **1a** rechaza esas rutas por nombre.
- **1b** neutraliza el resto: `-c core.hooksPath=<directorio vacío propio>`,
  así que aunque un hook exista en el repo, git no lo busca.

### 2.3 `.gitattributes` con `filter=` / `diff=` — MITIGADO, no cerrado

Un `.gitattributes` con `filter=mifiltro` hace que git corre
`git-mifiltro` (buscándolo en el `PATH`) al hacer checkout o diff. El archivo
`.gitattributes` es parte del repo: **no se puede bloquear por config**.

- **1b** cubre la variante `ext:` con `protocol.ext.allow=never`.
- Para los filtros locales **no hay cierre por config**: la defensa real es que
  el agente no puede añadir binaries al `PATH` del usuario (no tiene tool de
  shell arbitrario, solo `run_script` con allowlist de `build`/`test`/`lint`) y
  que `.gitattributes` viaja en el commit, así que un repo clonado con un
  `.gitattributes` malicioso **sí** podría definir un filtro. Si el comando del
  filtro existe en el PATH, git lo corre.

**Qué significa esto en la práctica:** clonar un repo que no es de confianza y
darle una task sigue siendo una acción de confianza. La allowlist de
`run_script` (solo `build`/`test`/`lint` de ese repo) es la que impide que el
agente instale el helper que el filtro necesita.

### 2.4 `.gitmodules` — MITIGADO

`.gitmodules` le dice a git que traiga submódulos de otra URL. El clone ocurre
con `git submodule update --init`, que la app **no** corre. La riesgada: un
`submodule.<nombre>.update` con un comando. Como no se corre `submodule`, no se
ejecuta.

### 2.5 `core.fsmonitor` desde la config GLOBAL del usuario — CERRADO (1b)

`GIT_CONFIG_NOSYSTEM=1`, config global anulada y `GIT_CONFIG_SYSTEM` anulado
(Linux). Un `include.path` con comando en `~/.gitconfig` ya no ejecuta.

### 2.6 Scripts de `package.json` — MITIGADO (allowlist larga)

`run_script` corre scripts del workspace, que es exactamente "ejecutar código
del repo". La mitigación es la allowlist: solo `build`, `test` y `lint`, por
nombre y con `npm run <nombre>`, nunca un comando arbitrario. **No es una
defensa contra un repo malicioso** (un `test` puede hacer cualquier cosa): es
una defensa contra que el agente invente comandos. Para un repo de confianza,
que es el caso de uso, es lo razonable.

### 2.7 `.husky/` y hooks de herramientas — MITIGADO

`.husky/` es una convención (Core.hooksPath la activa alguien). Con
`core.hooksPath` forzado al directorio vacío, no se lee ni `.husky` ni
`.git/hooks`.

### 2.8 Exfiltración por `webfetch` — CERRADO con política (punto 2)

El modelo puede pedir cualquier URL pública. Con un prompt injection, la query
puede llevar datos del repo (`?d=<secreto>`). Se cierra con allowlist/denylist
de dominios configurables y aprobación humana para lo no listado; ver
`docs/PERMISOS-WEBFETCH.md`.

## 3. Lo que NO se defiende (dicho sin adornos)

- **El repo del usuario es de confianza o no lo es.** Si el usuario clona un
  repo hostil y le da una task, el agente va a tocar su código y puede correr
  sus scripts (`test`). Eso es coherente con lo que el usuario pidió, pero hay
  que saberlo.
- **`.gitattributes` con filtro local** (2.3): no hay cierre por config.
- **La salida del modelo sigue siendo texto**: ningún marco de prompt impide
  de verdad que un modelo obedezca una inyección. Lo que hay es que las
  consecuencias de obedecer están acotadas: no puede escribir en `.git`, no
  puede bajar URL sin aprobación, no puede correr comandos arbitrarios.
- **`run_script` con un repo hostil** ejecuta lo que el repo quiera (2.6).

## 4. Resumen de capas

| Capa | Qué cubre | Dónde |
|---|---|---|
| Allowlist de `run_script` | comandos arbitrarios del agente | `lib/agent/tools.ts` |
| Rechazo de rutas `.git` (1a) | escritura/borrado en el interno de git | `lib/agent/safe-path.ts` |
| git endurecido + integridad (1b) | fsmonitor, hooks, config global | `lib/agent/git-safe.ts` |
| Política de `webfetch` (2) | exfiltración y destinos | `lib/agent/webfetch.ts` |
| Marcado de dato no confiable | inyección vía MCP/web/skills ajenas | prompt del agente |
| Aprobación humana | cambios peligrosos desde remoto | `lib/mcp/approvals.ts` |

**Ninguna capa es suficiente sola.** El punto 1a sin el 1b deja el puntero
indefenso si alguien encuentra otra vía para escribirlo; el 1b sin el 1a deja
al agente corrompiendo el workspace (aunque git no ejecute nada, la task
quedaría inservible). Por eso las dos.
