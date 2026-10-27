// Turns a recording's coach data into a review of one player's key: pulls, downtime,
// long cooldowns, deaths, and a ranked list of moments worth watching. Works the same
// for every class and spec: nothing here is hand-written per spec. "Good" will come
// from top players' logs later; for now everything is measured against the player's
// own key.

import type { CoachData, CoachPlayer } from './coach.types'
import { WOW_SPEC_ID_MAP } from './constants'

// Party damage gaps up to this long stay inside one pull
const PULL_MERGE_GAP_SECS = 5
const PULL_MIN_SECS = 10
// No cast for this long inside a pull counts as downtime. Hard casts and channels
// rarely leave more than ~3 s between logged casts.
export const DOWNTIME_MIN_SECS = 4
// A spell counts as a long cooldown when it puts a buff on the caster and is never
// recast sooner than this
const COOLDOWN_MIN_GAP_SECS = 40
// A cooldown sitting ready for this much pull time before it was pressed is worth
// a look
const HELD_MIN_SECS = 20
// A Hunter "death" followed by a cast this soon was Feign Death
const FEIGN_DEATH_SECS = 5
const DEATH_LOOKBACK_SECS = 10
// A cooldown counts as a throughput cooldown when the player's output while its buff
// is up beats the BOOST_BASELINE_SECS either side of it by this much. Comparing with
// the moments around it, not the key average, keeps defensives out: they get pressed
// on big pulls, which are high-output anyway. The rest (defensives, movement, utility)
// aren't judged for sitting unused.
const THROUGHPUT_BOOST = 1.8
const BOOST_BASELINE_SECS = 20
// Low-output stretches: fixed windows where the player's share of party damage drops
// well below their share for the whole key. Keys are chain-pulled, so pulls are too
// long to compare with each other.
const STRETCH_SECS = 30
const LOW_SHARE_RATIO = 0.6

export interface Pull {
  start: number
  end: number
}

export interface PullStat extends Pull {
  // Damage, or healing for healers
  amount: number
  perSec: number
  // 1 = top of the party on this pull for the same metric
  rank: number
  partySize: number
}

export interface DowntimeGap {
  start: number
  end: number
  secs: number
}

export interface HeldWindow {
  // First moment in a pull the cooldown was (likely) ready
  readyAt: number
  // When it was finally pressed, null if never again
  usedAt: number | null
  // Pull time it sat ready
  secs: number
}

export interface CooldownReview {
  spellId: number
  name: string
  // Output with its buff up vs the player's pull average. Throughput cooldowns are
  // the ones flagged for sitting ready.
  throughput: boolean
  boost: number
  uses: number[]
  // Shortest gap between two uses — a stand-in for the cooldown, which the log
  // doesn't record. null when it was only used once.
  estCooldown: number | null
  // Uses the key had room for at that cooldown
  possibleUses: number | null
  held: HeldWindow[]
  heldSecs: number
}

export interface DeathReview {
  at: number
  castsBefore: Array<{ at: number; spellId: number; name: string }>
  // Defensive and utility cooldowns that look ready when the player died
  readyCooldowns: string[]
}

// 'benchmark' findings come from comparing with top players (coachBenchmark.ts)
export type FindingKind = 'death' | 'downtime' | 'cooldown' | 'low-output' | 'benchmark'

export interface LowStretch {
  start: number
  end: number
  // Player's share of party damage in this stretch and over the whole key
  share: number
  keyShare: number
}

export interface Finding {
  kind: FindingKind
  // Where to seek the video
  at: number
  title: string
  detail: string
  // Larger = more worth watching
  weight: number
}

export interface PlayerReview {
  guid: string
  name: string
  specId: number | null
  metric: 'damage' | 'healing'
  // Share of pull time spent casting (1 - downtime / pull time)
  activePct: number
  castsPerMin: number
  pullSecs: number
  pulls: PullStat[]
  lowStretches: LowStretch[]
  downtime: DowntimeGap[]
  downtimeSecs: number
  cooldowns: CooldownReview[]
  deaths: DeathReview[]
  findings: Finding[]
}

// ---------------------------------------------------------------------------

export function isHealer(specId: number | null): boolean {
  return specId !== null && WOW_SPEC_ID_MAP[specId]?.isHealer === true
}

// Pulls = stretches where the party is doing damage
export function detectPulls(data: CoachData): Pull[] {
  const seconds = Math.ceil(data.duration)
  const pulls: Pull[] = []
  let open: Pull | null = null
  for (let s = 0; s < seconds; s++) {
    let total = 0
    for (const p of data.players) total += p.damage[s] ?? 0
    if (total <= 0) continue
    if (open !== null && s - open.end <= PULL_MERGE_GAP_SECS) {
      open.end = s + 1
    } else {
      if (open !== null) pulls.push(open)
      open = { start: s, end: s + 1 }
    }
  }
  if (open !== null) pulls.push(open)
  return pulls.filter((p) => p.end - p.start >= PULL_MIN_SECS)
}

export function reviewPlayer(data: CoachData, guid: string): PlayerReview | null {
  const player = data.players.find((p) => p.guid === guid)
  if (player === undefined) return null

  const name = (id: number): string => data.spellNames[id] ?? `Spell ${id}`
  const metric = isHealer(player.specId) ? 'healing' : 'damage'
  const pulls = detectPulls(data)
  const pullSecs = pulls.reduce((sum, p) => sum + (p.end - p.start), 0)

  const activity = [...player.casts.map(([t]) => t), ...player.castStarts].sort((a, b) => a - b)
  const isHunter = player.specId !== null && WOW_SPEC_ID_MAP[player.specId]?.class === 'Hunter'
  const deaths = isHunter ? withoutFeigns(player.deaths, activity) : player.deaths
  const deadSpans = deaths.map((at) => ({ start: at, end: activity.find((t) => t > at) ?? data.duration }))

  const downtime = findDowntime(pulls, activity, deadSpans)
  const downtimeSecs = downtime.reduce((sum, g) => sum + g.secs, 0)
  const castsInPulls = player.casts.filter(([t]) => pulls.some((p) => t >= p.start && t <= p.end)).length

  const cooldowns = reviewCooldowns(player, pulls, data.duration, name, metric)
  const pullStats = reviewPulls(data, player, pulls, metric)
  const lowStretches = metric === 'damage' ? findLowStretches(data, player, deadSpans) : []

  const deathReviews: DeathReview[] = deaths.map((at) => ({
    at,
    castsBefore: player.casts
      .filter(([t]) => t <= at && t >= at - DEATH_LOOKBACK_SECS)
      .map(([t, id]) => ({ at: t, spellId: id, name: name(id) })),
    readyCooldowns: cooldowns.filter((cd) => !cd.throughput && looksReady(cd, at)).map((cd) => cd.name)
  }))

  return {
    guid: player.guid,
    name: player.name,
    specId: player.specId,
    metric,
    activePct: pullSecs > 0 ? Math.max(0, 1 - downtimeSecs / pullSecs) : 0,
    castsPerMin: pullSecs > 0 ? (castsInPulls / pullSecs) * 60 : 0,
    pullSecs,
    pulls: pullStats,
    lowStretches,
    downtime,
    downtimeSecs,
    cooldowns,
    deaths: deathReviews,
    // Healers save cooldowns for when the damage comes, so ready-but-unused isn't a
    // mistake for them: their cooldown tracks still show it, the moments list doesn't
    findings: buildFindings(deathReviews, downtime, metric === 'healing' ? [] : cooldowns, lowStretches)
  }
}

// ---------------------------------------------------------------------------

// The log can't tell Feign Death from dying; casting again within seconds gives it away
function withoutFeigns(deaths: number[], activity: number[]): number[] {
  return deaths.filter((at) => {
    const next = activity.find((t) => t > at)
    return next === undefined || next - at > FEIGN_DEATH_SECS
  })
}

function findDowntime(pulls: Pull[], activity: number[], deadSpans: Pull[]): DowntimeGap[] {
  const gaps: DowntimeGap[] = []
  for (const pull of pulls) {
    const points = [pull.start, ...activity.filter((t) => t > pull.start && t < pull.end), pull.end]
    for (let i = 1; i < points.length; i++) {
      const start = points[i - 1]!
      const end = points[i]!
      if (end - start < DOWNTIME_MIN_SECS) continue
      if (deadSpans.some((d) => d.start < end && d.end > start)) continue
      gaps.push({ start, end, secs: round1(end - start) })
    }
  }
  return gaps
}

function reviewCooldowns(
  player: CoachPlayer,
  pulls: Pull[],
  duration: number,
  name: (id: number) => string,
  metric: 'damage' | 'healing'
): CooldownReview[] {
  const output = player[metric]
  const usesBySpell = new Map<number, number[]>()
  for (const [t, id] of player.casts) {
    const uses = usesBySpell.get(id) ?? []
    uses.push(t)
    usesBySpell.set(id, uses)
  }
  const buffIds = new Set(player.buffs.map(([id]) => id))
  const buffNames = new Set(player.buffs.map(([id]) => name(id)))
  const firstPull = pulls[0]?.start ?? 0

  const reviews: CooldownReview[] = []
  for (const [spellId, uses] of usesBySpell) {
    if (!buffIds.has(spellId) && !buffNames.has(name(spellId))) continue
    uses.sort((a, b) => a - b)
    let minGap = Infinity
    for (let i = 1; i < uses.length; i++) minGap = Math.min(minGap, uses[i]! - uses[i - 1]!)
    if (uses.length > 1 && minGap < COOLDOWN_MIN_GAP_SECS) continue

    const estCooldown = uses.length > 1 ? round1(minGap) : null
    const boost = buffBoost(output, player.buffs.filter(([id]) => id === spellId || name(id) === name(spellId)))
    const throughput = boost >= THROUGHPUT_BOOST

    const held: HeldWindow[] = []
    if (estCooldown !== null && throughput) {
      for (let i = 0; i <= uses.length; i++) {
        const readyFrom = i === 0 ? firstPull : uses[i - 1]! + estCooldown
        const usedAt = uses[i] ?? null
        const until = usedAt ?? duration
        const window = overlapWithPulls(pulls, readyFrom, until)
        if (window !== null && window.secs >= HELD_MIN_SECS) held.push({ readyAt: window.first, usedAt, secs: round1(window.secs) })
      }
    }

    reviews.push({
      spellId,
      name: name(spellId),
      throughput,
      boost: Math.round(boost * 100) / 100,
      uses,
      estCooldown,
      possibleUses: estCooldown !== null ? Math.floor((duration - firstPull) / estCooldown) + 1 : null,
      held,
      heldSecs: round1(held.reduce((sum, h) => sum + h.secs, 0))
    })
  }
  return reviews.sort(
    (a, b) => Number(b.throughput) - Number(a.throughput) || b.heldSecs - a.heldSecs || a.name.localeCompare(b.name)
  )
}

// Output while the buff was up vs the seconds just before and after it
function buffBoost(output: number[], buffs: Array<[number, number, number]>): number {
  let during = 0
  let around = 0
  for (const [, start, end] of buffs) {
    const s = Math.floor(start)
    const e = Math.ceil(end)
    during += averageOver(output, [{ start: s, end: e }])
    around += averageOver(output, [
      { start: Math.max(0, s - BOOST_BASELINE_SECS), end: s },
      { start: e, end: e + BOOST_BASELINE_SECS }
    ])
  }
  return around > 0 ? during / around : 0
}

// Mean per-second output across the given spans
function averageOver(perSecond: number[], spans: Pull[]): number {
  let total = 0
  let secs = 0
  for (const span of spans) {
    for (let s = span.start; s < span.end; s++) {
      total += perSecond[s] ?? 0
      secs++
    }
  }
  return secs > 0 ? total / secs : 0
}

function findLowStretches(data: CoachData, player: CoachPlayer, deadSpans: Pull[]): LowStretch[] {
  const seconds = Math.ceil(data.duration)
  const partyTotal = (from: number, to: number): number => {
    let total = 0
    for (const p of data.players) for (let s = from; s < to; s++) total += p.damage[s] ?? 0
    return total
  }
  const own = (from: number, to: number): number => {
    let total = 0
    for (let s = from; s < to; s++) total += player.damage[s] ?? 0
    return total
  }
  const keyParty = partyTotal(0, seconds)
  if (keyParty <= 0) return []
  const keyShare = own(0, seconds) / keyParty

  // Only judge stretches where the party was properly fighting
  const windows: Array<{ start: number; end: number; party: number }> = []
  for (let start = 0; start + STRETCH_SECS <= seconds; start += STRETCH_SECS) {
    windows.push({ start, end: start + STRETCH_SECS, party: partyTotal(start, start + STRETCH_SECS) })
  }
  const busy = medianOf(windows.map((w) => w.party).filter((v) => v > 0))

  const low: LowStretch[] = []
  for (const w of windows) {
    if (w.party < busy * 0.5) continue
    if (deadSpans.some((d) => d.start < w.end && d.end > w.start)) continue
    const share = own(w.start, w.end) / w.party
    if (share < keyShare * LOW_SHARE_RATIO) low.push({ start: w.start, end: w.end, share, keyShare })
  }
  return low
}

// Pull time inside [from, to], and the first pull moment in it
function overlapWithPulls(pulls: Pull[], from: number, to: number): { first: number; secs: number } | null {
  let first: number | null = null
  let secs = 0
  for (const p of pulls) {
    const s = Math.max(p.start, from)
    const e = Math.min(p.end, to)
    if (e <= s) continue
    first ??= s
    secs += e - s
  }
  return first === null ? null : { first, secs }
}

function looksReady(cd: CooldownReview, at: number): boolean {
  const lastBefore = [...cd.uses].reverse().find((t) => t <= at)
  if (cd.estCooldown === null) return lastBefore === undefined
  return lastBefore === undefined || at - lastBefore >= cd.estCooldown
}

function reviewPulls(data: CoachData, player: CoachPlayer, pulls: Pull[], metric: 'damage' | 'healing'): PullStat[] {
  const sum = (arr: number[], p: Pull): number => {
    let total = 0
    for (let s = p.start; s < p.end; s++) total += arr[s] ?? 0
    return total
  }
  return pulls.map((pull) => {
    const amounts = data.players.map((p) => ({ guid: p.guid, amount: sum(p[metric], pull) }))
    const amount = amounts.find((a) => a.guid === player.guid)?.amount ?? 0
    return {
      ...pull,
      amount,
      perSec: amount / (pull.end - pull.start),
      rank: 1 + amounts.filter((a) => a.amount > amount).length,
      partySize: amounts.length
    }
  })
}

function buildFindings(
  deaths: DeathReview[],
  downtime: DowntimeGap[],
  cooldowns: CooldownReview[],
  lowStretches: LowStretch[]
): Finding[] {
  const findings: Finding[] = []

  for (const d of deaths) {
    findings.push({
      kind: 'death',
      at: d.at - 5,
      title: 'Died',
      detail:
        d.readyCooldowns.length > 0
          ? `Looked ready: ${d.readyCooldowns.join(', ')}`
          : 'No defensive cooldowns looked ready',
      weight: 100
    })
  }

  for (const g of downtime) {
    findings.push({
      kind: 'downtime',
      at: g.start,
      title: `${Math.round(g.secs)}s with no casts`,
      detail: 'Mid-pull with nothing cast. Moving, out of range, or waiting on something?',
      weight: g.secs * 3
    })
  }

  // Cooldowns pressed together (Avenging Wrath + Execution Sentence) sit ready
  // together: one finding per window, not one per spell
  const windows = new Map<string, { names: string[]; held: HeldWindow }>()
  for (const cd of cooldowns) {
    for (const h of cd.held) {
      const key = `${Math.round(h.readyAt / 3)}:${h.usedAt === null ? '-' : Math.round(h.usedAt)}`
      const w = windows.get(key)
      if (w === undefined) windows.set(key, { names: [cd.name], held: h })
      else w.names.push(cd.name)
    }
  }
  for (const { names, held: h } of windows.values()) {
    findings.push({
      kind: 'cooldown',
      at: h.readyAt,
      title: `${names.join(' + ')} sat ready for ${Math.round(h.secs)}s`,
      detail:
        h.usedAt !== null
          ? `Likely ready here, pressed at ${fmtClock(h.usedAt)}`
          : 'Likely ready here and not pressed again',
      weight: h.secs
    })
  }

  for (const w of lowStretches) {
    findings.push({
      kind: 'low-output',
      at: w.start,
      title: `Low damage share (${Math.round(w.share * 100)}%)`,
      detail: `${fmtClock(w.start)}–${fmtClock(w.end)}: ${Math.round(w.share * 100)}% of party damage, ${Math.round(w.keyShare * 100)}% over the whole key`,
      weight: (1 - w.share / w.keyShare) * 60
    })
  }

  return findings.sort((a, b) => b.weight - a.weight)
}

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
