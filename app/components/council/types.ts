export type CouncilStatus = "standby" | "active" | "processing" | "complete" | "error";

export type NodeState = "waiting" | "thinking" | "debating" | "complete" | "error";

export interface CouncilNodeData {
  id: string;
  label: string;
  badge: string;
  state: NodeState;
}

export interface CouncilStat {
  label: string;
  value: string;
}
