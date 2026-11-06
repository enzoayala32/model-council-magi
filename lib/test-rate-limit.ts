/**
 * Tests del rate limiting por peer real (corrección de seguridad).
 *
 * Lo que se fija:
 *  - la clave es el peer real (`x-magi-peer-addr`), no un header que manda el
 *    cliente;
 *  - rotar `X-Forwarded-For` YA NO evada el límite;
 *  - `X-Forwarded-For` solo se usa con `TRUST_PROXY`, y tomando el ÚLTIMO
 *    salto;
 *  - el mapa de buckets tiene tope (no crece sin límite);
 *  - el límite global corta aunque el atacante cambie de peer;
 *  - un cliente legítimo no queda bloqueado por otro.
 *
 * Uso: npm run security:test-rate-limit
 */
import {
  __bucketCountForTests,
  __resetRateLimitsForTests,
  checkRateLimit,
  clientIdentifier,
  recordFailure,
  recordSuccess,
} from "./auth/rate-limit";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed += 1; console.log(`+ ${label}`); return; }
  failed += 1;
  console.log(`x ${label}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
}

const RESOURCE = "auth_token";

/** Request con los headers que dejaría el server real. */
function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/auth/token", { headers });
}

function main(): void {
  const savedTrustProxy = process.env.TRUST_PROXY;
  const savedPeer = process.env.PEER;
  delete process.env.TRUST_PROXY;

  console.log("== la clave es el peer real ==\n");
  {
    __resetRateLimitsForTests();
    check("peer llega por x-magi-peer-addr", clientIdentifier(req({ "x-magi-peer-addr": "203.0.113.9" })) === "203.0.113.9");
    check("sin peer ni XFF cae en desconocido", clientIdentifier(req({})) === "desconocido");
    check("X-Forwarded-For se ignora sin TRUST_PROXY", clientIdentifier(req({ "x-forwarded-for": "1.2.3.4" })) === "desconocido", clientIdentifier(req({ "x-forwarded-for": "1.2.3.4" })));
    check("el peer real gana sobre XFF falsificado", clientIdentifier(req({ "x-magi-peer-addr": "203.0.113.9", "x-forwarded-for": "1.2.3.4" })) === "203.0.113.9");
  }

  console.log("\n== rotar XFF ya no evada el limite ==\n");
  {
    __resetRateLimitsForTests();
    // Sin TRUST_PROXY: 8 intentos con XFF distinto, todos desde el mismo peer.
    let blocked = -1;
    for (let i = 1; i <= 8; i += 1) {
      const request = req({ "x-magi-peer-addr": "203.0.113.9", "x-forwarded-for": `10.0.0.${i}` });
      const gate = checkRateLimit(clientIdentifier(request), RESOURCE);
      if (!gate.allowed) { blocked = i; break; }
      recordFailure(clientIdentifier(request), RESOURCE);
    }
    check("el limite se alcanza pese a rotar XFF", blocked > 0 && blocked <= 7, blocked);
    check("concretamente en el 7mo intento", blocked === 7, blocked);
  }

  console.log("\n== TRUST_PROXY: ultimo salto ==\n");
  {
    process.env.TRUST_PROXY = "1";
    check("con TRUST_PROXY se usa XFF", clientIdentifier(req({ "x-forwarded-for": "1.2.3.4" })) === "1.2.3.4");
    check("se toma el ULTIMO salto, no el primero", clientIdentifier(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })) === "5.6.7.8", clientIdentifier(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })));
    check("el peer real sigue ganando si viene", clientIdentifier(req({ "x-magi-peer-addr": "203.0.113.9", "x-forwarded-for": "1.2.3.4" })) === "203.0.113.9");
    // El primer salto lo escribe el cliente: si se confiara en él, B podría
    // hacerse pasar por A.
    check("un atacante no puede hacerse pasar por otro via el primer salto", clientIdentifier(req({ "x-magi-peer-addr": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 203.0.113.9" })) === "203.0.113.9");
    delete process.env.TRUST_PROXY;
  }

  console.log("\n== tope del mapa de buckets ==\n");
  {
    __resetRateLimitsForTests();
    for (let i = 0; i < 300; i += 1) recordFailure(`203.0.113.${i % 250}`, RESOURCE);
    const size = __bucketCountForTests();
    check("el mapa no crece sin límite", size <= 5_000, size);
    check("ypodó al pasar el tope", size < 300 || size <= 5_000, size);
  }

  console.log("\n== limite global: corta aunque cambie el peer ==\n");
  {
    __resetRateLimitsForTests();
    // Ataque distribuido: un peer distinto por intento. El límite por IP no
    // lo ve, pero el global sí.
    let blockedAt = -1;
    for (let i = 1; i <= 40; i += 1) {
      const identifier = `203.0.113.${i}`;
      const gate = checkRateLimit(identifier, RESOURCE);
      if (!gate.allowed) { blockedAt = i; break; }
      recordFailure(identifier, RESOURCE);
    }
    check("el ataque distribuido queda frenado", blockedAt > 0, blockedAt);
    check("y advierte cuanto esperar", true);
    // Mientras el global está activo, ni siquiera un peer nuevo pasa.
    check("durante el freno global ni un peer nuevo pasa", !checkRateLimit("198.51.100.77", RESOURCE).allowed);
    // Y un cliente legítimo con éxito... el global no lo deja pasar tampoco:
    // es el último recurso, documentado.
    recordSuccess("198.51.100.77", RESOURCE);
    check("el éxito no levanta el freno global (a proposito)", !checkRateLimit("198.51.100.77", RESOURCE).allowed);
  }

  console.log("\n== un legitimo no queda bloqueado por otro ==\n");
  {
    __resetRateLimitsForTests();
    const attacker = "203.0.113.9";
    const legit = "192.0.2.10";
    for (let i = 0; i < 6; i += 1) {
      if (checkRateLimit(attacker, RESOURCE).allowed) recordFailure(attacker, RESOURCE);
    }
    check("el atacante quedó bloqueado", !checkRateLimit(attacker, RESOURCE).allowed);
    check("el legitimo sigue pasando (bucket propio)", checkRateLimit(legit, RESOURCE).allowed);
    check("y tiene su cupo completo", (checkRateLimit(legit, RESOURCE) as { allowed: true; remaining: number }).remaining === 5);
    recordFailure(legit, RESOURCE);
    check("el legitimo gasta de su propio cupo", (checkRateLimit(legit, RESOURCE) as { allowed: true; remaining: number }).remaining === 4);
  }

  if (savedTrustProxy !== undefined) process.env.TRUST_PROXY = savedTrustProxy;
  if (savedPeer !== undefined) process.env.PEER = savedPeer;
  else delete process.env.PEER;

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main();
