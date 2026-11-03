export type PlanStatus = 'pending' | 'in_progress' | 'completed'

/** Tokens by kind, as the API reports them per model request. */
export type TokenUsage = {
  /** Uncached input tokens. */
  input: number
  /** Input tokens served from the prompt cache. */
  cacheRead: number
  /** Input tokens written to the prompt cache. */
  cacheWrite: number
  /** Tokens the model generated. */
  output: number
}

export type BarStep = {
  text: string
  status: PlanStatus
  /** Clock time (ms) the step was first seen in progress or done; absent while pending. */
  startedAt?: number
  /** Clock time (ms) the step was first seen completed. */
  doneAt?: number
  /** Tokens of every model request (subagents' included) made while this step was in progress. */
  tokens?: number
}

export type BarPlan = {
  title: string
  steps: BarStep[]
  /** Clock time (ms) the plan first arrived; null when it was picked up from a file that has no start. */
  startedAt: number | null
  /** False for an empty list, and once a finished plan has held at 100% for a while. */
  shown: boolean
  /** Every token the plan used so far, by kind; absent before the first request is counted. */
  usage?: TokenUsage
  /** Tokens used while the plan was open but no step was in progress. */
  otherTokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    'plan-bar': {
      /** The chat's plan; null before the first one. */
      plan: Shaped<BarPlan | null>
      /** True while the person has pinned the details open by clicking the bar. */
      open: boolean
      /** Clock time of the last tick: live step times and the moving glyphs. */
      now: number
      /** True while switches.json turns the mod off ("plan-bar": false). */
      off: boolean
    }
  }
}
