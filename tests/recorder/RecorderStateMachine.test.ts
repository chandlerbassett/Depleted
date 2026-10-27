import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { RecorderStateMachine } from '../../src/main/recorder/RecorderStateMachine'
import type {
  StateMachineOptions,
  ProcessingRequiredEvent
} from '../../src/main/recorder/RecorderStateMachine'
import type { CombatLogWatcher } from '../../src/main/combatlog/CombatLogWatcher'
import type { CaptureRecorder } from '../../src/main/recorder/CaptureRecorder'
import type { ParserEventMap } from '../../src/main/combatlog/CombatLogParser'
import { UNIT_FLAG_REACTION_HOSTILE } from '../../src/main/combatlog/CombatLogParser'
import { SOLO_SHUFFLE_FINAL_ROUND_POST_ROLL_SECS } from '../../src/shared/constants'

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

// Fake CombatLogWatcher that lets tests fire parser events directly.
class FakeWatcher extends EventEmitter {
  public readonly parser = Object.assign(new EventEmitter(), {
    // Mirrors CombatLogParser.nameCache (guid → name) — populated by tests that need
    // to exercise RecorderStateMachine.resolveLocalTeam().
    nameCache: new Map<string, string>()
  })

  onParser<K extends keyof ParserEventMap>(
    event: K,
    listener: (payload: ParserEventMap[K]) => void
  ): this {
    this.parser.on(event, listener as (...args: unknown[]) => void)
    return this
  }

  fireParser<K extends keyof ParserEventMap>(event: K, payload: ParserEventMap[K]): void {
    this.parser.emit(event, payload)
  }
}

// Fake recorder whose start/stop behaviour is controlled per test.
class FakeRecorder extends EventEmitter {
  private recording = false

  startMock = vi.fn(async (): Promise<void> => {
    this.recording = true
  })

  stopMock = vi.fn(async (): Promise<string> => {
    this.recording = false
    return '/tmp/fake.mp4'
  })

  isRecording(): boolean {
    return this.recording
  }

  // Forward typed EventEmitter methods expected by the state machine.
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener)
  }

  async start(path: string): Promise<void> {
    return this.startMock(path) as Promise<void>
  }

  stop(): Promise<string> {
    return this.stopMock()
  }
}

// ---------------------------------------------------------------------------
// Fixtures — representative combat log event payloads
// ---------------------------------------------------------------------------

const TS = new Date('2026-04-15T20:00:00Z')

const zoneEntered = {
  zoneId: 1505,
  zoneName: 'Nagrand Arena',
  timestamp: TS
}

const matchStart2v2 = {
  bracket: '2v2' as const,
  zoneName: 'Nagrand Arena',
  zoneId: 1505,
  instanceId: 1505,
  localTeam: 0,
  timestamp: new Date('2026-04-15T20:00:15Z')
}

const matchStartSS = {
  bracket: 'solo-shuffle' as const,
  zoneName: 'Nagrand Arena',
  zoneId: 1505,
  instanceId: 1505,
  localTeam: 0,
  timestamp: new Date('2026-04-15T20:00:15Z')
}

// winningTeam matches matchStart2v2/matchStartSS's localTeam (0) — the state machine
// falls back to that unreliable field when it can't resolve the local player's real
// team via COMBATANT_INFO (no localPlayerName configured in these tests), so this
// still resolves to WIN.
const matchEnd = {
  winningTeam: 0,
  durationSecs: 120,
  timestamp: new Date('2026-04-15T20:02:15Z')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Flushes all pending microtasks and one round of macrotasks (setTimeout 0).
// Needed because the state machine uses void promise chains internally.
function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function buildMachine(
  watcher: FakeWatcher,
  recorder: FakeRecorder,
  opts: Partial<StateMachineOptions> = {}
): RecorderStateMachine {
  const options: StateMachineOptions = {
    rawRecordingsDir: '/tmp/raw',
    ...opts
  }
  return new RecorderStateMachine(
    watcher as unknown as CombatLogWatcher,
    recorder as unknown as CaptureRecorder,
    options
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecorderStateMachine — idle → waiting → recording → processing → idle (2v2)', () => {
  let watcher: FakeWatcher
  let recorder: FakeRecorder
  let machine: RecorderStateMachine

  beforeEach(() => {
    watcher = new FakeWatcher()
    recorder = new FakeRecorder()
    machine = buildMachine(watcher, recorder)
  })

  it('starts in idle state', () => {
    expect(machine.getStatus()).toBe('idle')
  })

  it('transitions to waiting on arenaZoneEntered and starts the recorder', async () => {
    const statusEvents: string[] = []
    machine.on('statusChanged', (e) => statusEvents.push(e.status))

    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    expect(machine.getStatus()).toBe('waiting')
    expect(statusEvents).toContain('waiting')
    expect(recorder.startMock).toHaveBeenCalledOnce()
  })

  it('transitions to recording on arenaMatchStart', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    watcher.fireParser('arenaMatchStart', matchStart2v2)

    expect(machine.getStatus()).toBe('recording')
  })

  it('transitions to processing on arenaMatchEnd and emits processingRequired', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', matchStart2v2)

    const processingEvents: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => processingEvents.push(e))

    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    expect(processingEvents).toHaveLength(1)
    const ev = processingEvents[0]
    expect(ev.bracket).toBe('2v2')
    expect(ev.result).toBe('WIN')
    expect(ev.zoneName).toBe('Nagrand Arena')
    expect(ev.durationSecs).toBe(120)
    expect(ev.roundNumber).toBeUndefined()
  })

  // Regression test for a real bug: ARENA_MATCH_START's field-3 "localTeam" was found
  // to stay constant (e.g. always 1) across an entire 3v3 session in real combat logs,
  // unrelated to the player's actual per-match team — while COMBATANT_INFO's team field
  // does vary correctly match to match. Trusting field 3 flipped WIN/LOSS. The state
  // machine must prefer COMBATANT_INFO (resolved via the addon-reported player name)
  // over the unreliable ARENA_MATCH_START field whenever it's available.
  it('resolves WIN/LOSS from COMBATANT_INFO, not from the unreliable ARENA_MATCH_START field', async () => {
    const w = new FakeWatcher()
    const r = new FakeRecorder()
    const m = buildMachine(w, r, { localPlayerName: 'Critical-Ravencrest-EU' })
    w.parser.nameCache.set('Player-1329-0A8E2A98', 'Critical-Ravencrest-EU')

    w.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    // ARENA_MATCH_START field 3 claims localTeam=1 (the misleading, constant value seen
    // in real logs) — if trusted, winningTeam=1 below would incorrectly resolve to WIN.
    w.fireParser('arenaMatchStart', { ...matchStart2v2, localTeam: 1 })
    // COMBATANT_INFO reports the player's real team as 0 for this match.
    w.fireParser('combatantInfo', {
      playerGuid: 'Player-1329-0A8E2A98',
      playerName: 'Critical-Ravencrest-EU',
      team: 0,
      personalRating: 1932,
      specId: null,
      timestamp: matchStart2v2.timestamp
    })

    const processingEvents: ProcessingRequiredEvent[] = []
    m.on('processingRequired', (e) => processingEvents.push(e))

    w.fireParser('arenaMatchEnd', { ...matchEnd, winningTeam: 1 })
    await flushPromises()

    // winningTeam(1) !== real local team(0) → LOSS, matching the rating-drop-confirmed
    // real-world outcome, despite ARENA_MATCH_START's field 3 saying localTeam=1 (which
    // would have produced a false WIN under the old logic).
    expect(processingEvents[0]?.result).toBe('LOSS')
  })

  // Regression test for a second real bug found after the fix above: the addon's
  // SavedVars stores the player name WITHOUT the realm's region suffix (e.g.
  // "Critical-Ravencrest"), while the combat log always includes it
  // ("Critical-Ravencrest-EU") — so exact name matching in resolveLocalTeam()
  // silently failed 100% of the time, forcing the unreliable field-3 fallback anyway.
  // localPlayerGuid (also provided by the addon) must be used instead and must not be
  // affected by this name mismatch.
  it('resolves WIN/LOSS via localPlayerGuid even when localPlayerName does not match the combat log name', async () => {
    const w = new FakeWatcher()
    const r = new FakeRecorder()
    const m = buildMachine(w, r, {
      // Addon-reported name omits "-EU" — would never match the combat log's name below.
      localPlayerName: 'Critical-Ravencrest',
      localPlayerGuid: 'Player-1329-0A8E2A98'
    })
    // Deliberately do NOT populate nameCache with a matching name, to prove the GUID
    // path doesn't depend on name resolution at all.

    w.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    w.fireParser('arenaMatchStart', { ...matchStart2v2, localTeam: 1 })
    w.fireParser('combatantInfo', {
      playerGuid: 'Player-1329-0A8E2A98',
      playerName: '',
      team: 0,
      personalRating: 1932,
      specId: null,
      timestamp: matchStart2v2.timestamp
    })

    const processingEvents: ProcessingRequiredEvent[] = []
    m.on('processingRequired', (e) => processingEvents.push(e))

    w.fireParser('arenaMatchEnd', { ...matchEnd, winningTeam: 1 })
    await flushPromises()

    expect(processingEvents[0]?.result).toBe('LOSS')
  })

  // Regression test for a real bug: if the addon's SavedVariables file doesn't exist yet
  // at app startup (e.g. WoW hasn't been /reload'd since install), localPlayerName/Guid
  // stay null for the constructor's entire lifetime unless something updates them later —
  // silently breaking team resolution for every match until the app is fully restarted.
  // updateLocalPlayer() (called by the addon file watcher once SavedVariables actually
  // appears) must let a session recover mid-run instead of needing a restart.
  it('recovers team resolution mid-session via updateLocalPlayer after starting with no addon data', async () => {
    const w = new FakeWatcher()
    const r = new FakeRecorder()
    // Constructed with no addon info at all — simulates SavedVariables missing at startup.
    const m = buildMachine(w, r, {})

    w.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    w.fireParser('arenaMatchStart', { ...matchStart2v2, localTeam: 1 })
    w.fireParser('combatantInfo', {
      playerGuid: 'Player-1329-0A8E2A98',
      playerName: '',
      team: 0,
      personalRating: 1932,
      specId: null,
      timestamp: matchStart2v2.timestamp
    })

    // Addon's SavedVariables becomes available mid-session (e.g. WoW /reload just ran).
    m.updateLocalPlayer('Critical-Ravencrest', 'Player-1329-0A8E2A98')

    const processingEvents: ProcessingRequiredEvent[] = []
    m.on('processingRequired', (e) => processingEvents.push(e))

    w.fireParser('arenaMatchEnd', { ...matchEnd, winningTeam: 1 })
    await flushPromises()

    // winningTeam(1) !== real local team(0) → LOSS, only resolvable once localPlayerGuid
    // was set via updateLocalPlayer (without it, this would fall back to the unreliable
    // field-3 value and report the wrong result).
    expect(processingEvents[0]?.result).toBe('LOSS')
  })

  // Regression test for a real bug: team composition ("Your Team" / "Enemy Team" in
  // VideoPlayer.vue) was derived from a per-event target/caster reaction-flag
  // heuristic when metadata.teamComp/enemyComp were empty — which they always were,
  // since RecorderStateMachine never populated them. That heuristic breaks for spells
  // like Mind Control: WoW flips the mind-controlled unit's hostile/friendly flag for
  // the duration of the control, so a single successful MC event tags the enemy target
  // as 'player', and the heuristic's tie-break favored that over several correct
  // 'enemy' signals from the same player's interrupts elsewhere in the match — pulling
  // an enemy onto "Your Team". teamComp/enemyComp must instead come straight from
  // COMBATANT_INFO (guidTeams), which is never affected by mid-match flag flips.
  it('resolves teamComp/enemyComp from COMBATANT_INFO, independent of event target-flag quirks', async () => {
    const w = new FakeWatcher()
    const r = new FakeRecorder()
    const m = buildMachine(w, r, {
      localPlayerName: 'Critical-Ravencrest-EU',
      localPlayerGuid: 'Player-1329-0A8E2A98'
    })
    w.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    w.fireParser('arenaMatchStart', matchStart2v2)

    const roster: Array<[string, string, number]> = [
      ['Player-1329-0A8E2A98', 'Critical-Ravencrest-EU', 0],
      ['Player-2-teammate', 'Teammate-Realm-EU', 0],
      ['Player-3-enemy', 'EnemyDK-Realm-EU', 1]
    ]
    // In the real parser, nameCache is populated from any event's srcGUID/srcName or
    // dstGUID/dstName fields (independent of COMBATANT_INFO) — simulate that here.
    for (const [guid, name] of roster) {
      w.parser.nameCache.set(guid, name)
    }
    for (const [guid, name, team] of roster) {
      w.fireParser('combatantInfo', {
        playerGuid: guid,
        playerName: name,
        team,
        personalRating: 2000,
        specId: null,
        timestamp: matchStart2v2.timestamp
      })
    }

    const processingEvents: ProcessingRequiredEvent[] = []
    m.on('processingRequired', (e) => processingEvents.push(e))

    w.fireParser('arenaMatchEnd', { ...matchEnd, winningTeam: 0 })
    await flushPromises()

    const ev = processingEvents[0]
    expect(ev?.teamComp.sort()).toEqual(['Critical-Ravencrest-EU', 'Teammate-Realm-EU'].sort())
    expect(ev?.enemyComp).toEqual(['EnemyDK-Realm-EU'])
  })

  it('accumulates SPELL_ABSORBED amounts per shield-caster into playerAbsorb', async () => {
    const w = new FakeWatcher()
    const r = new FakeRecorder()
    const m = buildMachine(w, r)

    w.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    w.fireParser('arenaMatchStart', matchStart2v2)

    w.fireParser('spellAbsorb', {
      casterGuid: 'Player-priest',
      casterName: 'Healer-EU',
      amount: 5000,
      timestamp: matchStart2v2.timestamp
    })
    w.fireParser('spellAbsorb', {
      casterGuid: 'Player-priest',
      casterName: 'Healer-EU',
      amount: 3000,
      timestamp: matchStart2v2.timestamp
    })

    const processingEvents: ProcessingRequiredEvent[] = []
    m.on('processingRequired', (e) => processingEvents.push(e))

    w.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    expect(processingEvents[0]?.playerAbsorb).toEqual({ 'Healer-EU': 8000 })
  })

  it('attaches casterHpPct to defensive events from the nearest preceding UNIT_HEALTH sample', async () => {
    const w = new FakeWatcher()
    const r = new FakeRecorder()
    const m = buildMachine(w, r)

    w.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    w.fireParser('arenaMatchStart', matchStart2v2)

    w.fireParser('unitHealth', {
      unitGuid: 'Player-mage',
      unitName: 'Mage-EU',
      hp: 2500,
      maxHp: 10000,
      timestamp: new Date(matchStart2v2.timestamp.getTime() + 5000)
    })
    // Ice Block (45438) is in SPELL_IDS_DEFENSIVE — self-cast, caster === target.
    w.fireParser('spellCast', {
      casterGuid: 'Player-mage',
      casterName: 'Mage-EU',
      targetGuid: 'Player-mage',
      targetName: 'Mage-EU',
      targetFlags: 0,
      spellId: 45438,
      spellName: 'Ice Block',
      eventCategory: 'defensive',
      timestamp: new Date(matchStart2v2.timestamp.getTime() + 6000)
    })

    const processingEvents: ProcessingRequiredEvent[] = []
    m.on('processingRequired', (e) => processingEvents.push(e))

    w.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    const defensiveEvent = processingEvents[0]?.timeline.find((ev) => ev.type === 'defensive')
    expect(defensiveEvent?.casterHpPct).toBe(25)
  })

  it('warns when the rating-delta sign disagrees with the recorded result (diagnostic only)', async () => {
    const w = new FakeWatcher()
    const r = new FakeRecorder()
    buildMachine(w, r, {
      localPlayerName: 'Critical-Ravencrest',
      localPlayerGuid: 'Player-1329-0A8E2A98'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Match 1: recorded as WIN (winningTeam matches local team 0).
    w.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    w.fireParser('arenaMatchStart', matchStart2v2)
    w.fireParser('combatantInfo', {
      playerGuid: 'Player-1329-0A8E2A98',
      playerName: '',
      team: 0,
      personalRating: 1932,
      specId: null,
      timestamp: matchStart2v2.timestamp
    })
    w.fireParser('arenaMatchEnd', { ...matchEnd, winningTeam: 0 })
    await flushPromises()

    // Match 2 starts; the local player's rating DROPPED (1932 -> 1920) despite match 1
    // being recorded as a WIN — a genuine mismatch that should surface as a warning.
    w.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    w.fireParser('arenaMatchStart', matchStart2v2)
    w.fireParser('combatantInfo', {
      playerGuid: 'Player-1329-0A8E2A98',
      playerName: '',
      team: 0,
      personalRating: 1920,
      specId: null,
      timestamp: matchStart2v2.timestamp
    })

    const warnedMismatch = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes('Rating-delta cross-check MISMATCH')
    )
    expect(warnedMismatch).toBe(true)

    warnSpy.mockRestore()
  })

  it('returns to idle after processing completes (2v2)', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', matchStart2v2)
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    expect(machine.getStatus()).toBe('idle')
  })
})

describe('RecorderStateMachine — zone exit aborts recording', () => {
  let watcher: FakeWatcher
  let recorder: FakeRecorder
  let machine: RecorderStateMachine

  beforeEach(() => {
    watcher = new FakeWatcher()
    recorder = new FakeRecorder()
    machine = buildMachine(watcher, recorder)
  })

  it('aborts in waiting state and returns to idle', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    expect(machine.getStatus()).toBe('waiting')

    watcher.fireParser('arenaZoneLeft', undefined as unknown as ParserEventMap['arenaZoneLeft'])
    await flushPromises()

    expect(machine.getStatus()).toBe('idle')
    expect(recorder.stopMock).toHaveBeenCalledOnce()
  })

  it('aborts in recording state and returns to idle', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', matchStart2v2)

    watcher.fireParser('arenaZoneLeft', undefined as unknown as ParserEventMap['arenaZoneLeft'])
    await flushPromises()

    expect(machine.getStatus()).toBe('idle')
  })

  it('ignores zone exit when already idle', () => {
    watcher.fireParser('arenaZoneLeft', undefined as unknown as ParserEventMap['arenaZoneLeft'])
    expect(machine.getStatus()).toBe('idle')
    expect(recorder.startMock).not.toHaveBeenCalled()
  })
})

describe('RecorderStateMachine — Solo Shuffle session (Midnight: per-round recordings)', () => {
  let watcher: FakeWatcher
  let recorder: FakeRecorder
  let machine: RecorderStateMachine

  const R1_START = new Date('2026-04-15T20:00:15Z')

  beforeEach(() => {
    watcher = new FakeWatcher()
    recorder = new FakeRecorder()
    machine = buildMachine(watcher, recorder)
  })

  it('records the full session as one clip; goes idle after arenaMatchEnd', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    // 6 ARENA_MATCH_START events (rounds 1–6) — only round 1 triggers waiting→recording
    for (let i = 0; i < 6; i++) {
      watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: new Date(R1_START.getTime() + i * 90_000) })
    }
    // ONE ARENA_MATCH_END for the whole session
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    // Recorder started once (zone entry), never restarted mid-session
    expect(recorder.startMock).toHaveBeenCalledTimes(1)
    expect(machine.getStatus()).toBe('idle')
  })

  it('emits one processingRequired per round with correct metadata', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    // Each round ends on UNIT_DIED, then the next ARENA_MATCH_START starts a fresh recorder.
    // The final round (6) additionally waits SOLO_SHUFFLE_FINAL_ROUND_POST_ROLL_SECS
    // (real setTimeout) before its own stop()/emit — fake timers fast-forward that.
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 6; i++) {
        const roundStart = new Date(R1_START.getTime() + i * 90_000)
        watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: roundStart })
        watcher.fireParser('unitDied', {
          unitGuid: 'Player-Enemy',
          unitName: 'EnemyPlayer-Realm',
          destFlags: UNIT_FLAG_REACTION_HOSTILE,
          unconscious: false,
          timestamp: new Date(roundStart.getTime() + 60_000)
        })
        await vi.advanceTimersByTimeAsync(3_100) // covers the final round's post-roll delay; a no-op for rounds 1-5
      }
      watcher.fireParser('arenaMatchEnd', { ...matchEnd, timestamp: new Date(R1_START.getTime() + 6 * 90_000) })
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }

    expect(events).toHaveLength(6)
    for (let i = 0; i < 6; i++) {
      expect(events[i]!.bracket).toBe('solo-shuffle')
      expect(events[i]!.roundNumber).toBe(i + 1)
      expect(events[i]!.totalRoundsInSession).toBe(1) // each round is its own file now
      expect(typeof events[i]!.sessionId).toBe('string')
    }
    // All rounds share the same sessionId
    expect(new Set(events.map((e) => e.sessionId)).size).toBe(1)
  })

  it('delays stopping the recorder on the final round by the post-roll buffer, unlike earlier rounds', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    vi.useFakeTimers()
    try {
      // Rounds 1-5: recorder.stop() fires immediately on the round-ending death, no delay.
      for (let i = 0; i < 5; i++) {
        const roundStart = new Date(R1_START.getTime() + i * 90_000)
        watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: roundStart })
        watcher.fireParser('unitDied', {
          unitGuid: 'Player-Enemy',
          unitName: 'EnemyPlayer-Realm',
          destFlags: UNIT_FLAG_REACTION_HOSTILE,
          unconscious: false,
          timestamp: new Date(roundStart.getTime() + 60_000)
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(recorder.stopMock).toHaveBeenCalledTimes(i + 1)
      }

      // Round 6 (final): recorder.stop() must NOT fire right away...
      const round6Start = new Date(R1_START.getTime() + 5 * 90_000)
      watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: round6Start })
      watcher.fireParser('unitDied', {
        unitGuid: 'Player-Enemy',
        unitName: 'EnemyPlayer-Realm',
        destFlags: UNIT_FLAG_REACTION_HOSTILE,
        unconscious: false,
        timestamp: new Date(round6Start.getTime() + 60_000)
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(recorder.stopMock).toHaveBeenCalledTimes(5) // still 5, not 6

      // ARENA_MATCH_END arriving mid-delay must not race/duplicate the eventual stop.
      watcher.fireParser('arenaMatchEnd', { ...matchEnd, timestamp: new Date(round6Start.getTime() + 61_000) })
      await vi.advanceTimersByTimeAsync(0)
      expect(recorder.stopMock).toHaveBeenCalledTimes(5)

      // ...only after the post-roll buffer elapses.
      await vi.advanceTimersByTimeAsync(SOLO_SHUFFLE_FINAL_ROUND_POST_ROLL_SECS * 1000 + 100)
      expect(recorder.stopMock).toHaveBeenCalledTimes(6)
    } finally {
      vi.useRealTimers()
    }

    expect(events).toHaveLength(6)
    expect(events[4]!.durationSecs).toBeCloseTo(60, 1) // round 5: no post-roll padding
    expect(events[5]!.durationSecs).toBeCloseTo(60 + SOLO_SHUFFLE_FINAL_ROUND_POST_ROLL_SECS, 1) // round 6: padded
    expect(machine.getStatus()).toBe('idle')
  })

  it('determines round result WIN from enemy real death', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    // Round 1
    watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: R1_START })
    // Enemy player dies (not unconscious)
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-Enemy',
      unitName: 'EnemyPlayer-Realm',
      destFlags: UNIT_FLAG_REACTION_HOSTILE,
      unconscious: false,
      timestamp: new Date(R1_START.getTime() + 60_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    // Round 2 finalizes round 1
    const R2_START = new Date(R1_START.getTime() + 90_000)
    watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: R2_START })
    watcher.fireParser('arenaMatchEnd', { ...matchEnd, timestamp: new Date(R2_START.getTime() + 90_000) })
    await flushPromises()

    expect(events[0]!.result).toBe('WIN')
    expect(events[0]!.roundNumber).toBe(1)
  })

  it('determines round result LOSS from friendly real death', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    // Round 1
    watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: R1_START })
    // Friendly player dies
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-Ally',
      unitName: 'AllyPlayer-Realm',
      destFlags: 0x511, // friendly
      unconscious: false,
      timestamp: new Date(R1_START.getTime() + 60_000)
    })
    // One enemy also dies (friendly > enemy → LOSS)
    // (more friendlies dead, so LOSS)

    const R2_START = new Date(R1_START.getTime() + 90_000)
    watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: R2_START })
    watcher.fireParser('arenaMatchEnd', { ...matchEnd, timestamp: new Date(R2_START.getTime() + 90_000) })
    await flushPromises()

    expect(events[0]!.result).toBe('LOSS')
  })

  it('ignores unconscious deaths for round result', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: R1_START })
    // Enemy "dies" but unconscious=true (Feign Death / similar) — should NOT count
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-Enemy',
      unitName: 'EnemyHunter-Realm',
      destFlags: UNIT_FLAG_REACTION_HOSTILE,
      unconscious: true,
      timestamp: new Date(R1_START.getTime() + 30_000)
    })
    // Friendly dies for real — this IS counted
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-Ally',
      unitName: 'AllyWarrior-Realm',
      destFlags: 0x511,
      unconscious: false,
      timestamp: new Date(R1_START.getTime() + 45_000)
    })

    const R2_START = new Date(R1_START.getTime() + 90_000)
    watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: R2_START })
    watcher.fireParser('arenaMatchEnd', { ...matchEnd, timestamp: new Date(R2_START.getTime() + 90_000) })
    await flushPromises()

    // Enemy unconscious death not counted → 0 enemy, 1 friendly → LOSS
    expect(events[0]!.result).toBe('LOSS')
  })

  it('each round gets its own isolated timeline', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    // Round 1: Counterspell at +5s, round ends on enemy death at +60s
    watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: R1_START })
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      targetGuid: 'Player-B',
      targetFlags: UNIT_FLAG_REACTION_HOSTILE,
      spellId: 2139,
      spellName: 'Counterspell',
      eventCategory: 'interrupt',
      timestamp: new Date(R1_START.getTime() + 5_000)
    })
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-Enemy',
      unitName: 'EnemyPlayer-Realm',
      destFlags: UNIT_FLAG_REACTION_HOSTILE,
      unconscious: false,
      timestamp: new Date(R1_START.getTime() + 60_000)
    })
    await flushPromises()

    // Round 2: Polymorph at R2+5s, round ends on enemy death at R2+60s
    const R2_START = new Date(R1_START.getTime() + 90_000)
    watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: R2_START })
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-B',
      targetGuid: 'Player-A',
      targetFlags: UNIT_FLAG_REACTION_HOSTILE,
      spellId: 118,
      spellName: 'Polymorph',
      eventCategory: 'cc',
      timestamp: new Date(R2_START.getTime() + 5_000)
    })
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-Enemy',
      unitName: 'EnemyPlayer-Realm',
      destFlags: UNIT_FLAG_REACTION_HOSTILE,
      unconscious: false,
      timestamp: new Date(R2_START.getTime() + 60_000)
    })
    await flushPromises()

    watcher.fireParser('arenaMatchEnd', { ...matchEnd, timestamp: new Date(R2_START.getTime() + 90_000) })
    await flushPromises()

    expect(events).toHaveLength(2)
    // R1 timeline: Counterspell + death-enemy (unitDied also appends to timeline)
    expect(events[0]!.timeline).toHaveLength(2)
    expect(events[0]!.timeline[0]!.spellName).toBe('Counterspell')
    expect(events[0]!.timeline[1]!.type).toBe('death-enemy')
    // R2 timeline: Polymorph + death-enemy; Polymorph timestamp relative to R2 start (≈5s)
    expect(events[1]!.timeline).toHaveLength(2)
    expect(events[1]!.timeline[0]!.spellName).toBe('Polymorph')
    expect(events[1]!.timeline[0]!.timestamp).toBeCloseTo(5, 1)
    expect(events[1]!.timeline[1]!.type).toBe('death-enemy')
  })
})

describe('RecorderStateMachine — timeline accumulation', () => {
  let watcher: FakeWatcher
  let recorder: FakeRecorder
  let machine: RecorderStateMachine

  // Match starts at T+0 seconds
  const MATCH_START_TS = new Date('2026-04-15T20:00:15Z')

  beforeEach(() => {
    watcher = new FakeWatcher()
    recorder = new FakeRecorder()
    machine = buildMachine(watcher, recorder)
  })

  it('processingRequired includes empty timeline when no events occur', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: MATCH_START_TS })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    expect(events[0].timeline).toEqual([])
  })

  it('collects spellCast events with relative timestamps and correct target side', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: MATCH_START_TS })

    // 10 seconds into the match, Polymorph on an enemy
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      targetGuid: 'Player-B',
      targetFlags: UNIT_FLAG_REACTION_HOSTILE, // enemy
      spellId: 118,
      spellName: 'Polymorph',
      eventCategory: 'cc',
      timestamp: new Date(MATCH_START_TS.getTime() + 10_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    expect(events[0].timeline).toHaveLength(1)
    const ev = events[0].timeline[0]!
    expect(ev.type).toBe('cc')
    expect(ev.spellId).toBe(118)
    expect(ev.spellName).toBe('Polymorph')
    expect(ev.target).toBe('enemy')
    expect(ev.timestamp).toBeCloseTo(10, 1)
  })

  it('classifies friendly target as "player"', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: MATCH_START_TS })

    watcher.fireParser('spellCast', {
      casterGuid: 'Player-B',
      targetGuid: 'Player-A',
      targetFlags: 0x511, // REACTION_FRIENDLY — friendly/own team
      spellId: 47788,
      spellName: 'Guardian Spirit',
      eventCategory: 'defensive',
      timestamp: new Date(MATCH_START_TS.getTime() + 20_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    expect(events[0].timeline[0]!.target).toBe('player')
  })

  it('collects unitDied as death-enemy for hostile unit', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: MATCH_START_TS })

    watcher.fireParser('unitDied', {
      unitGuid: 'Player-B',
      unitName: 'EnemyWarlock',
      destFlags: UNIT_FLAG_REACTION_HOSTILE,
      timestamp: new Date(MATCH_START_TS.getTime() + 60_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    const deathEv = events[0].timeline[0]!
    expect(deathEv.type).toBe('death-enemy')
    expect(deathEv.unit).toBe('EnemyWarlock')
    expect(deathEv.timestamp).toBeCloseTo(60, 1)
  })

  it('collects unitDied as death-player for friendly unit', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: MATCH_START_TS })

    watcher.fireParser('unitDied', {
      unitGuid: 'Player-A',
      unitName: 'AllyPriest',
      destFlags: 0x511, // friendly
      timestamp: new Date(MATCH_START_TS.getTime() + 45_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    expect(events[0].timeline[0]!.type).toBe('death-player')
  })

  it('ignores events fired before ARENA_MATCH_START', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    // Fire spell event while still in 'waiting' (before match start)
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      targetGuid: 'Player-B',
      targetFlags: UNIT_FLAG_REACTION_HOSTILE,
      spellId: 118,
      spellName: 'Polymorph',
      eventCategory: 'cc',
      timestamp: new Date(MATCH_START_TS.getTime() - 5_000)
    })

    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: MATCH_START_TS })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    // The pre-match spell should not be in the timeline
    expect(events[0].timeline).toHaveLength(0)
  })

  it('non-solo-shuffle match collects all events into one timeline', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    const roundStart = new Date('2026-04-15T20:00:15Z')

    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: roundStart })
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      targetGuid: 'Player-B',
      targetFlags: UNIT_FLAG_REACTION_HOSTILE,
      spellId: 2139,
      spellName: 'Counterspell',
      eventCategory: 'interrupt',
      timestamp: new Date(roundStart.getTime() + 5_000)
    })
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-B',
      targetGuid: 'Player-A',
      targetFlags: UNIT_FLAG_REACTION_HOSTILE,
      spellId: 118,
      spellName: 'Polymorph',
      eventCategory: 'cc',
      timestamp: new Date(roundStart.getTime() + 30_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))

    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    // Both spell events are in the single timeline
    expect(events).toHaveLength(1)
    expect(events[0]!.timeline).toHaveLength(2)
  })
})

describe('RecorderStateMachine — casterName in spell timeline events', () => {
  let watcher: FakeWatcher
  let recorder: FakeRecorder
  let machine: RecorderStateMachine

  const MATCH_START_TS = new Date('2026-04-15T20:00:15Z')

  beforeEach(() => {
    watcher = new FakeWatcher()
    recorder = new FakeRecorder()
    machine = buildMachine(watcher, recorder)
  })

  it('stores casterName and targetName in trinket timeline event', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: MATCH_START_TS })

    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      casterName: 'Thrall-Emerald Dream',
      targetGuid: 'Player-A',
      targetName: 'Thrall-Emerald Dream',
      targetFlags: 0x511, // friendly (self)
      spellId: 42292, // PvP Trinket
      spellName: 'PvP Trinket',
      eventCategory: 'trinket',
      timestamp: new Date(MATCH_START_TS.getTime() + 30_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    const ev = events[0].timeline[0]!
    expect(ev.type).toBe('trinket')
    expect(ev.spellId).toBe(42292)
    expect(ev.casterName).toBe('Thrall-Emerald Dream')
    expect(ev.targetName).toBe('Thrall-Emerald Dream')
  })

  it('stores casterName in defensive timeline event', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: MATCH_START_TS })

    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      casterName: 'Frostmage-Stormrage',
      targetGuid: 'Player-A',
      targetName: 'Frostmage-Stormrage',
      targetFlags: 0x511,
      spellId: 45438, // Ice Block
      spellName: 'Ice Block',
      eventCategory: 'defensive',
      timestamp: new Date(MATCH_START_TS.getTime() + 20_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    expect(events[0].timeline[0]!.casterName).toBe('Frostmage-Stormrage')
  })
})

describe('RecorderStateMachine — death analysis: unusedDefensives', () => {
  let watcher: FakeWatcher
  let recorder: FakeRecorder
  let machine: RecorderStateMachine

  const MATCH_START_TS = new Date('2026-04-15T20:00:15Z')

  beforeEach(() => {
    watcher = new FakeWatcher()
    recorder = new FakeRecorder()
    machine = buildMachine(watcher, recorder)
  })

  // Helper: start session and match
  async function startMatch(bracket = matchStart2v2): Promise<void> {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', { ...bracket, timestamp: MATCH_START_TS })
  }

  it('unusedDefensives is undefined when player class is unknown', async () => {
    await startMatch()

    watcher.fireParser('unitDied', {
      unitGuid: 'Player-X',
      unitName: 'UnknownPlayer-Realm',
      destFlags: 0x511, // friendly
      timestamp: new Date(MATCH_START_TS.getTime() + 60_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    expect(events[0].timeline[0]!.unusedDefensives).toBeUndefined()
  })

  it('all class defensives shown as unused when none were cast', async () => {
    await startMatch()

    // Establish class: Mage cast Counterspell (class inference)
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      casterName: 'Frostmage-Stormrage',
      targetGuid: 'Player-B',
      targetName: 'Enemy-Realm',
      targetFlags: UNIT_FLAG_REACTION_HOSTILE,
      spellId: 2139, // Counterspell → Mage
      spellName: 'Counterspell',
      eventCategory: 'interrupt',
      timestamp: new Date(MATCH_START_TS.getTime() + 10_000)
    })

    // Mage dies without pressing anything
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-A',
      unitName: 'Frostmage-Stormrage',
      destFlags: 0x511, // friendly (own team)
      timestamp: new Date(MATCH_START_TS.getTime() + 60_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    const deathEv = events[0].timeline.find((e) => e.type === 'death-player')!
    expect(deathEv.unusedDefensives).toBeDefined()
    expect(deathEv.unusedDefensives).toContain('Ice Block')
    expect(deathEv.unusedDefensives).toContain('Trinket')
  })

  it('defensive used within cooldown window is NOT listed as unused', async () => {
    await startMatch()

    // Mage cast Barkskin... no wait, Mage: Ice Block was used at T+10s (cooldown 240s)
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      casterName: 'Frostmage-Stormrage',
      targetGuid: 'Player-A',
      targetName: 'Frostmage-Stormrage',
      targetFlags: 0x511,
      spellId: 45438, // Ice Block — also sets class to Mage
      spellName: 'Ice Block',
      eventCategory: 'defensive',
      timestamp: new Date(MATCH_START_TS.getTime() + 10_000)
    })

    // Mage dies at T+15s — Ice Block was used 5s ago, still on 240s cooldown
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-A',
      unitName: 'Frostmage-Stormrage',
      destFlags: 0x511,
      timestamp: new Date(MATCH_START_TS.getTime() + 15_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    const deathEv = events[0].timeline.find((e) => e.type === 'death-player')!
    expect(deathEv.unusedDefensives).not.toContain('Ice Block')
    // Trinket was NOT used — should still be listed
    expect(deathEv.unusedDefensives).toContain('Trinket')
  })

  it('defensive used with expired cooldown IS listed as unused again', async () => {
    await startMatch()

    // Rogue used Evasion (120s CD) at T+5s
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      casterName: 'SubRogue-Realm',
      targetGuid: 'Player-A',
      targetName: 'SubRogue-Realm',
      targetFlags: 0x511,
      spellId: 5277, // Evasion — also sets class to Rogue
      spellName: 'Evasion',
      eventCategory: 'defensive',
      timestamp: new Date(MATCH_START_TS.getTime() + 5_000)
    })

    // Rogue dies at T+130s — Evasion was used 125s ago, 120s CD expired → available again
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-A',
      unitName: 'SubRogue-Realm',
      destFlags: 0x511,
      timestamp: new Date(MATCH_START_TS.getTime() + 130_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    const deathEv = events[0].timeline.find((e) => e.type === 'death-player')!
    expect(deathEv.unusedDefensives).toContain('Evasion')
  })

  it('computes unusedDefensives for enemy death as well', async () => {
    await startMatch()

    // Enemy Paladin is identified by casting Avenging Wrath
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-Enemy',
      casterName: 'HolyPal-Realm',
      targetGuid: 'Player-Enemy',
      targetName: 'HolyPal-Realm',
      targetFlags: UNIT_FLAG_REACTION_HOSTILE,
      spellId: 31884, // Avenging Wrath → Paladin
      spellName: 'Avenging Wrath',
      eventCategory: 'offensive',
      timestamp: new Date(MATCH_START_TS.getTime() + 30_000)
    })

    // Enemy Paladin dies — did not use Divine Shield
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-Enemy',
      unitName: 'HolyPal-Realm',
      destFlags: UNIT_FLAG_REACTION_HOSTILE,
      timestamp: new Date(MATCH_START_TS.getTime() + 90_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    const deathEv = events[0].timeline.find((e) => e.type === 'death-enemy')!
    expect(deathEv.unusedDefensives).toContain('Divine Shield')
    expect(deathEv.unusedDefensives).toContain('Trinket')
  })

  it('Ice Block used early in session appears as not available at death later in session', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    const sessionStart = new Date('2026-04-15T20:00:15Z')
    watcher.fireParser('arenaMatchStart', { ...matchStartSS, timestamp: sessionStart })

    // Mage uses Ice Block at T+10s
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      casterName: 'Frostmage-Stormrage',
      targetGuid: 'Player-A',
      targetName: 'Frostmage-Stormrage',
      targetFlags: 0x511,
      spellId: 45438,
      spellName: 'Ice Block',
      eventCategory: 'defensive',
      timestamp: new Date(sessionStart.getTime() + 10_000)
    })

    // Same Mage dies at T+30s — Ice Block is on cooldown (used 20s ago, CD is 240s)
    watcher.fireParser('unitDied', {
      unitGuid: 'Player-A',
      unitName: 'Frostmage-Stormrage',
      destFlags: 0x511,
      timestamp: new Date(sessionStart.getTime() + 30_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    const deathEv = events[0].timeline.find((e) => e.type === 'death-player')!
    // Ice Block was used 20s before death — still on cooldown, should NOT appear as unused
    expect(deathEv.unusedDefensives ?? []).not.toContain('Ice Block')
  })
})

describe('RecorderStateMachine — death recap: damage/healing/CC/defensives window', () => {
  let watcher: FakeWatcher
  let recorder: FakeRecorder
  let machine: RecorderStateMachine

  const MATCH_START_TS = new Date('2026-04-15T20:00:15Z')

  beforeEach(() => {
    watcher = new FakeWatcher()
    recorder = new FakeRecorder()
    machine = buildMachine(watcher, recorder)
  })

  async function startMatch(): Promise<void> {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()
    watcher.fireParser('arenaMatchStart', { ...matchStart2v2, timestamp: MATCH_START_TS })
  }

  it('collects damage, healing, CC, and defensives from the last 10s before death', async () => {
    await startMatch()

    // Damage taken at T+52s (8s before death)
    watcher.fireParser('spellDamage', {
      casterGuid: 'Player-Enemy',
      casterName: 'EnemyWarr-Realm',
      casterFlags: UNIT_FLAG_REACTION_HOSTILE,
      targetGuid: 'Player-A',
      targetName: 'Frostmage-Stormrage',
      spellId: 100,
      spellName: 'Mortal Strike',
      amount: 40000,
      isCritical: false,
      timestamp: new Date(MATCH_START_TS.getTime() + 52_000)
    })

    // Healing received at T+55s (5s before death)
    watcher.fireParser('spellHealAmount', {
      casterGuid: 'Player-Healer',
      casterName: 'HolyPriest-Realm',
      targetGuid: 'Player-A',
      targetName: 'Frostmage-Stormrage',
      spellId: 200,
      spellName: 'Flash Heal',
      amount: 15000,
      timestamp: new Date(MATCH_START_TS.getTime() + 55_000)
    })

    // CC applied to the dying player at T+53s
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-Enemy2',
      casterName: 'EnemyRogue-Realm',
      targetGuid: 'Player-A',
      targetName: 'Frostmage-Stormrage',
      targetFlags: 0x511,
      spellId: 408, // Kidney Shot
      spellName: 'Kidney Shot',
      eventCategory: 'cc',
      timestamp: new Date(MATCH_START_TS.getTime() + 53_000)
    })

    // Defensive used by the dying player at T+54s
    watcher.fireParser('spellCast', {
      casterGuid: 'Player-A',
      casterName: 'Frostmage-Stormrage',
      targetGuid: 'Player-A',
      targetName: 'Frostmage-Stormrage',
      targetFlags: 0x511,
      spellId: 45438, // Ice Block
      spellName: 'Ice Block',
      eventCategory: 'defensive',
      timestamp: new Date(MATCH_START_TS.getTime() + 54_000)
    })

    // Damage taken at T+30s (30s before death) — outside the 10s window, should be excluded
    watcher.fireParser('spellDamage', {
      casterGuid: 'Player-Enemy',
      casterName: 'EnemyWarr-Realm',
      casterFlags: UNIT_FLAG_REACTION_HOSTILE,
      targetGuid: 'Player-A',
      targetName: 'Frostmage-Stormrage',
      spellId: 101,
      spellName: 'Slam',
      amount: 5000,
      isCritical: false,
      timestamp: new Date(MATCH_START_TS.getTime() + 30_000)
    })

    watcher.fireParser('unitDied', {
      unitGuid: 'Player-A',
      unitName: 'Frostmage-Stormrage',
      destFlags: 0x511,
      timestamp: new Date(MATCH_START_TS.getTime() + 60_000)
    })

    const events: ProcessingRequiredEvent[] = []
    machine.on('processingRequired', (e) => events.push(e))
    watcher.fireParser('arenaMatchEnd', matchEnd)
    await flushPromises()

    const deathEv = events[0].timeline.find((e) => e.type === 'death-player')!

    expect(deathEv.deathSummary).toHaveLength(1)
    expect(deathEv.deathSummary![0]!.spellName).toBe('Mortal Strike')
    expect(deathEv.deathSummary![0]!.casterName).toBe('EnemyWarr-Realm')

    expect(deathEv.deathHealing).toHaveLength(1)
    expect(deathEv.deathHealing![0]!.spellName).toBe('Flash Heal')
    expect(deathEv.deathHealing![0]!.amount).toBe(15000)
    expect(deathEv.deathHealing![0]!.casterName).toBe('HolyPriest-Realm')

    expect(deathEv.deathCCTaken).toHaveLength(1)
    expect(deathEv.deathCCTaken![0]!.spellName).toBe('Kidney Shot')
    expect(deathEv.deathCCTaken![0]!.casterName).toBe('EnemyRogue-Realm')

    expect(deathEv.deathDefensivesUsed).toHaveLength(1)
    expect(deathEv.deathDefensivesUsed![0]!.spellName).toBe('Ice Block')
  })
})

describe('RecorderStateMachine — error handling', () => {
  let watcher: FakeWatcher
  let recorder: FakeRecorder
  let machine: RecorderStateMachine

  beforeEach(() => {
    watcher = new FakeWatcher()
    recorder = new FakeRecorder()
    machine = buildMachine(watcher, recorder)
  })

  it('transitions to error when recorder.start() rejects', async () => {
    recorder.startMock.mockRejectedValueOnce(new Error('Screen Recording permission denied'))

    const errors: { message: string }[] = []
    machine.on('error', (e) => errors.push(e))

    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    expect(machine.getStatus()).toBe('error')
    expect(errors[0].message).toMatch(/Screen Recording permission denied/)
  })

  it('transitions to error on unexpected FFmpeg stop', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await Promise.resolve()
    watcher.fireParser('arenaMatchStart', matchStart2v2)

    const errors: { message: string }[] = []
    machine.on('error', (e) => errors.push(e))

    recorder.emit('unexpectedStop', { code: 1, outputPath: '/tmp/raw.mp4', stderrTail: [] })

    expect(machine.getStatus()).toBe('error')
    expect(errors).toHaveLength(1)
  })

  it('ignores arenaZoneEntered when not idle', async () => {
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    expect(machine.getStatus()).toBe('waiting')
    const startCallCount = recorder.startMock.mock.calls.length

    // Second zone entry while already in waiting — should be ignored
    watcher.fireParser('arenaZoneEntered', zoneEntered)
    await flushPromises()

    expect(recorder.startMock).toHaveBeenCalledTimes(startCallCount)
  })
})
