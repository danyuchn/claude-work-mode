export type TempoMode = 'dispatch' | 'converge' | 'autonomous'

declare module 'claude-code' {
  interface PluginState {
    'work-mode': {
      tempo: TempoMode[]
      autoSent: boolean
      poolsSent: string
      pending: string[]
      prompts: number
    }
  }
}
