// Per-player data the coach reads, saved as coach.json beside a recording's
// metadata.json. Times are video seconds, like TimelineEvent.timestamp.

export interface CoachPlayer {
  guid: string
  name: string
  // WoW spec ID from COMBATANT_INFO, null if it never logged
  specId: number | null
  // Talent picks: [nodeId, entryId, rank]
  talents: Array<[number, number, number]>
  // Successful casts: [secs, spellId]
  casts: Array<[number, number]>
  // Times a hard cast began (SPELL_CAST_START). Counts as activity for downtime, so
  // a 3 s cast isn't read as 3 s of doing nothing.
  castStarts: number[]
  // Buffs the player put on themselves: [spellId, start, end]
  buffs: Array<[number, number, number]>
  // Damage and effective healing per second of video (index = second)
  damage: number[]
  healing: number[]
  // Video seconds of each death
  deaths: number[]
}

export interface CoachData {
  version: 1
  // Video length in seconds
  duration: number
  // spellId → name, for every spell in casts and buffs
  spellNames: Record<number, string>
  players: CoachPlayer[]
}
