"use client";

import { useState } from "react";

export type PingStatus = "idle" | "pinging" | "ok" | "fail";

export type ModelPingState = {
  status: PingStatus;
  latencyMs?: number;
  error?: string;
};

/**
 * Dry run manual: el usuario dispara un ping liviano a los modelos
 * seleccionados (POST /api/council/ping) antes de lanzar la corrida
 * completa, para no descubrir a mitad de una corrida de varios minutos
 * que un modelo está caído.
 */
export function useModelPing() {
  const [pingStatus, setPingStatus] = useState<Record<string, ModelPingState>>({});
  const [pinging, setPinging] = useState(false);

  async function runPing(modelIds: string[]) {
    if (!modelIds.length || pinging) return;
    setPinging(true);
    setPingStatus((current) => {
      const next = { ...current };
      for (const id of modelIds) next[id] = { status: "pinging" };
      return next;
    });
    try {
      const res = await fetch("/api/council/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelIds }),
      });
      const data = (await res.json()) as {
        results?: Array<{ modelId: string; ok: boolean; latencyMs: number; error?: string }>;
      };
      setPingStatus((current) => {
        const next = { ...current };
        for (const result of data.results ?? []) {
          next[result.modelId] = {
            status: result.ok ? "ok" : "fail",
            latencyMs: result.latencyMs,
            error: result.error,
          };
        }
        return next;
      });
    } catch {
      setPingStatus((current) => {
        const next = { ...current };
        for (const id of modelIds) next[id] = { status: "fail", error: "No se pudo contactar al servidor." };
        return next;
      });
    } finally {
      setPinging(false);
    }
  }

  function clearPingStatus() {
    setPingStatus({});
  }

  return { pingStatus, pinging, runPing, clearPingStatus };
}
