// A key's recap (its biggest issues) and trends across a player's keys (issues that
// keep coming back, and whether they're getting better). Built only from the review of
// the player's own key and the comparison with top players, so it works the same for
// every class and spec.

import { fmtClock, type Finding, type PlayerReview } from './coachAnalysis'
import type { BenchmarkComparison } from './coachBenchmark'

// Issues the recap leads with
export const RECAP_ISSUES = 3
const MAX_MOMENTS = 5
// Trends: an issue in at least this many keys is repeating
const REPEAT_MIN_KEYS = 2
// Fewer keys than this and there's no telling which way an issue is going
const TREND_MIN_KEYS = 4
// Recent keys this much better (or worse) than earlier ones count as a change
const TREND_CHANGE = 0.3
// "Also in N of your last M keys" counts this far back
export const RECENT_KEYS = 10

export interface Moment {
  at: number
  title: string
}

export interface KeyIssue {
  // Stable across keys: see Finding.issue
  issue: string
  // Names the mistake without this key's numbers, e.g. "Trueshot used less than top players"
  label: string
  // This key's numbers, e.g. "4 uses, top players ~7"
  summary: string
  // How bad it was, in units that compare across keys of the same issue (higher = worse)
  severity: number
  // Ranks issues within the key
  weight: number
  // From comparing with top players
  fromTop: boolean
  moments: Moment[]
}

export interface KeyRecap {
  // Output as a share of the top runs' median, null without a comparison
  outputPct: number | null
  headline: string
  issues: KeyIssue[]
}

export function recapKey(review: PlayerReview, comparison: BenchmarkComparison | null): KeyRecap {
  const pullSecs = Math.max(1, review.pullSecs)
  const byIssue = groupFindings([...review.findings, ...(comparison?.findings ?? [])])
  const issues: KeyIssue[] = []

  for (const [issue, findings] of byIssue) {
    const [what, idText] = issue.split(':')
    const spellId = Number(idText)
    const moments = findings
      .slice(0, MAX_MOMENTS)
      .map((f) => ({ at: f.at, title: f.title }))
      .sort((a, b) => a.at - b.at)
    const weight = findings.reduce((sum, f) => sum + f.weight, 0)
    const base = { issue, weight, moments, fromTop: findings[0]!.kind === 'benchmark' }

    switch (what) {
      case 'death':
        issues.push({
          ...base,
          label: 'Deaths',
          summary: `${findings.length} death${findings.length === 1 ? '' : 's'}`,
          severity: findings.length
        })
        break
      case 'downtime': {
        const secs = review.downtime.reduce((sum, g) => sum + g.secs, 0)
        issues.push({
          ...base,
          label: 'Idle in combat',
          summary: `${Math.round(secs)}s with no casts over ${findings.length} gap${findings.length === 1 ? '' : 's'} mid-pull`,
          // Share of fighting spent idle, so long and short keys compare
          severity: (secs / pullSecs) * 100
        })
        break
      }
      case 'held': {
        // Cooldowns pressed together share a finding; the review has each one's own time
        const cd = review.cooldowns.find((c) => c.spellId === spellId)
        if (cd === undefined) break
        issues.push({
          ...base,
          label: `${cd.name} sat ready`,
          summary: `Ready but unused for ${Math.round(cd.heldSecs)}s of fighting`,
          severity: (cd.heldSecs / pullSecs) * 100,
          moments: cd.held.slice(0, MAX_MOMENTS).map((h) => ({
            at: h.readyAt,
            title: `Ready from ${fmtClock(h.readyAt)}, ${h.usedAt !== null ? `pressed at ${fmtClock(h.usedAt)}` : 'not pressed again'}`
          }))
        })
        break
      }
      case 'low-output':
        issues.push({
          ...base,
          label: 'Low damage share',
          summary: `${findings.length} stretch${findings.length === 1 ? '' : 'es'} well below your share of party damage`,
          severity: findings.length
        })
        break
      case 'cd-uses': {
        const cd = comparison?.cooldowns.find((c) => c.spellId === spellId)
        if (cd === undefined) break
        issues.push({
          ...base,
          label: `${cd.name} used less than top players`,
          summary: `${cd.yourUses} uses, top players ~${Math.round(cd.topUses)}`,
          severity: Math.max(0, 1 - cd.yourUses / Math.max(1, cd.topUses)) * 100
        })
        break
      }
      case 'opener': {
        const cd = comparison?.cooldowns.find((c) => c.spellId === spellId)
        if (cd === undefined || cd.yourFirst === null) break
        issues.push({
          ...base,
          label: `Late ${cd.name} in the opener`,
          summary:
            cd.yourFirstAfterPull === true
              ? `Not pressed until after the first pull, top players ${Math.round(cd.topFirst)}s in`
              : `Pressed ${Math.round(cd.yourFirst)}s into the first pull, top players ${Math.round(cd.topFirst)}s`,
          severity: cd.yourFirst - cd.topFirst
        })
        break
      }
      case 'cast-low': {
        const m = comparison?.castMix.find((c) => c.spellId === spellId)
        if (m === undefined) break
        issues.push({
          ...base,
          label: `${m.name} cast less than top players`,
          summary: `${m.you.toFixed(1)} a minute, top players ${m.top.toFixed(1)}`,
          severity: Math.max(0, 1 - m.you / Math.max(0.01, m.top)) * 100
        })
        break
      }
      case 'never-used': {
        const n = comparison?.neverUsed.find((c) => c.spellId === spellId)
        if (n === undefined) break
        issues.push({
          ...base,
          label: `${n.name} never used`,
          summary: findings[0]!.detail,
          severity: 1
        })
        break
      }
    }
  }
  issues.sort((a, b) => b.weight - a.weight)

  return { outputPct: outputPct(comparison), headline: headline(review, comparison), issues }
}

function groupFindings(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>()
  for (const f of [...findings].sort((a, b) => b.weight - a.weight)) {
    const list = map.get(f.issue) ?? []
    list.push(f)
    map.set(f.issue, list)
  }
  return map
}

function outputPct(comparison: BenchmarkComparison | null): number | null {
  if (comparison === null || comparison.output.top <= 0) return null
  return (comparison.output.you / comparison.output.top) * 100
}

function headline(review: PlayerReview, comparison: BenchmarkComparison | null): string {
  const parts: string[] = []
  const pct = outputPct(comparison)
  if (comparison !== null && pct !== null) {
    parts.push(`${comparison.metric === 'hps' ? 'HPS' : 'DPS'} at ${Math.round(pct)}% of the top runs.`)
  }
  const deaths = review.deaths.length
  parts.push(
    `Active ${Math.round(review.activePct * 100)}% of the fighting, ${Math.round(review.downtimeSecs)}s idle, ` +
      `${deaths === 0 ? 'no deaths' : `${deaths} death${deaths === 1 ? '' : 's'}`}.`
  )
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Trends

// One key, boiled down to what trends need. Built in the main process for every
// recording of a character, so it stays small.
export interface KeySummary {
  recordingId: string
  date: string
  dungeon: string
  keyLevel: number
  playerName: string
  specId: number | null
  // Compared with top players
  benchmarked: boolean
  outputPct: number | null
  activePct: number
  deaths: number
  // Share of fighting that throughput cooldowns sat ready
  heldPct: number
  issues: Array<Omit<KeyIssue, 'moments'> & { at: number }>
}

export interface KeyMeta {
  recordingId: string
  date: string
  dungeon: string
  keyLevel: number
}

export function summarizeKey(meta: KeyMeta, review: PlayerReview, comparison: BenchmarkComparison | null): KeySummary {
  const recap = recapKey(review, comparison)
  const throughputHeld = review.cooldowns.filter((cd) => cd.throughput).reduce((sum, cd) => sum + cd.heldSecs, 0)
  return {
    ...meta,
    playerName: review.name,
    specId: review.specId,
    benchmarked: comparison !== null,
    outputPct: recap.outputPct,
    activePct: review.activePct * 100,
    deaths: review.deaths.length,
    heldPct: review.metric === 'healing' ? 0 : (throughputHeld / Math.max(1, review.pullSecs)) * 100,
    issues: recap.issues.map((i) => ({
      issue: i.issue,
      label: i.label,
      summary: i.summary,
      severity: i.severity,
      fromTop: i.fromTop,
      weight: i.weight,
      at: i.moments[0]?.at ?? 0
    }))
  }
}

export type TrendDirection = 'improving' | 'steady' | 'worse'

export interface TrendKey {
  recordingId: string
  date: string
  dungeon: string
  keyLevel: number
  summary: string
  severity: number
  at: number
}

export interface TrendIssue {
  issue: string
  label: string
  fromTop: boolean
  // Keys it came up in, newest first
  keys: TrendKey[]
  // Keys it could have come up in (ones compared with top players, for top-player issues)
  of: number
  // Recent keys against earlier ones; null with too few keys to tell
  direction: TrendDirection | null
  // In none of the last few keys after coming up before
  lately: 'clear' | 'present'
}

export interface Trends {
  // Oldest first
  keys: KeySummary[]
  issues: TrendIssue[]
}

// Keys must be one character and spec
export function buildTrends(summaries: KeySummary[]): Trends {
  const keys = [...summaries].sort((a, b) => a.date.localeCompare(b.date))
  const found = new Map<string, { label: string; fromTop: boolean; hits: Map<string, KeySummary['issues'][number]> }>()
  for (const key of keys) {
    for (const i of key.issues) {
      const entry = found.get(i.issue) ?? { label: i.label, fromTop: i.fromTop, hits: new Map() }
      // Newest key's wording wins (spell names can change with a patch)
      entry.label = i.label
      entry.hits.set(key.recordingId, i)
      found.set(i.issue, entry)
    }
  }

  const issues: TrendIssue[] = []
  for (const [issue, { label, fromTop, hits }] of found) {
    if (hits.size < REPEAT_MIN_KEYS) continue
    const eligible = fromTop ? keys.filter((k) => k.benchmarked) : keys
    const severities = eligible.map((k) => hits.get(k.recordingId)?.severity ?? 0)
    const recentCount = Math.min(3, eligible.length)
    const recent = eligible.slice(-recentCount)
    issues.push({
      issue,
      label,
      fromTop,
      keys: eligible
        .filter((k) => hits.has(k.recordingId))
        .reverse()
        .map((k) => {
          const hit = hits.get(k.recordingId)!
          return {
            recordingId: k.recordingId,
            date: k.date,
            dungeon: k.dungeon,
            keyLevel: k.keyLevel,
            summary: hit.summary,
            severity: hit.severity,
            at: hit.at
          }
        }),
      of: eligible.length,
      direction: direction(severities),
      lately: recent.some((k) => hits.has(k.recordingId)) ? 'present' : 'clear'
    })
  }

  // Most often first, then the ones that cost the most
  const weightOf = (i: TrendIssue): number =>
    i.keys.reduce((sum, k) => sum + (found.get(i.issue)!.hits.get(k.recordingId)?.weight ?? 0), 0)
  issues.sort((a, b) => b.keys.length / b.of - a.keys.length / a.of || weightOf(b) - weightOf(a))
  return { keys, issues }
}

// Earlier half of the keys against the recent half; a key without the issue counts as 0
export function direction(severities: number[]): TrendDirection | null {
  if (severities.length < TREND_MIN_KEYS) return null
  const half = Math.floor(severities.length / 2)
  const earlier = mean(severities.slice(0, severities.length - half))
  const recent = mean(severities.slice(-half))
  if (earlier === 0 && recent === 0) return 'steady'
  if (recent <= earlier * (1 - TREND_CHANGE)) return 'improving'
  if (recent >= earlier * (1 + TREND_CHANGE)) return 'worse'
  return 'steady'
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length
}

// How many of the player's recent other keys an issue also came up in, for the recap
export function repeatsIn(
  issue: string,
  fromTop: boolean,
  others: KeySummary[],
  beforeDate: string
): { count: number; of: number } | null {
  const earlier = others
    .filter((k) => k.date < beforeDate && (!fromTop || k.benchmarked))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, RECENT_KEYS)
  if (earlier.length === 0) return null
  const count = earlier.filter((k) => k.issues.some((i) => i.issue === issue)).length
  return count === 0 ? null : { count, of: earlier.length }
}

// Coach names are Name-Realm; the addon may report just the name
export function isCharacter(coachName: string, name: string): boolean {
  return coachName === name || coachName.startsWith(`${name}-`)
}
