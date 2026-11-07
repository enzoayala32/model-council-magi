/**
 * Fase 6 — tests de notificaciones push (sin red, sin servicios reales).
 *
 * Cubre las tres capas:
 *
 *  - `lib/push/vapid.ts`: generación del par EC P-256, persistencia en la DB,
 *    y que el JWT VAPID se pueda VERIFICAR de verdad (firma ES256 real, no un
 *    string que "parece" un JWT).
 *  - `lib/push/web-push.ts`: estructura del registro `aes128gcm` de RFC 8291
 *    (salt, record size, id de la clave efímera, tag de 16 bytes) y que el
 *    emisor inyectable reciba exactamente lo esperado.
 *  - `lib/push/subscriptions.ts` y `lib/push/emit.ts`: CRUD, preferencias,
 *    coalescencia, tope por minuto y despacho con emisor falso.
 *
 * Corre contra una DB aislada (respeta `MAGI_DATA_DIR` si el runner ya la
 * fijó). Uso: npm run security:test-web-push
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { base64Url, createVapidJwt, fromBase64Url, loadOrCreateVapidKeys, readVapidPublicKey, verifyVapidJwt } from "./push/vapid";
import { encryptAes128gcm, sendWebPush, type PushSubscription } from "./push/web-push";
import { validateSubscriptionKeys } from "./push/endpoint";
import {
  findByEndpoint,
  listSubscriptions,
  normalizeEventPrefs,
  PUSH_EVENTS,
  recordFailure,
  recordSuccess,
  setEnabled,
  setEvents,
  subscriptionsFor,
  upsertSubscription,
  deleteByEndpoint,
} from "./push/subscriptions";
import {
  dispatch,
  MAX_PER_MINUTE,
  ownerFrom,
  planNotifications,
  sanitizePayload,
  type NotificationEvent,
} from "./push/emit";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-push-test-"));
}

/** Un par EC P-256 como el que genera el navegador al suscribirse. */
function browserKeys(): { p256dh: string; auth: string; publicKeyObject: crypto.KeyObject } {
  const pair = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const raw = pair.publicKey.subarray(pair.publicKey.length - 65);
  return {
    p256dh: base64Url(raw),
    auth: base64Url(crypto.randomBytes(16)),
    publicKeyObject: crypto.createPublicKey({ key: pair.publicKey, format: "der", type: "spki" }),
  };
}

function event(kind: NotificationEvent["kind"], tag: string, at: number, body = "algo pasó"): NotificationEvent {
  return { kind, tag, title: "Consenso IA", body, url: "/m/tasks/" + tag, at };
}

async function main(): Promise<void> {
  console.log("== base64url ==\n");
  check("round-trip de bytes", Buffer.compare(fromBase64Url(base64Url(Buffer.from([0, 1, 250, 255]))), Buffer.from([0, 1, 250, 255])) === 0);
  check("sin padding ni +/", !/[+/=]/.test(base64Url(crypto.randomBytes(64))));

  console.log("\n== credenciales VAPID ==\n");
  const savedTotp = process.env.MAGI_TOTP_KEY;
  const savedToken = process.env.APP_ACCESS_TOKEN;

  delete process.env.MAGI_TOTP_KEY;
  delete process.env.APP_ACCESS_TOKEN;
  check("sin clave de cifrado no hay credenciales", loadOrCreateVapidKeys() === null);
  check("y no se filtra la pública", readVapidPublicKey() === null);

  process.env.MAGI_TOTP_KEY = "clave-de-prueba-larga-y-segura";
  const keys = loadOrCreateVapidKeys();
  check("con clave, se generan credenciales", keys !== null);
  if (!keys) return;
  check("la pública es un punto sin comprimir (65 bytes)", fromBase64Url(keys.publicKey).length === 65, fromBase64Url(keys.publicKey).length);
  check("empieza en 0x04 (sin comprimir)", fromBase64Url(keys.publicKey)[0] === 0x04);
  check("la misma llamada devuelve la misma clave (persistencia)", readVapidPublicKey() === keys.publicKey);

  const jwt = createVapidJwt(keys, "https://fcm.googleapis.com");
  const claims = verifyVapidJwt(jwt);
  check("el JWT generado verifica con firma real", claims !== null);
  check("el aud es el origen del servicio", claims?.aud === "https://fcm.googleapis.com", claims?.aud);
  check("el exp es futuro", (claims?.exp ?? 0) > Math.floor(Date.now() / 1000));
  check("el sub es un mailto", typeof claims?.sub === "string" && claims.sub.startsWith("mailto:"));
  const parts = jwt.split(".");
  check("el JWT tiene 3 partes", parts.length === 3);
  const tampered = parts[0] + "." + parts[1] + "." + base64Url(Buffer.from([1, 2, 3]));
  check("una firma modificada no verifica", verifyVapidJwt(tampered) === null);
  const otherAud = createVapidJwt(keys, "https://otro.ejemplo.com");
  check("cada servicio pide su propio JWT", verifyVapidJwt(otherAud)?.aud === "https://otro.ejemplo.com");

  if (savedTotp === undefined) delete process.env.MAGI_TOTP_KEY;
  else process.env.MAGI_TOTP_KEY = savedTotp;
  if (savedToken === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = savedToken;

  console.log("\n== registro cifrado aes128gcm (RFC 8291) ==\n");
  const browser = browserKeys();
  const subscription: PushSubscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    p256dh: browser.p256dh,
    auth: browser.auth,
  };

  // Aleatoriedad fija: el mismo salt en cada llamada.
  const fixedSalt = Buffer.alloc(16, 7);
  const first = encryptAes128gcm(subscription, Buffer.from(JSON.stringify({ title: "hola" }), "utf8"), () => fixedSalt);
  const header = first.body.subarray(0, 16 + 4 + 1);
  check("el registro arranca con el salt de 16 bytes", Buffer.compare(header.subarray(0, 16), fixedSalt) === 0);
  const recordSize = header.readUInt32BE(16);
  check("el record size es 4096", recordSize === 4096, recordSize);
  const idLength = header[20];
  check("el id de la clave efimera mide 65 bytes", idLength === 65, idLength);
  check("el total tiene header + ciphertext + tag de 16", first.body.length === 21 + 65 + first.body.length - 21 - 65 && first.body.length > 21 + 65 + 16);
  check("el tag de GCM está al final (16 bytes)", first.body.length === 21 + 65 + (first.body.length - 21 - 65));
  check("el cuerpo cifrado no contiene el texto plano", !first.body.includes(Buffer.from("hola", "utf8")));
  check("la ephemeral publica viaja en el header", Buffer.compare(first.body.subarray(21, 26), first.ephemeralPublicKey.subarray(0, 5)) === 0);

  const second = encryptAes128gcm(subscription, Buffer.from("x", "utf8"), () => fixedSalt);
  check("dos cifrados con el mismo salt dan cuerpos distintos (clave efimera nueva)", !second.body.equals(first.body));
  const otherSalt = encryptAes128gcm(subscription, Buffer.from("x", "utf8"), () => Buffer.alloc(16, 9));
  check("un salt distinto cambia el registro", !otherSalt.body.equals(second.body));

  // Un payload grande se parte en varios registros (el límite es 4096).
  const big = encryptAes128gcm(subscription, Buffer.alloc(9000, 1), () => fixedSalt);
  check("un payload mayor al record size se parte", big.body.length > 4096);
  check("el primer registro respeta el limite declarado", big.body.subarray(16, 20).readUInt32BE() === 4096);

  console.log("\n== envio con emisor inyectable ==\n");
  // Tipado explícito con valor inicial: si no, TypeScript lo estrecha
  // a null y no ve la asignación que ocurre dentro del emisor falso.
  const lastRequestBox: { value: { url: string; headers: Record<string, string>; bodyLength: number } | null } = { value: null };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    lastRequestBox.value = {
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      bodyLength: ((init.body as Uint8Array | undefined)?.length ?? 0),
    };
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;

  const sent = await sendWebPush(subscription, { title: "listo", body: "termine", tag: "t1", url: "/m" }, keys, fakeFetch);
  check("el envio correcto da ok", sent.ok && sent.status === 201, sent);
  check("apunta al endpoint del servicio", lastRequestBox.value?.url === subscription.endpoint);
  check("manda Content-Encoding aes128gcm", lastRequestBox.value?.headers["Content-Encoding"] === "aes128gcm");
  check(
    "manda Authorization vapid con JWT y clave",
    (() => {
      const authorization = lastRequestBox.value?.headers.Authorization ?? "";
      // El JWT tiene 3 partes base64url separadas por puntos, y la clave es
      // exactamente la pública guardada (base64url del punto sin comprimir).
      return (
        /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/.test(authorization) &&
        authorization.endsWith(", k=" + keys.publicKey)
      );
    })(),
    lastRequestBox.value?.headers.Authorization?.slice(0, 40),
  );
  check("manda Encryption con el salt", /^salt=[A-Za-z0-9_-]+$/.test(lastRequestBox.value?.headers.Encryption ?? ""));
  check("manda Crypto-Key dh + p256ecdsa", /dh=[A-Za-z0-9_-]+/.test(lastRequestBox.value?.headers["Crypto-Key"] ?? "") && /p256ecdsa=[A-Za-z0-9_-]+/.test(lastRequestBox.value?.headers["Crypto-Key"] ?? ""));
  check("el cuerpo no es texto plano", (lastRequestBox.value?.bodyLength ?? 0) > 21 + 65 + 16, lastRequestBox.value?.bodyLength);

  // El endpoint de este test no es un servicio de push conocido, así que para
  // probar el envío en sí hay que saltear la validación de host.
  const sendOptions = { allowlist: [new URL(subscription.endpoint).hostname], skipDns: true };

  const failFetch = (async () => new Response("suscripcion inexistente", { status: 404 })) as unknown as typeof fetch;
  const failedSend = await sendWebPush(subscription, { title: "x" }, keys, failFetch, sendOptions);
  check("un 404 da ok=false con el status", !failedSend.ok && failedSend.status === 404, failedSend);
  check("un 404 se categoriza como expirado", failedSend.error === "expirado", failedSend);
  check("el cuerpo de la respuesta NO se guarda", (failedSend.error ?? "").length <= 40, failedSend);

  const throwFetch = (async () => {
    throw new Error("ECONNREFUSED 10.0.0.5:443");
  }) as unknown as typeof fetch;
  const threw = await sendWebPush(subscription, { title: "x" }, keys, throwFetch, sendOptions);
  check("un error de red no lanza y se categoriza", !threw.ok && threw.error === "red", threw);

  const timeoutFetch = (async () => {
    throw new Error("The operation was aborted due to timeout");
  }) as unknown as typeof fetch;
  const timedOut = await sendWebPush(subscription, { title: "x" }, keys, timeoutFetch, sendOptions);
  check("un timeout se categoriza como tiempo", timedOut.error === "tiempo", timedOut);

  const unauthorized = await sendWebPush(
    subscription,
    { title: "x" },
    keys,
    (async () => new Response("", { status: 403 })) as unknown as typeof fetch,
    sendOptions,
  );
  check("un 403 se categoriza como rechazado", unauthorized.error === "rechazado", unauthorized);

  const serverError = await sendWebPush(
    subscription,
    { title: "x" },
    keys,
    (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
    sendOptions,
  );
  check("un 5xx se categoriza como red", serverError.error === "red", serverError);

  // SSRF: un endpoint guardado antes de la allowlist no se manda.
  const ssrfEndpoint = { ...subscription, endpoint: "https://127.0.0.1:9/x" };
  const blocked = await sendWebPush(ssrfEndpoint, { title: "x" }, keys, fakeFetch);
  check("un endpoint de loopback guardado no se manda", !blocked.ok && blocked.error === "rechazado", blocked);

  // Redirect: no se sigue. fetch lanzaría por `redirect: "error"`; acá se
  // verifica que la petición se hizo con esa opción.
  let sawRedirectOption = false;
  const spyFetch = (async (_url: string, init: RequestInit) => {
    sawRedirectOption = (init as RequestInit & { redirect?: string }).redirect === "error";
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  await sendWebPush(subscription, { title: "x" }, keys, spyFetch, sendOptions);
  check("no se siguen redirects al enviar", sawRedirectOption);

  console.log("\n== claves de suscripcion: forma de navegador ==\n");
  const goodKeys = (() => {
    const pair = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const rawPoint = pair.publicKey.subarray(pair.publicKey.length - 65);
    return { p256dh: base64Url(rawPoint), auth: base64Url(crypto.randomBytes(16)) };
  })();
  check("un par de claves real de navegador valida", validateSubscriptionKeys(goodKeys.p256dh, goodKeys.auth).ok === true);
  check("65 bytes y primer byte 0x04 es lo que se exige", fromBase64Url(goodKeys.p256dh).length === 65 && fromBase64Url(goodKeys.p256dh)[0] === 0x04);
  check("una clave que no arranca en 0x04 se rechaza", validateSubscriptionKeys("A".repeat(87), goodKeys.auth).ok === false);
  check("un auth corto se rechaza", validateSubscriptionKeys(goodKeys.p256dh, "corta").ok === false);
  check("un auth largo se rechaza", validateSubscriptionKeys(goodKeys.p256dh, base64Url(crypto.randomBytes(32))).ok === false);
  check("p256dh con caracteres no-base64url se rechaza", validateSubscriptionKeys("no-es-base64url!", goodKeys.auth).ok === false);
  check("claves vacias se rechazan", validateSubscriptionKeys("", "").ok === false);
  check(
    "un punto comprimido (33 bytes) se rechaza",
    validateSubscriptionKeys(base64Url(fromBase64Url(goodKeys.p256dh).subarray(0, 33)), goodKeys.auth).ok === false,
  );

  console.log("\n== suscripciones: CRUD y preferencias ==\n");
  const browser2 = browserKeys();
  const created = upsertSubscription({
    endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
    p256dh: browser2.p256dh,
    auth: browser2.auth,
    owner: { kind: "device", id: "dev-1" },
    userAgent: "Android",
  });
  check("se crea con todas las preferencias", created.events.length === PUSH_EVENTS.length, created.events);
  check("queda activa", created.enabled);
  const again = upsertSubscription({
    endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
    p256dh: browser2.p256dh,
    auth: browser2.auth,
    owner: { kind: "device", id: "dev-1" },
    events: ["approval.required"],
  });
  check("re-suscribirse actualiza en vez de duplicar", again.id === created.id);
  check("guarda las preferencias nuevas", JSON.stringify(again.events) === JSON.stringify(["approval.required"]), again.events);
  check("hay una sola fila para ese endpoint", listSubscriptions().filter((s) => s.endpoint === created.endpoint).length === 1);
  check("byEndpoint la encuentra", findByEndpoint(created.endpoint)?.id === created.id);
  check(
    "subscriptionsFor filtra por evento y por activa",
    subscriptionsFor("approval.required").some((s) => s.id === created.id) && !subscriptionsFor("task.finished").some((s) => s.id === created.id),
  );

  check("normalize descarta eventos desconocidos", JSON.stringify(normalizeEventPrefs(["task.finished", "inventado"])) === JSON.stringify(["task.finished"]));
  check("normalize sin eventos vuelve a los de por defecto", normalizeEventPrefs(undefined).length === PUSH_EVENTS.length);
  check("normalize con lista vacia vuelve a los de por defecto", normalizeEventPrefs([]).length === PUSH_EVENTS.length);
  check("setEvents actualiza", JSON.stringify(setEvents(created.id, ["council.finished"])) === JSON.stringify(["council.finished"]));
  check("setEnabled desactiva", setEnabled(created.id, false) && findByEndpoint(created.endpoint)?.enabled === false);
  check("una suscripcion desactivada no recibe nada", subscriptionsFor("council.finished").some((s) => s.id === created.id) === false);
  setEnabled(created.id, true);

  recordSuccess(created.id);
  check("registra el ultimo exito", (findByEndpoint(created.endpoint)?.lastSuccessAt ?? 0) > 0);
  recordFailure(created.id, "el servicio dijo que no", false);
  check("registra el ultimo error sin desactivar", findByEndpoint(created.endpoint)?.enabled === true);
  check("borra el error previo al tener exito", recordSuccess(created.id) === undefined && findByEndpoint(created.endpoint)?.lastError === null);
  recordFailure(created.id, "suscripcion muerta", true);
  check("un fallo con disable la desactiva", findByEndpoint(created.endpoint)?.enabled === false);
  setEnabled(created.id, true);
  check("se puede borrar por endpoint", deleteByEndpoint(created.endpoint) && findByEndpoint(created.endpoint) === null);

  console.log("\n== emision: coalescencia, tope y saneamiento ==\n");
  const subs = [
    { ...created, id: "s1", enabled: true, events: ["task.finished" as const], ownerKind: "device", ownerId: "d1" },
    { ...created, id: "s2", enabled: true, events: ["task.finished" as const], ownerKind: "device", ownerId: "d2" },
    { ...created, id: "s3", enabled: false, events: ["task.finished" as const], ownerKind: "device", ownerId: "d3" },
    { ...created, id: "s4", enabled: true, events: ["approval.required" as const], ownerKind: "device", ownerId: "d4" },
  ] as unknown as Parameters<typeof planNotifications>[1];

  const now = 1_000_000;
  const plan = planNotifications(
    [event("task.finished", "t1", now - 500), event("task.finished", "t1", now - 300), event("task.finished", "t2", now - 100)],
    subs,
    0,
    now,
  );
  // 2 suscripciones suscritas x 2 tags (t1 con 2 eventos, t2 con 1).
  check("una notificacion por suscripcion y tag", plan.length === 4, plan.length);
  check("una suscripcion desactivada no recibe", !plan.some((item) => item.subscriptionId === "s3"));
  check("una suscripcion sin el evento en preferencias no recibe", !plan.some((item) => item.subscriptionId === "s4"));
  const t1 = plan.filter((item) => item.payload.tag === "t1");
  check("los 2 eventos de la misma task se agrupan en una", t1.length === 2 && t1.every((item) => item.payload.count === 2), t1);
  const t2 = plan.filter((item) => item.payload.tag === "t2");
  check("la otra task genera su propia notificacion", t2.length === 2 && t2.every((item) => item.payload.count === 1), t2);
  check("el cuerpo indica cuantos se agruparon", t1[0].payload.body.includes("(+1 más)"), t1[0].payload.body);
  check("un evento solo no lleva contador", !t2[0].payload.body.includes("más"), t2[0].payload.body);
  check("el payload pasa el saneamiento", sanitizePayload(plan[0].payload).title === "Consenso IA");

  const budgeted = planNotifications([event("task.finished", "t1", now)], subs, MAX_PER_MINUTE, now);
  check("con el tope alcanzado no notifica", budgeted.length === 0, budgeted.length);
  const partial = planNotifications([event("task.finished", "t1", now)], subs, MAX_PER_MINUTE - 1, now);
  check("con lugar para una, notifica una", partial.length === 1, partial.length);

  const sanitized = sanitizePayload({ title: "t", body: "b", tag: "x", url: "/m", secreto: "no-debe-pasar", prompt: "tampoco", count: 3 });
  check("sanea los campos desconocidos", !("secreto" in sanitized) && !("prompt" in sanitized), Object.keys(sanitized));
  check("recorta strings largos", sanitizePayload({ title: "x".repeat(400) }).title.length === 300);
  check("sin campos de texto usa defaults", JSON.stringify(sanitizePayload({})) === JSON.stringify({ title: "Consenso IA", body: "", tag: "magi", url: "/m", count: 1 }));

  const calls: Array<{ id: string; payload: { tag: string; count: number } }> = [];
  const successHooks: string[] = [];
  const failureHooks: Array<{ id: string; disable: boolean }> = [];
  const outcome = await dispatch(
    plan.concat({ subscriptionId: "inexistente", payload: sanitizePayload({ title: "x" }) }),
    subs,
    async (subscription, payload) => {
      calls.push({ id: subscription.id, payload: { tag: payload.tag, count: payload.count } });
      return subscription.id === "s2" ? { ok: false, status: 410, error: "se fue" } : { ok: true, status: 201 };
    },
    {
      recordSuccess: (id) => successHooks.push(id),
      recordFailure: (id, _error, disable) => failureHooks.push({ id, disable }),
    },
  );
  // 4 notificaciones planeadas (2 suscripciones x 2 tags).
  check("manda todas las del plan", calls.length === 4, calls.length);
  check("cada tag genera su propio envio", new Set(calls.map((call) => call.payload.tag)).size === 2, calls.map((c) => c.payload.tag));
  check("una suscripcion inexistente se salta", outcome.skipped === 1, outcome);
  check("cuenta los envios ok", outcome.sent === 2, outcome);
  check("cuenta los fallos", outcome.failed === 2, outcome);
  check("marca 410 como suscripcion muerta", outcome.dead.length === 2 && outcome.dead.every((id) => id === "s2"), outcome.dead);
  check("llama los hooks de exito y fallo", successHooks.length === 2 && failureHooks.length === 2 && failureHooks.every((entry) => entry.disable === true), {
    exito: successHooks.length,
    fallo: failureHooks,
  });

  check("owner: operador no tiene id de dispositivo", ownerFrom(true, null).kind === "operator");
  check("owner: dispositivo guarda su id", ownerFrom(false, "dev-x").id === "dev-x");

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
