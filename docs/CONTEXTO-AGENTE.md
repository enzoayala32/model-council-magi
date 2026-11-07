# Contexto del agente (archivo de traspaso)

Fuente principal de estado. Si contradice al código o al reporte, mandan el
código y el reporte: corregir este archivo y anotarlo en "Decisiones y dudas".

## 1. Fase actual y último commit

- **Misión 2**, Fase 5 (acceso remoto) **HECHA** (5.3 doctor, 5.4 SSE tras proxy,
  5.5 cookie `Secure`). Sigue la **Fase 6**: push Web Push/VAPID para Android.
- Último commit: `b9fd7a5` — `fase 5.5: cookie Secure solo con HTTPS real`.

## 2. Estado de verificación (sobre HEAD)

- `npm run typecheck`: exit 0.
- `npm run lint -- --max-warnings 37`: exit 0 (37 warnings).
- `npm test`: **87/87 OK** (incluye `security:test-remote-doctor` 65/65,
  `security:test-sse-proxy` 26/26, `security:test-request-proto` 34/34).
- `npm run build`: exit 0.
- `npx tsx scripts/run-tests.ts --verify`: exit 0 (tests + tope de lint).
- Barrido de rutas: `security:test-route-enforcement` 13/13 y
  `security:test-peer-spoof` 34/34 en verde (incluidos en el runner).

## 3. Próximos 3 pasos concretos

1. Fase 6: push Web Push/VAPID — suscripción por dispositivo, coalescencia,
   preferencias y tests con emisor falso.
2. Fases 7-9 (MCP): config fuera del repo, cliente read-only con allowlist,
   escritura con aprobación, y `/api/mcp` como servidor.
3. Empujar y mantener este archivo al cierre de cada sub-bloque.

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

## 5. Trampas conocidas (ya pagadas)

- Los dev servers comparten `.next/dev`: un server viejo puede servir código
  viejo. Reiniciar limpio antes de medir; `dev:false` sirve el build de
  `.next`.
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
- Proveedores reales: faltan `NVIDIA_API_KEY`/`GEMINI_API_KEY`.
- CI en Linux/GitHub Actions no ejecutado desde este entorno.
