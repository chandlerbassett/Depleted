// Compares one player's key with top players of the same spec in the same dungeon at
// about the same key level (a Benchmark from Warcraft Logs). Like coachAnalysis, nothing
// here is written per spec: which spells count as cooldowns, which are core to the
// rotation, and how often they go out are all learned from the top runs.

import type { CoachData } from './coach.types'
import type { Benchmark, BenchmarkRun } from './benchmark.types'
import { detectPulls, isHealer, medianOf, fmtClock, type Finding, type Pull } from './coachAnalysis'

// Fewer top runs than this and medians are too noisy to coach from
export const MIN_RUNS = 5
// A spell counts as a cooldown top players press on cooldown when their typical gap
// between uses is at least this long…
const COOLDOWN_MIN_GAP_SECS = 20
// …barely longer than their shortest gap (defensives and utility wait for the right
// moment, so their gaps vary far more)…
const ON_COOLDOWN_REGULARITY = 1.4
// …it spends most of the key on cooldown…
const ON_COOLDOWN_UTILISATION = 0.5
// …and they press it at least this many times
const COOLDOWN_MIN_USES = 3
// Share of top runs that must use a spell before it's held up as the standard
const USED_BY_SHARE = 0.6
// Flag a cooldown when the player managed less than this share of top players' uses
const FEWER_USES_RATIO = 0.75
// Top players pressing a cooldown this soon into the first pull counts as an opener
const OPENER_SECS = 20
// …and the player pressing it this much later than they did is worth a look
const OPENER_LATE_SECS = 15
// Core rotational spells: most top runs cast them at least this often per minute
const CORE_PER_MIN = 0.5
// Flag a core spell when the player cast it at less than this share of the top rate
const CORE_LOW_RATIO = 0.4
const MAX_CAST_MIX = 6

export interface StatComparison {
  you: number
  top: number
}

// A cooldown top players press about as often as it comes back
export interface CooldownComparison {
  spellId: number
  name: string
  // Uses scaled to this key's length
  topUses: number
  yourUses: number
  // Typical time between top players' uses
  topInterval: number
  // Seconds into the first pull of the first use; null if never used
  topFirst: number
  yourFirst: number | null
  // Share of top runs that used it at all
  usedBy: number
}

export interface CastMixEntry {
  spellId: number
  name: string
  // Casts per minute
  top: number
  you: number
  usedBy: number
}

export interface TopRunLink {
  name: string
  keyLevel: number
  amount: number
  url: string
}

export interface BenchmarkComparison {
  runs: number
  levels: [number, number]
  metric: 'dps' | 'hps'
  output: StatComparison
  castsPerMin: StatComparison
  cooldowns: CooldownComparison[]
  castMix: CastMixEntry[]
  // Spells most top runs use that this player never cast at all. Usually a talent or
  // item (an on-use trinket) they don't have, which the log can't confirm, so these
  // are a side note, never a finding.
  neverUsed: Array<{ spellId: number; name: string; usedBy: number }>
  findings: Finding[]
  topRuns: TopRunLink[]
}

interface SpellStats {
  // Per run that cast it: uses, first use relative to first pull, shortest gap
  uses: number[]
  rates: number[]
  firsts: number[]
  minGaps: number[]
  medianGaps: number[]
  // Share of the key it spent on cooldown: uses × shortest gap / key length
  utilisation: number[]
}

export function compareWithTop(data: CoachData, guid: string, bench: Benchmark): BenchmarkComparison | null {
  const player = data.players.find((p) => p.guid === guid)
  if (player === undefined || bench.runs.length < MIN_RUNS) return null

  const name = (id: number): string => data.spellNames[id] ?? bench.spellNames[id] ?? `Spell ${id}`
  const metricKey = isHealer(player.specId) ? 'healing' : 'damage'
  const duration = Math.max(1, data.duration)
  const pulls = detectPulls(data)
  const firstPull = pulls[0]?.start ?? player.casts[0]?.[0] ?? 0
  const runs = bench.runs

  // --- headline numbers ----------------------------------------------------
  const total = player[metricKey].reduce((sum, v) => sum + v, 0)
  const output = { you: total / duration, top: medianOf(runs.map((r) => r.amount)) }
  const castsPerMin = {
    you: (player.casts.length / duration) * 60,
    top: medianOf(runs.map((r) => (r.casts.length / Math.max(1, r.durationSecs)) * 60))
  }

  // --- per-spell stats across top runs -------------------------------------
  const stats = new Map<number, SpellStats>()
  for (const run of runs) {
    for (const [spellId, times] of usesBySpell(run.casts)) {
      const s = stats.get(spellId) ?? { uses: [], rates: [], firsts: [], minGaps: [], medianGaps: [], utilisation: [] }
      s.uses.push(times.length)
      s.rates.push((times.length / Math.max(1, run.durationSecs)) * 60)
      s.firsts.push(times[0]! - run.firstPull)
      const gaps = gapsOf(times)
      if (gaps.length > 0) {
        const minGap = Math.min(...gaps)
        s.minGaps.push(minGap)
        s.medianGaps.push(medianOf(gaps))
        s.utilisation.push((times.length * minGap) / Math.max(1, run.durationSecs))
      }
      stats.set(spellId, s)
    }
  }

  const yours = usesBySpell(player.casts)
  const cooldowns: CooldownComparison[] = []
  const castMix: CastMixEntry[] = []
  const neverUsed: BenchmarkComparison['neverUsed'] = []
  for (const [spellId, s] of stats) {
    const usedBy = s.uses.length / runs.length
    if (usedBy < USED_BY_SHARE) continue
    const mine = yours.get(spellId) ?? []
    const minGap = medianOf(s.minGaps)
    const typicalGap = medianOf(s.medianGaps)
    const isCooldown =
      s.minGaps.length > 0 &&
      medianOf(s.uses) >= COOLDOWN_MIN_USES &&
      typicalGap >= COOLDOWN_MIN_GAP_SECS &&
      typicalGap <= minGap * ON_COOLDOWN_REGULARITY &&
      medianOf(s.utilisation) >= ON_COOLDOWN_UTILISATION

    if (mine.length === 0) {
      // Only note the ones that matter: cooldowns and spells cast often enough to count
      if (isCooldown || medianOf(s.rates) >= CORE_PER_MIN) neverUsed.push({ spellId, name: name(spellId), usedBy })
    } else if (isCooldown) {
      // Scale top players' uses to this key's length, so a slower key expects more
      const topRate = medianOf(s.rates)
      cooldowns.push({
        spellId,
        name: name(spellId),
        topUses: Math.round(((topRate * duration) / 60) * 10) / 10,
        yourUses: mine.length,
        topInterval: typicalGap,
        topFirst: Math.max(0, medianOf(s.firsts)),
        yourFirst: mine.length > 0 ? Math.max(0, mine[0]! - firstPull) : null,
        usedBy
      })
    } else {
      const top = medianOf(s.rates)
      const you = (mine.length / duration) * 60
      if (top >= CORE_PER_MIN && you < top * CORE_LOW_RATIO) {
        castMix.push({ spellId, name: name(spellId), top, you, usedBy })
      }
    }
  }
  cooldowns.sort((a, b) => b.topUses - b.yourUses - (a.topUses - a.yourUses) || a.name.localeCompare(b.name))
  castMix.sort((a, b) => b.top - b.you - (a.top - a.you))
  neverUsed.sort((a, b) => b.usedBy - a.usedBy || a.name.localeCompare(b.name))

  return {
    runs: runs.length,
    levels: [Math.min(...runs.map((r) => r.keyLevel)), Math.max(...runs.map((r) => r.keyLevel))],
    metric: bench.metric,
    output,
    castsPerMin,
    cooldowns,
    castMix: castMix.slice(0, MAX_CAST_MIX),
    neverUsed,
    findings: buildFindings(cooldowns, yours, pulls, firstPull, duration),
    topRuns: [...runs]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3)
      .map((r) => ({ name: r.name, keyLevel: r.keyLevel, amount: r.amount, url: runUrl(r) }))
  }
}

export function runUrl(run: BenchmarkRun): string {
  return `https://www.warcraftlogs.com/reports/${run.reportCode}#fight=${run.fightId}`
}

// ---------------------------------------------------------------------------

function buildFindings(
  cooldowns: CooldownComparison[],
  yours: Map<number, number[]>,
  pulls: Pull[],
  firstPull: number,
  duration: number
): Finding[] {
  const findings: Finding[] = []
  const most = (cd: CooldownComparison): string => (cd.usedBy >= 0.9 ? 'Top players' : 'Most top players')

  // Cooldowns never pressed aren't here: see neverUsed
  for (const cd of cooldowns) {
    const expected = Math.round(cd.topUses)
    const mine = yours.get(cd.spellId) ?? []

    if (mine.length < cd.topUses * FEWER_USES_RATIO && expected - mine.length >= 2) {
      const gap = longestWait(mine, pulls, firstPull, duration)
      findings.push({
        kind: 'benchmark',
        // Where it would have been ready again
        at: gap.readyAt(cd.topInterval),
        title: `${cd.name}: ${mine.length} uses, top players ~${expected}`,
        detail: `${most(cd)} pressed it about every ${fmtGap(cd.topInterval)}. Your longest wait was ${fmtGap(gap.secs)} of fighting, from ${fmtClock(gap.from)}.`,
        weight: (expected - mine.length) * 10
      })
    }

    if (cd.topFirst <= OPENER_SECS && cd.yourFirst !== null && cd.yourFirst - cd.topFirst >= OPENER_LATE_SECS) {
      findings.push({
        kind: 'benchmark',
        at: firstPull,
        title: `Late ${cd.name} in the opener`,
        detail: `${most(cd)} press it ${Math.round(cd.topFirst)}s into the first pull. You pressed it ${Math.round(cd.yourFirst)}s in.`,
        weight: 20 + (cd.yourFirst - cd.topFirst) / 3
      })
    }
  }

  return findings.sort((a, b) => b.weight - a.weight)
}

function usesBySpell(casts: Array<[number, number]>): Map<number, number[]> {
  const map = new Map<number, number[]>()
  for (const [t, id] of casts) {
    const times = map.get(id) ?? []
    times.push(t)
    map.set(id, times)
  }
  for (const times of map.values()) times.sort((a, b) => a - b)
  return map
}

function gapsOf(times: number[]): number[] {
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!)
  return gaps
}

// Longest stretch of pull time without a use, counting from the first pull to the end
// of the key. Time between pulls doesn't count: nobody presses cooldowns walking.
function longestWait(
  uses: number[],
  pulls: Pull[],
  firstPull: number,
  duration: number
): { from: number; secs: number; readyAt: (interval: number) => number } {
  const fighting = pulls.length > 0 ? pulls : [{ start: firstPull, end: duration }]
  const points = [firstPull, ...uses.filter((t) => t > firstPull), duration]
  let from = firstPull
  let secs = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const inPulls = fighting.reduce((sum, p) => sum + Math.max(0, Math.min(p.end, b) - Math.max(p.start, a)), 0)
    if (inPulls > secs) {
      from = a
      secs = inPulls
    }
  }
  // The first moment of fighting once the cooldown was back
  const readyAt = (interval: number): number => {
    if (from === firstPull) return firstPull
    const ready = from + interval
    const pull = fighting.find((p) => p.end > ready)
    return pull === undefined ? ready : Math.max(ready, pull.start)
  }
  return { from, secs, readyAt }
}

// 45 → "45s", 130 → "2:10"
function fmtGap(secs: number): string {
  return secs < 90 ? `${Math.round(secs)}s` : fmtClock(secs)
}
