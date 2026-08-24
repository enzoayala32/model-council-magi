"use client";

import { useEffect, useState } from "react";
import type { ModelHealthInfo } from "../lib/client-types";

/**
 * Carga y refresca el indicador de confiabilidad por modelo
 * (GET /api/council/model-health). Best-effort: si falla, los badges
 * de salud simplemente no se muestran, nada más depende de esto.
 */
export function useModelHealth() {
  const [modelHealth, setModelHealth] = useState<Record<string, ModelHealthInfo>>({});

  useEffect(() => {
    refreshModelHealth();
  }, []);

  function refreshModelHealth() {
    fetch("/api/council/model-health")
      .then((res) => res.json())
      .then((data: { models: Array<ModelHealthInfo & { modelId: string }> }) => {
        const next: Record<string, ModelHealthInfo> = {};
        for (const entry of data.models ?? []) {
          next[entry.modelId] = {
            attempts: entry.attempts,
            failures: entry.failures,
            lastFailureReason: entry.lastFailureReason,
            lastOk: entry.lastOk,
          };
        }
        setModelHealth(next);
      })
      .catch(() => {
        // Best-effort — health badges just won't show if this fails, nothing else depends on it.
      });
  }

  return { modelHealth, refreshModelHealth };
}
