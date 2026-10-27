// Events the recording state machine emits, and the payload StorageManager turns into a
// stored recording.

import type { MythicPlusInfo, RecorderStatus, RecordingResult, TimelineEvent } from '@shared/ipc.types'

// Emitted when a key's recording is complete and ready for post-processing
// (trim / thumbnail / metadata).
export interface ProcessingRequiredEvent {
  rawPath: string
  zoneName: string
  // WIN = key completed (see mythicPlus.outcome)
  result: RecordingResult
  durationSecs: number
  // Where the kept footage starts (the key start, less any lead-in)
  matchStartedAt: Date
  // Time recorder.start() was called — used to calculate the trim offset
  recordingStartedAt: Date
  // Timeline events collected during the key (relative timestamps in seconds)
  timeline: TimelineEvent[]
  // name → spec string
  knownSpecs: Record<string, string>
  // Party roster
  teamComp: string[]
  // Per-player meters (Details!/Skada-style) — name → total for the key
  playerDamageDone: Record<string, number>
  playerDamageTaken: Record<string, number>
  playerHealingDone: Record<string, number>
  mythicPlus: MythicPlusInfo
}

export interface StateMachineEventMap {
  statusChanged: { status: RecorderStatus; zone?: string }
  error: { message: string }
  processingRequired: ProcessingRequiredEvent
}
