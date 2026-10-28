// Events the recording state machine emits, and the payload StorageManager turns into a
// stored recording.

import type { CoachData } from '@shared/coach.types'
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
  // The player recording (Name-Realm and class/spec names), empty strings when unknown.
  // Missing on recovered recordings.
  player?: { name: string; class: string; spec: string }
  // Per-player meters (Details!/Skada-style) — name → total for the key
  playerDamageDone: Record<string, number>
  playerDamageTaken: Record<string, number>
  playerHealingDone: Record<string, number>
  mythicPlus: MythicPlusInfo
  // Per-player casts, buffs and per-second damage/healing — saved as coach.json
  coach?: CoachData
}

// Written next to a raw recording (<raw>.json) once a key's recording is running, so a
// recording left behind by a crash or force-quit can be saved on the next launch.
export interface RawRecordingInfo {
  zoneName: string
  instanceId: number
  challengeModeId: number
  keystoneLevel: number
  affixIds: number[]
  // Key start (log time) and when the recorder came up (wall clock), ISO strings
  keyStartedAt: string
  recordingStartedAt: string
  preRollSecs: number
}

export function rawInfoPath(rawPath: string): string {
  return `${rawPath}.json`
}

export interface StateMachineEventMap {
  statusChanged: { status: RecorderStatus; zone?: string }
  error: { message: string }
  processingRequired: ProcessingRequiredEvent
}
