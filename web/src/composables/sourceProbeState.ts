import { reactive } from 'vue'
import type { SourceProbe } from '../api/standalone'

export type ProbeKind = 'live' | 'vod'

export const liveProbes = reactive<Record<string, SourceProbe>>({})
export const vodProbes = reactive<Record<string, SourceProbe>>({})
export const probeState = reactive({
  live: { running: false, done: 0, total: 0, ok: 0 },
  vod: { running: false, done: 0, total: 0, ok: 0 }
})

export function probeOf(kind: ProbeKind, id: string): SourceProbe | undefined {
  return (kind === 'live' ? liveProbes : vodProbes)[id]
}
