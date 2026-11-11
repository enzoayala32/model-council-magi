---
name: Convenciones del repo
description: Comandos de verificación, topes y convenciones que hay que respetar al tocar código de Consenso IA.
---

# Convenciones de este repo

Antes de dar una tarea por terminada:

1. `npm run typecheck` — exit 0.
2. `npm run lint -- --max-warnings 10` — el tope no se puede subir en silencio.
3. `npm test -- --verify` — la suite completa (más de 100 suites).
4. `npm run build` si el cambio toca la UI o las rutas.

Al agregar una tool del agente, actualizar los tests que comparan el set de
tools esperado (`test-repo-map-tool`, `test-web-search-compat`): dejarlos viejos
es un test que miente.

Al agregar un script de test, registrarlo en `package.json` — el runner
(`scripts/run-tests.ts`) descubre por prefijo, así que basta el nombre.
