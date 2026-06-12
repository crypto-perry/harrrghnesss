/** Common surface every vendor worker implements — the harness routes turns by session.vendor. */

export interface TurnProgress {
  onItem?: (line: string) => void;
}

export interface TurnOutcome {
  finalResponse: string;
  threadId: string | null;
  filesTouched: string[];
  usage: { input: number; cachedInput: number; output: number } | null;
}

export interface AgentWorker {
  readonly vendor: string;
  runTurn(sessionId: string, userMessage: string, progress?: TurnProgress): Promise<TurnOutcome>;
}
