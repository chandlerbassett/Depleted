// Cross-session PvP stats ("My PVP Hub"): aggregates already-persisted RecordingMetadata
// across every recording — no new capture logic, pure functions over data we already have.

import type { Recording, ArenaBracket } from '@shared/ipc.types'

export interface WinLoss {
  games: number
  wins: number
  winRatePct: number
}

export interface ClassSpecRow extends WinLoss {
  className: string
  specName: string // '' when spec wasn't resolved
}

export interface BracketRow extends WinLoss {
  bracket: ArenaBracket
}

export interface MatchupRow extends WinLoss {
  enemySpec: string
}

export interface RatingPoint {
  date: string
  rating: number
  bracket: ArenaBracket
}

export interface CharacterRow {
  name: string // "Name-Realm" or "Name-Realm-EU", as logged
  className: string
  specName: string
  games: number
}

// One Solo Shuffle session = 6 rounds sharing a sessionId, each already stored as its
// own Recording (round-level win/loss). "Positive" = won more rounds than lost, which
// is what actually moves rating up in a shuffle session.
export interface ShuffleSessionRow {
  sessionId: string
  date: string // date of the earliest round in the session
  wins: number
  losses: number
  rounds: number
  isPositive: boolean
}

export interface ShuffleSessionStats {
  totalSessions: number
  positiveSessions: number
  positiveRatePct: number
  avgRoundsWon: number
  sessions: ShuffleSessionRow[] // sorted most recent first
}

export interface PvpStats {
  totalGames: number
  overall: WinLoss
  byBracket: BracketRow[]
  byClassSpec: ClassSpecRow[]
  ratingTrend: RatingPoint[]
  bestMatchups: MatchupRow[]
  worstMatchups: MatchupRow[]
  characters: CharacterRow[]
  shuffleSessions: ShuffleSessionStats
}

function toWinLoss(games: number, wins: number): WinLoss {
  return { games, wins, winRatePct: games > 0 ? (wins / games) * 100 : 0 }
}

// Minimum sample size before a matchup is considered for best/worst ranking — avoids a
// single 1-0 record dominating the list.
const MIN_MATCHUP_GAMES = 3

export function computePvpStats(allRecordings: Recording[]): PvpStats {
  // PvP stats only — Mythic+ keys share the recordings list but not these numbers.
  const recordings = allRecordings.filter(
    (r): r is Recording & { metadata: { bracket: ArenaBracket } } => r.metadata.bracket !== 'mythic-plus'
  )
  let totalWins = 0

  const bracketCounts = new Map<ArenaBracket, { games: number; wins: number }>()
  const classSpecCounts = new Map<string, { className: string; specName: string; games: number; wins: number }>()
  const matchupCounts = new Map<string, { games: number; wins: number }>()
  const ratingTrend: RatingPoint[] = []
  // name → row, keeping the most recently seen class/spec label for that character.
  const characterCounts = new Map<string, CharacterRow>()
  const lastSeenDate = new Map<string, string>()
  // sessionId → accumulator for Solo Shuffle session-level win/loss.
  const shuffleSessionCounts = new Map<string, { date: string; wins: number; losses: number }>()

  for (const rec of recordings) {
    const m = rec.metadata
    const isWin = m.result === 'WIN'
    if (isWin) totalWins++

    const bracketEntry = bracketCounts.get(m.bracket) ?? { games: 0, wins: 0 }
    bracketEntry.games++
    if (isWin) bracketEntry.wins++
    bracketCounts.set(m.bracket, bracketEntry)

    const className = m.playerClass || 'Unknown'
    const specName = m.playerSpec || ''
    const classSpecKey = `${className}::${specName}`
    const classSpecEntry = classSpecCounts.get(classSpecKey) ?? { className, specName, games: 0, wins: 0 }
    classSpecEntry.games++
    if (isWin) classSpecEntry.wins++
    classSpecCounts.set(classSpecKey, classSpecEntry)

    // One matchup credit per distinct enemy spec faced this match (not per enemy player),
    // so a 3v3 with two of the same spec doesn't double-count the result.
    const enemySpecs = new Set<string>()
    for (const enemyName of m.enemyComp) {
      const spec = m.knownSpecs[enemyName]
      if (spec) enemySpecs.add(spec)
    }
    for (const spec of enemySpecs) {
      const entry = matchupCounts.get(spec) ?? { games: 0, wins: 0 }
      entry.games++
      if (isWin) entry.wins++
      matchupCounts.set(spec, entry)
    }

    if (m.rating !== null) {
      ratingTrend.push({ date: m.date, rating: m.rating.after, bracket: m.bracket })
    }

    if (m.playerName) {
      const existing = characterCounts.get(m.playerName)
      characterCounts.set(m.playerName, {
        name: m.playerName,
        // Keep whichever recording is more recent for the displayed class/spec label.
        className: existing === undefined || m.date >= lastSeenDate.get(m.playerName)! ? className : existing.className,
        specName: existing === undefined || m.date >= lastSeenDate.get(m.playerName)! ? specName : existing.specName,
        games: (existing?.games ?? 0) + 1
      })
      const prevDate = lastSeenDate.get(m.playerName)
      if (prevDate === undefined || m.date >= prevDate) lastSeenDate.set(m.playerName, m.date)
    }

    if (m.bracket === 'solo-shuffle' && m.sessionId) {
      const entry = shuffleSessionCounts.get(m.sessionId) ?? { date: m.date, wins: 0, losses: 0 }
      if (isWin) entry.wins++
      else entry.losses++
      if (m.date < entry.date) entry.date = m.date
      shuffleSessionCounts.set(m.sessionId, entry)
    }
  }

  ratingTrend.sort((a, b) => a.date.localeCompare(b.date))

  const byBracket = [...bracketCounts.entries()]
    .map(([bracket, c]) => ({ bracket, ...toWinLoss(c.games, c.wins) }))
    .sort((a, b) => b.games - a.games)

  const byClassSpec = [...classSpecCounts.values()]
    .map((c) => ({ className: c.className, specName: c.specName, ...toWinLoss(c.games, c.wins) }))
    .sort((a, b) => b.games - a.games)

  const matchupRows = [...matchupCounts.entries()]
    .map(([enemySpec, c]) => ({ enemySpec, ...toWinLoss(c.games, c.wins) }))
    .filter((r) => r.games >= MIN_MATCHUP_GAMES)

  const bestMatchups = [...matchupRows].sort((a, b) => b.winRatePct - a.winRatePct).slice(0, 5)
  const worstMatchups = [...matchupRows].sort((a, b) => a.winRatePct - b.winRatePct).slice(0, 5)

  const characters = [...characterCounts.values()].sort((a, b) => b.games - a.games)

  const shuffleSessionRows: ShuffleSessionRow[] = [...shuffleSessionCounts.entries()]
    .map(([sessionId, c]) => ({
      sessionId,
      date: c.date,
      wins: c.wins,
      losses: c.losses,
      rounds: c.wins + c.losses,
      isPositive: c.wins > c.losses
    }))
    .sort((a, b) => b.date.localeCompare(a.date))

  const shuffleSessions: ShuffleSessionStats = {
    totalSessions: shuffleSessionRows.length,
    positiveSessions: shuffleSessionRows.filter((s) => s.isPositive).length,
    positiveRatePct:
      shuffleSessionRows.length > 0
        ? (shuffleSessionRows.filter((s) => s.isPositive).length / shuffleSessionRows.length) * 100
        : 0,
    avgRoundsWon:
      shuffleSessionRows.length > 0
        ? shuffleSessionRows.reduce((sum, s) => sum + s.wins, 0) / shuffleSessionRows.length
        : 0,
    sessions: shuffleSessionRows
  }

  return {
    totalGames: recordings.length,
    overall: toWinLoss(recordings.length, totalWins),
    byBracket,
    byClassSpec,
    ratingTrend,
    bestMatchups,
    worstMatchups,
    characters,
    shuffleSessions
  }
}
