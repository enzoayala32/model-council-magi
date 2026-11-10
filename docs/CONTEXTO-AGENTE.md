# Contexto del agente (archivo de traspaso)

Fuente principal de estado. Si contradice al código o al reporte, mandan el
código y el reporte: corregir este archivo y anotarlo en "Decisiones y dudas".

## 1. Fase actual y último commit

- **Etapa 0: HECHA**, salvo 0.5 (pendiente de aprobación del usuario). Cerrados
  0.1 (admin MCP solo desde la PC con step-up), 0.2 (hermetismo de los tests de
  MCP), 0.3 (pin de IP anti-rebinding), 0.4 (docs del subagente opencode, que
  destapó dos bugs previos), 0.6 (ROADMAP corregido) y 0.7 (sondeo por pool).
- **Etapa 1: HECHA. Etapas 2.1, 2.2 y 2.3: HECHAS** — las tres brechas P0 de
  `docs/PARIDAD-OPENCODE.md`: `AGENTS.md` leído por el loop (26/26), governor del
  historial prendido por defecto (62/62, 42/42, 15/15, 7/7) y comandos `/`
  personalizados (37/37).
- **Cola de prompts (pedido de Enzo): HECHA** — varios prompts esperan y el runner
  se los pasa al agente cuando cada ciclo da su resumen, en orden, sobre el mismo
  workspace y **arrastrando el contexto del ciclo anterior** (`priorMessages`,
  compactado por el governor, así que no crece sin techo). 41/41 + 8/8 en vivo.
- Quedan las **P1/P2** de la matriz de paridad, ninguna arrancada.
- Decisión que espera al usuario: habilitar o no `deepseek-ai/deepseek-v4.1-flash`
  (SIRVE en el sondeo, no está en el catálogo).
- Último commit: ver `git log -1` (branch main, pusheado).

- **Misión 2**: Fases 5, 6, 7, 8 y 9 **HECHAS**, con las tres tandas de
  correcciones de la revisión aplicadas. Últimas: sondeo por pool y clasificador
  central (5 de 9 candidatos SIRVE con tool-calling), composer estilo opencode, y
  la app como servidor MCP para opencode. Conectado al producto: push con allowlist
  de servicios, MCP **fail-closed** (stdio e http), aprobación humana con step-up,
  y administración de servidores MCP. **No queda nada pendiente de
  implementación** en la Misión 2; lo que resta son los NO VERIFICADOS de abajo.
- Último commit: ver `git log -1` (branch main, pusheado).

## 2. Estado de verificación (sobre HEAD)

- `npm run typecheck`: exit 0.
- `npm run lint -- --max-warnings 10`: exit 0 (10 warnings).
- `npm test`: **104/104 suites OK**. El detalle por suite está en el ROADMAP;
  acá basta el total. (`security:test-peer-spoof` es falible bajo carga: el
  propio test documenta el porqué y aislado pasa siempre.)
- **Hermetismo verificado**: la suite corre con un preload que rompe el DNS no
  loopback (`NODE_OPTIONS=--require dns-block.js`). Si un test nuevo toca la
  red, eso falla.
- Barrido de rutas: `security:test-route-enforcement` 13/13 sobre
  **52 pares ruta+método** con guardia verificada; `security:test-peer-spoof`
  34/34 en verde.
- `npm run build`: exit 0.
- `npx tsx scripts/run-tests.ts --verify`: exit 0 (tests + tope de lint).

## 3. Próximos 3 pasos concretos

1. Verificar en vivo lo NO VERIFICADO de abajo, con las checklists manuales.
2. Flaky nuevo: el patrón es el de `agent:test-exec-with-tree-kill` (tiempos
   fijos con 300ms de margen que la suite cargada se pasaba de largo). Esperas
   con sondeo, no tiempos fijos.
3. Mantener este archivo al cierre de cada sub-bloque.

## 4. Decisiones vigentes

- **Loopback por peer, no por Host**: `server.ts` escribe `x-magi-peer` desde
  `req.socket.remoteAddress` y borra el que mande el cliente. `Host` solo es
  defensa contra navegadores (proxy).
- **Default-deny**: toda ruta `/api` llama `guardRequest()` como primera
  sentencia y tiene scope en `lib/auth/scopes.ts`. Un route sin declarar
  hace fallar `security:test-route-enforcement`.
- **Sesión de operador opaca**: la cookie lleva un id de 256 bits hasheado en
  `operator_sessions`; el token maestro viaja solo por `Bearer`. Sin
  `APP_ACCESS_TOKEN` configurado, toda sesión caduca.
- **`ALLOWED_HOSTS` suma los hosts loopback** (no los reemplaza): configurar un
  host de túnel no te deja fuera de tu propia PC.
- **Túnel = todo remoto parece loopback**: por eso el server fuerza
  `MAGI_DISABLE_LOCAL_IMPLICIT=1` cuando `ALLOWED_HOSTS` tiene un host no
  loopback o hay modo LAN.
- **Tests de servers**: usan `MAGI_DEV=1` (código fuente) y puertos libres; se
  detienen siempre al terminar.
- **El doctor no prueba la red**: arma un snapshot y lo pasa a una función
  pura (`lib/auth/remote-doctor.ts`). Con `--check-tailscale` sí corre un
  proceso, y solo ese.
- **`REMOTE_ACCESS=off` corta todo Host no loopback** (proxy), así que en el
  doctor cuenta como configuración segura aunque haya hosts remotos.
- **`X-Forwarded-Proto` decide solo el atributo `Secure`**, nunca autorización;
  por eso se puede confiar en él sin abrir un agujero.
- **El SSE se prueba con una cadena real de servers** (proxy con buffering →
  origen); en dev, Next compila cada ruta al pedirla, así que los tests que
  levantan servers precompilan las rutas antes de medir.
- **El push notifica desde `transitionTask`**, DESPUÉS de persistir: un
  servicio de push caído no puede deshacer una transición. Sin suscripciones,
  `notifyStatusChange` sale sin abrir claves ni tocar la red.
- **Los scripts de `npm` no aceptan `VAR=valor` en Windows** (usa `cmd`): los
  tiempos de test van como default dentro del archivo.
- **Backticks dentro de un comentario SQL de `lib/db.ts`** cierran el template
  literal y rompen el archivo (pasó dos veces). Sin backticks en esos comments.
- **MCP: la config va FUERA del repo**; el proceso hijo nunca hereda el entorno
  completo (allowlist + lista de nunca reenviar). `GITHUB_TOKEN` también está en
  la lista: un servidor que lo "necesite" debe usar otra variable con otro
  nombre.
- **MCP fail-closed**: solo `readOnlyTools` exime de aprobación. El
  `readOnlyHint` del servidor NO exime (es el no confiable) y la heurística de
  nombres solo advierte. Una heurística de ~20 palabras clasificaba como lectura
  `deploy`, `transfer_funds`, `drop_table`... y se ejecutaban sin aprobación.
- **El código de aprobación no viaja al modelo**: solo `approvalId` + "pendiente".
  El código lo ve el humano en la UI.
- **Un fallo de DNS al enviar push es `red`, no `rechazado`**, y con status 0:
  así no se desactiva una suscripción válida.
- **En un test que spawn procesos, jamás tiempos fijos con margen chico**: con la
  suite completa cargada, 2s + 2.3s no alcanzaban y el test fallaba sin bug real.
- **Una respuesta demasiado grande se corta con ERROR explícito**, no recortando
  el cuerpo: si se corta a mitad, el JSON queda roto y parece un server roto.
- **Los fixtures de test van en `lib/test/fixtures/`** (reutilizables por varios
  tests), no inline en cada archivo: el inline escurría `\n` y rompía el spawn.
- **La decisión de "herramienta de escritura" es por HERRAMIENTA, no por
  servidor** (`tools/list` + cache). Por servidor, hasta una tool de lectura
  pedía aprobación humana.
- **En SQL, `col = NULL` nunca matchea**: para dueños sin id (el operador) hay
  que usar `IS NULL`. Ese fue el bug de la lista vacía de suscripciones push.
- **`requireScope` sale de `lib/auth/authorize.ts`**, no de `guard.ts` (guard no
  lo re-exporta).

## 5. Trampas conocidas (ya pagadas)

- Los dev servers comparten `.next`: un server viejo puede servir código viejo,
  y un `npm run build` previo deja manifiesta de producción que hace que el modo
  dev devuelva **404 por rutas que existen** (así fallaba
  `security:test-peer-spoof` dentro del runner, nunca solo). `server.ts` acepta
  `MAGI_DEV_DIST_DIR` y los tests le dan un directorio temporal propio.
  Reiniciar limpio antes de medir; `dev:false` sirve el build de `.next`.
- En Windows los servers de prueba se lanzan con
  `cmd //c "start /b RUTA.cmd > log 2>&1"` y hay que matarlos al terminar.
- `appendEvent` asigna `seq` desde **0**.
- Los tests usan `MAGI_DATA_DIR` temporal; nunca tocan `data/council.db` real.
- No usar `git commit --amend` sobre commits ya pusheados (rompe el remoto).
- Backticks dentro de un template literal de `lib/db.ts` cierran el comentario
  y rompen el archivo.
- `package.json` y `scripts/run-tests.ts` tienen CRLF: para editarlos con
  script hay que preservar el fin de línea o el ancla no coincide. El último
  script del objeto no lleva coma: el ancla tiene que incluirlo.
- En Windows los `\\b` de un regex dentro de un heredoc se corrompen a
  backspace: usar la herramienta edit o concatenación.

## 6. Pendientes NO VERIFICADOS

- Android real (PWA instalada), acceso desde otra máquina: sin dispositivo.
- Tailscale / Cloudflare reales: sin túnel configurado.
- Push real a Android (Fase 6): sin servicio de push.
- Proveedores reales: `NVIDIA_API_KEY`(+`_2`), `GEMINI_API_KEY` y `OPENROUTER_API_KEY`(1-4)
  están definidas; el sondeo de modelos corrió en vivo con ellas (arriba). Lo que sigue
  sin correr en vivo es el consejo completo con debate/voto contra estos proveedores.
- CI en Linux/GitHub Actions no ejecutado desde este entorno.
