// A key's recap (its biggest issues) and trends across a player's keys (issues that
// keep coming back, and whether they're getting better). Built only from the review of
// the player's own key and the comparison with top players, so it works the same for
// every class and spec.

import { fmtClock, type Finding, type PlayerReview } from './coachAnalysis'
import type { BenchmarkComparison } from './coachBenchmark'
import type { CoachData } from './coach.types'

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
// Boss trends: a fight in at least this many keys gets a row
const BOSS_MIN_KEYS = 2
// Flag a boss when the player's share of the party's output there is this much below
// their share over the whole key, or they cast this many points less of the time
const BOSS_SHARE_DROP = 0.85
const BOSS_ACTIVE_DROP = 8

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
  // Cooldown uses as a share of what top players of the spec fit in (capped per
  // cooldown), null when not compared with top players. The healer stand-in for
  // heldPct: healers hold cooldowns for the damage, so "sat ready" says little.
  cdUsePct: number | null
  issues: Array<Omit<KeyIssue, 'moments'> & { at: number }>
  bosses: BossSummary[]
}

export interface KeyMeta {
  recordingId: string
  date: string
  dungeon: string
  keyLevel: number
}

export function summarizeKey(
  meta: KeyMeta,
  review: PlayerReview,
  comparison: BenchmarkComparison | null,
  bosses: BossSummary[] = []
): KeySummary {
  const recap = recapKey(review, comparison)
  const throughputHeld = review.cooldowns.filter((cd) => cd.throughput).reduce((sum, cd) => sum + cd.heldSecs, 0)
  const topUses = comparison?.cooldowns.reduce((sum, cd) => sum + cd.topUses, 0) ?? 0
  const usedOfTop = comparison?.cooldowns.reduce((sum, cd) => sum + Math.min(cd.yourUses, cd.topUses), 0) ?? 0
  return {
    ...meta,
    playerName: review.name,
    specId: review.specId,
    benchmarked: comparison !== null,
    outputPct: recap.outputPct,
    activePct: review.activePct * 100,
    deaths: review.deaths.length,
    heldPct: review.metric === 'healing' ? 0 : (throughputHeld / Math.max(1, review.pullSecs)) * 100,
    cdUsePct: topUses > 0 ? (usedOfTop / topUses) * 100 : null,
    bosses,
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

// ---------------------------------------------------------------------------
// Boss fights

// A boss attempt's window in video seconds, from the recording's metadata
export interface BossWindow {
  encounterId: number
  name: string
  start: number
  end: number
  success: boolean
}

export interface BossSummary {
  encounterId: number
  name: string
  kill: boolean
  // Where the fight starts in the video
  at: number
  secs: number
  // Share of the fight spent casting, worked out like the key's activePct
  activePct: number
  // The player's share of the party's damage (healing for healers) in the fight, and
  // over the whole key. Comparing the two cancels out the group and the key level.
  sharePct: number
  keySharePct: number
  deaths: number
}

export function summarizeBosses(data: CoachData, review: PlayerReview, encounters: BossWindow[]): BossSummary[] {
  const player = data.players.find((p) => p.guid === review.guid)
  if (player === undefined) return []
  const metric = review.metric
  const sum = (arr: number[], from: number, to: number): number => {
    let total = 0
    for (let s = Math.max(0, Math.floor(from)); s < Math.ceil(to); s++) total += arr[s] ?? 0
    return total
  }
  const share = (from: number, to: number): number => {
    const party = data.players.reduce((total, p) => total + sum(p[metric], from, to), 0)
    return party > 0 ? (sum(player[metric], from, to) / party) * 100 : 0
  }
  const keySharePct = share(0, data.duration)

  return encounters
    .filter((e) => e.end > e.start)
    .map((e) => {
      const secs = e.end - e.start
      const idle = review.downtime.reduce((total, g) => total + Math.max(0, Math.min(g.end, e.end) - Math.max(g.start, e.start)), 0)
      return {
        encounterId: e.encounterId,
        name: e.name,
        kill: e.success,
        at: e.start,
        secs,
        activePct: Math.max(0, 1 - idle / secs) * 100,
        sharePct: share(e.start, e.end),
        keySharePct,
        deaths: review.deaths.filter((d) => d.at >= e.start && d.at <= e.end).length
      }
    })
}

export interface BossTrendAttempt {
  recordingId: string
  date: string
  keyLevel: number
  at: number
  kill: boolean
  activePct: number
  // Share of the party's output in the fight over the share across the key (1 = same)
  relShare: number
  deaths: number
}

export interface BossTrend {
  dungeon: string
  encounterId: number
  name: string
  // Newest first
  attempts: BossTrendAttempt[]
  keys: number
  activePct: number
  // The same keys' activePct, for comparison
  keyActivePct: number
  relShare: number
  // Keys the player died in this fight
  diedIn: number
  // What stands out, empty when nothing does
  notes: string[]
}

// Keys must be one character and spec
export function buildBossTrends(keys: KeySummary[]): BossTrend[] {
  const groups = new Map<string, { dungeon: string; encounterId: number; name: string; rows: Array<{ key: KeySummary; boss: BossSummary }> }>()
  for (const key of keys) {
    for (const boss of key.bosses) {
      const id = `${key.dungeon}|${boss.encounterId}`
      const group = groups.get(id) ?? { dungeon: key.dungeon, encounterId: boss.encounterId, name: boss.name, rows: [] }
      group.name = boss.name
      group.rows.push({ key, boss })
      groups.set(id, group)
    }
  }

  const trends: BossTrend[] = []
  for (const g of groups.values()) {
    const keyIds = new Set(g.rows.map((r) => r.key.recordingId))
    if (keyIds.size < BOSS_MIN_KEYS) continue
    const fightKeys = keys.filter((k) => keyIds.has(k.recordingId))
    const activePct = mean(g.rows.map((r) => r.boss.activePct))
    const keyActivePct = mean(fightKeys.map((k) => k.activePct))
    const relShares = g.rows.filter((r) => r.boss.keySharePct > 0).map((r) => r.boss.sharePct / r.boss.keySharePct)
    const relShare = relShares.length > 0 ? mean(relShares) : 1
    const diedIn = new Set(g.rows.filter((r) => r.boss.deaths > 0).map((r) => r.key.recordingId)).size

    const notes: string[] = []
    if (relShare <= BOSS_SHARE_DROP) {
      notes.push(`Your share of the party's output drops to ${Math.round(relShare * 100)}% of your usual share on this boss.`)
    }
    if (activePct <= keyActivePct - BOSS_ACTIVE_DROP) {
      notes.push(`You cast ${Math.round(activePct)}% of the time here, against ${Math.round(keyActivePct)}% over the same keys.`)
    }
    if (diedIn >= 2 && diedIn * 2 >= keyIds.size) notes.push(`You died here in ${diedIn} of ${keyIds.size} keys.`)

    trends.push({
      dungeon: g.dungeon,
      encounterId: g.encounterId,
      name: g.name,
      attempts: g.rows
        .map((r) => ({
          recordingId: r.key.recordingId,
          date: r.key.date,
          keyLevel: r.key.keyLevel,
          at: r.boss.at,
          kill: r.boss.kill,
          activePct: r.boss.activePct,
          relShare: r.boss.keySharePct > 0 ? r.boss.sharePct / r.boss.keySharePct : 1,
          deaths: r.boss.deaths
        }))
        .sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at),
      keys: keyIds.size,
      activePct,
      keyActivePct,
      relShare,
      diedIn,
      notes
    })
  }
  // Ones with something to say first, then by dungeon
  return trends.sort((a, b) => b.notes.length - a.notes.length || a.dungeon.localeCompare(b.dungeon))
}

// ---------------------------------------------------------------------------

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
  bosses: BossTrend[]
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
  return { keys, issues, bosses: buildBossTrends(keys) }
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
