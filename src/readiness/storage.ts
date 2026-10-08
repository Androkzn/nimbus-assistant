import { parseEvent, type ReadinessEvent } from "./schema";

/** Browser-local persistence for complete readiness assessments. */
export interface SavedAssessment {
  id: string;
  savedAt: string;
  phase: "running" | "finished" | "stopped" | "error";
  startedAtMs?: number;
  endedAtMs?: number;
  includeAnswer: boolean;
  events: ReadinessEvent[];
}

const STORAGE_KEY = "nimbus.readiness.assessments.v1";
const MAX_SAVED = 12;

function available(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadSavedAssessments(): SavedAssessment[] {
  if (!available()) return [];
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is SavedAssessment => {
        if (!item || typeof item !== "object") return false;
        const value = item as Partial<SavedAssessment>;
        if (typeof value.id !== "string" || !Array.isArray(value.events)) return false;
        try {
          value.events.forEach((event) => parseEvent(JSON.stringify(event)));
          return true;
        } catch {
          return false;
        }
      })
      .slice(0, MAX_SAVED);
  } catch {
    return [];
  }
}

export function saveAssessment(assessment: SavedAssessment): SavedAssessment[] {
  if (!available()) return [];
  const next = [assessment, ...loadSavedAssessments().filter((item) => item.id !== assessment.id)].slice(0, MAX_SAVED);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be disabled or full; the live report remains usable.
  }
  return next;
}

export function deleteSavedAssessment(id: string): SavedAssessment[] {
  if (!available()) return [];
  const next = loadSavedAssessments().filter((item) => item.id !== id);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Nothing else to do when the browser refuses the write.
  }
  return next;
}
