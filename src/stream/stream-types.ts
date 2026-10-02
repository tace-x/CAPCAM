export type { StreamStatus } from "../shared/types";

export interface StreamStateSnapshot {
  status: import("../shared/types").StreamStatus;
  changedAt: number;
  errorMessage: string | null;
}
