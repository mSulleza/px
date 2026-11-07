/**
 * SKU facts and pricing. Every number here was measured or read off the pricing
 * page on 2026-09-11; re-check with `px doctor` rather than trusting the file.
 */

import type { ModelId, Usage } from "../types.ts";

export interface ModelFacts {
  id: ModelId;
  contextWindow: number;
  maxTokensCeiling: number;
  supportsVision: boolean;
  /** hit = quantum*floor(pt/quantum) - flashPenalty. Measured, not documented. */
  cacheQuantum: number;
  cacheFloorPenalty: number;
  price: { hitPerM: number; missPerM: number; outPerM: number };
}

/** Off-peak rates. Peak is exactly 2x; see src/schedule/offpeak.ts. */
export const MODELS: Record<ModelId, ModelFacts> = {
  "deepseek-flash": {
    id: "deepseek-flash",
    contextWindow: 1_048_576,
    maxTokensCeiling: 393_216,
    supportsVision: true,
    cacheQuantum: 128,
    cacheFloorPenalty: 128,
    price: { hitPerM: 0.003, missPerM: 0.15, outPerM: 0.6 },
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    contextWindow: 1_048_576,
    maxTokensCeiling: 393_216,
    // Probed: v4-pro accepts image blocks with HTTP 200, silently discards them,
    // and answers confidently about an image it never saw (green PNG -> "Red").
    // Token accounting proves the drop: 11 prompt tokens for 64x64 and 1024x1024
    // alike, against flash's 190 and 658. Client-side refusal is the only defence.
    supportsVision: false,
    cacheQuantum: 128,
    cacheFloorPenalty: 0,
    price: { hitPerM: 0.022, missPerM: 0.66, outPerM: 1.98 },
  },
};

/**
 * The API silently aliases model ids, and it does not alias them consistently
 * between endpoints. `deepseek-reasoner` returns Flash, not Pro. Every response
 * is checked against this map, because a silent downgrade to a cheaper SKU
 * would look exactly like a successful call.
 */
const ACCEPTED_ECHOES: Record<ModelId, string[]> = {
  "deepseek-flash": ["deepseek-flash", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  "deepseek-v4-pro": ["deepseek-v4-pro"],
};

export function assertModelEcho(requested: ModelId, echoed: string): void {
  if (!echoed) return; // some frames omit it
  const ok = ACCEPTED_ECHOES[requested] ?? [];
  if (!ok.includes(echoed)) {
    throw new Error(`model mismatch: requested ${requested}, server answered as ${echoed}`);
  }
}

/** Predicted cache hit for a given prompt size. Used to alarm on drift. */
export function predictedHit(model: ModelId, previousPromptTokens: number): number {
  const f = MODELS[model];
  return Math.max(0, f.cacheQuantum * Math.floor(previousPromptTokens / f.cacheQuantum) - f.cacheFloorPenalty);
}

export function costUsd(model: ModelId, u: Usage, peak: boolean): number {
  const p = MODELS[model].price;
  const mult = peak ? 2 : 1;
  return (
    ((u.hitTokens * p.hitPerM + u.missTokens * p.missPerM + u.outputTokens * p.outPerM) / 1_000_000) * mult
  );
}
