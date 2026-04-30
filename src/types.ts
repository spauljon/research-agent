export interface Source {
  url: string;
  title: string;
  content: string;
  fetchedAt: string;
}

export interface PipelineState {
  query: string;
  sources: Source[];
  analysis: string;
  report: string;
}

export interface Checkpoint {
  version: 1;
  originalQuery: string;
  createdAt: string;
  updatedAt: string;
  completedStages: number[];
  reformulatedQuery: string | null;
  sources: Source[] | null;
  analysis: unknown | null;
}

export interface StageResult {
  stage: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentLoopResult {
  finalText: string;
  fetchedContent: Map<string, string>; // url → raw extracted text
}
