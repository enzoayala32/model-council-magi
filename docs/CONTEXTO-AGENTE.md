# Contexto del agente (archivo de traspaso)

Fuente principal de estado. Si contradice al código o al reporte, mandan el
código y el reporte: corregir este archivo y anotarlo en "Decisiones y dudas".

## 1. Fase actual y último commit

- **Misión 2**, Fase 5 (acceso remoto) **EN CURSO**. Hecho: `docs/ACCESO-REMOTO.md`
  y el doctor (5.3). Falta: prueba de SSE tras proxy (5.4) y cookie `Secure`
  con `X-Forwarded-Proto` (5.5).
- Último commit: ver `git log -1` (branch main, pusheado).

## 2. Estado de verificación (sobre HEAD)

- `npm run typecheck`: exit 0.
- `npm run lint -- --max-warnings 37`: exit 0 (37 warnings).
- `npm test`: **85/85 OK** (incluye `security:test-remote-doctor` 65/65).
- `npm run build`: exit 0.
- `npx tsx scripts/run-tests.ts --verify`: exit 0 (tests + tope de lint).
- Barrido de rutas: `security:test-route-enforcement` 13/13 y
  `security:test-peer-spoof` 34/34 en verde (incluidos en el runner).

## 3. Próximos 3 pasos concretos

1. Test de SSE detrás de un proxy HTTP local con buffering/latencia
   (orden, heartbeat, reanudación con `?sinceSeq=`) — 5.4.
2. Cookie `Secure` cuando la request viene por HTTPS (`X-Forwarded-Proto`),
   con test, y documentar en `ACCESO-REMOTO.md` qué headers ve la app tras
   `tailscale serve` y Cloudflare Tunnel — 5.5.
3. Cerrar la Fase 5 y arrancar la Fase 6 (push Web Push/VAPID para Android).

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
