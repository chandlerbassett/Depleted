<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import type { Recording, TimelineEventType } from '@shared/ipc.types'
import { usePlayerStore } from '@/stores/playerStore'
import { useStatsLinkStore } from '@/stores/statsLinkStore'
import { usePlayer } from '@/composables/usePlayer'
import TimelineCanvas from './TimelineCanvas.vue'
import MeterWidget from './MeterWidget.vue'
import CooldownTimeline from './CooldownTimeline.vue'
import DeathLog from './DeathLog.vue'
import { TIMELINE_COLORS, SPELL_CLASS_MAP, SPELL_SPEC_MAP, HEALER_SPEC_BY_CLASS, WOW_SPEC_ID_MAP } from '@shared/constants'
import { toFileUrl } from '@/utils/fileUrl'
import { buildCharacterStatsUrl } from '@/utils/characterLinks'
import { computeScoreboard } from '@/composables/useScoreboard'
import { computeMeter } from '@/composables/useMeters'
import { computeCooldownRows } from '@/composables/useCooldownRows'

const props = defineProps<{ recording: Recording }>()

const playerStore = usePlayerStore()
const { currentTime, duration } = storeToRefs(playerStore)
const statsLinkStore = useStatsLinkStore()
const { statsSite, wowRegion } = storeToRefs(statsLinkStore)

function fmtSecs(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const videoRef = ref<HTMLVideoElement | null>(null)
const { onTimeUpdate, onLoadedMetadata, onPlay, onPause, onEnded, seekTo, skip, setPlaybackRate } = usePlayer(
  () => videoRef.value
)

const playbackRate = ref(1)
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2]

function selectSpeed(rate: number): void {
  playbackRate.value = rate
  setPlaybackRate(rate)
}

function openPlayer(name: string): void {
  const url = buildCharacterStatsUrl(statsSite.value, name, wowRegion.value)
  void window.electron.invoke('system:openUrl', { url })
}

const videoSrc = computed(() => toFileUrl(props.recording.videoPath))

const hiddenTypes = ref(new Set<TimelineEventType>())

// Mistakes panel player filter — declared here (not down by the rest of the Mistakes
// section) because the props.recording.id watcher below resets it and runs immediately.
const mistakePlayerFilter = ref<string | null>(null)

watch(
  () => props.recording.id,
  () => {
    playerStore.setCurrentTime(0)
    playerStore.setDuration(0)
    playerStore.setPlaying(false)
    hiddenTypes.value = new Set()
    mistakePlayerFilter.value = null
    playerStore.setEvents(props.recording.metadata.events)
  },
  { immediate: true }
)

const result = computed(() => props.recording.metadata.result)
const bracket = computed(() => props.recording.metadata.bracket)
const mythicPlus = computed(() => props.recording.metadata.mythicPlus)
// Arena shows WIN/LOSS; a key shows its level and how it ended.
const resultLabel = computed(() => {
  const mp = mythicPlus.value
  if (mp === undefined) return result.value
  const outcome = mp.outcome === 'completed' ? 'Completed' : mp.outcome === 'depleted' ? 'Depleted' : 'Abandoned'
  return `+${mp.keystoneLevel} ${outcome}`
})
const zone = computed(() => props.recording.metadata.zone)
const formattedDuration = computed(() => fmtSecs(props.recording.metadata.duration))
const formattedDate = computed(() => formatDate(props.recording.metadata.date))
const rating = computed(() => props.recording.metadata.rating)
const currentTimeLabel = computed(() => fmtSecs(currentTime.value))
const totalTimeLabel = computed(() => fmtSecs(duration.value || props.recording.metadata.duration))

const events = computed(() => props.recording.metadata.events)

// Player names in WoW combat log follow "Name-Realm" or "Name-Realm-EU" format:
// contain a hyphen, no spaces, and are long enough to distinguish from pet names (Chi-Ji = 6 chars).
function isPlayerName(name: string): boolean {
  return name.includes('-') && !name.includes(' ') && name.length >= 7
}

// Derive team lists from event data when teamComp/enemyComp aren't populated yet.
// Rules:
//   - targetName team is always reliable (target field = target's faction)
//   - casterName team is reliable ONLY for aggressive actions (cc/interrupt/offensive):
//     if target='enemy' caster is player-side; if target='player' caster is enemy-side
//   - defensive casters are skipped: enemy healers cast on enemies (target='enemy') too
//   - death events: unit team follows death type
const derivedTeams = computed(() => {
  const stored = props.recording.metadata
  if (stored.teamComp.length > 0 || stored.enemyComp.length > 0) {
    return { playerTeam: stored.teamComp, enemyTeam: stored.enemyComp }
  }
  const playerSet = new Set<string>()
  const enemySet = new Set<string>()
  const aggressive = new Set(['cc', 'interrupt', 'offensive'])

  for (const ev of stored.events) {
    if ('targetName' in ev && ev.targetName && ev.targetName !== 'nil' && isPlayerName(ev.targetName)) {
      if (ev.target === 'enemy') enemySet.add(ev.targetName)
      else playerSet.add(ev.targetName)
    }
    if ('casterName' in ev && ev.casterName && isPlayerName(ev.casterName) && aggressive.has(ev.type)) {
      if (ev.target === 'enemy') playerSet.add(ev.casterName)
      else if (ev.target === 'player') enemySet.add(ev.casterName)
    }
    if ('unit' in ev && ev.unit && isPlayerName(ev.unit)) {
      if (ev.type === 'death-player') playerSet.add(ev.unit)
      else if (ev.type === 'death-enemy') enemySet.add(ev.unit)
    }
  }
  // Remove anyone who ended up in both sets (edge cases) — trust death events more
  for (const name of playerSet) if (enemySet.has(name)) enemySet.delete(name)
  return {
    playerTeam: [...playerSet].sort(),
    enemyTeam: [...enemySet].sort(),
  }
})

function handleSeek(time: number): void {
  seekTo(Math.max(0, time - 2))
}

// -------------------------------------------------------------------------
// Mistakes
// -------------------------------------------------------------------------
const showMistakes = ref(false)
const mistakes = computed(() => props.recording.metadata.mistakes ?? [])

// Filter by the player a mistake is "about" (see DetectedMistake.player) — defaults to
// showing everyone's; reset on recording change (see the props.recording.id watcher).
const mistakePlayers = computed(() => {
  const names = new Set<string>()
  for (const m of mistakes.value) {
    if (m.player) names.add(m.player)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
})
const filteredMistakes = computed(() =>
  mistakePlayerFilter.value === null
    ? mistakes.value
    : mistakes.value.filter((m) => m.player === mistakePlayerFilter.value)
)

// All known player names (either team) — used to highlight names mentioned inside a
// mistake's title/tip text with that player's class color, so "the enemy healer was
// completely free to react" reads at a glance instead of requiring parsing prose.
const allKnownNames = computed(() => [...derivedTeams.value.playerTeam, ...derivedTeams.value.enemyTeam])

interface TextSegment {
  text: string
  color?: string
}

function highlightNames(text: string): TextSegment[] {
  const names = allKnownNames.value
  if (names.length === 0) return [{ text }]
  // Longest names first so e.g. "Mage-EU" doesn't shadow a match inside "Mage-EU-Something".
  const escaped = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'g')
  return text.split(re).map((part) => (names.includes(part) ? { text: part, color: playerColor(part) } : { text: part }))
}

const SEVERITY_CLASSES: Record<string, string> = {
  HIGH: 'bg-red-900/60 text-red-300 border-red-800/60',
  MEDIUM: 'bg-amber-900/50 text-amber-300 border-amber-800/50',
  LOW: 'bg-zinc-800 text-zinc-400 border-zinc-700'
}

const EVENT_TYPE_LABEL: Record<string, string> = {
  'cc': 'CC',
  'interrupt': 'Interrupt',
  'defensive': 'Defensive',
  'offensive': 'Offensive',
  'trinket': 'Trinket',
  'cc-break': 'CC Break',
  'death-player': 'Death',
  'death-enemy': 'Kill',
  'boss-kill': 'Boss kill',
  'boss-wipe': 'Wipe',
  'key-start': 'Key start',
  'key-end': 'Key end',
}

const arenaLegendItems = [
  { type: 'death-player', label: 'Death' },
  { type: 'death-enemy', label: 'Kill' },
  { type: 'cc', label: 'CC' },
  { type: 'interrupt', label: 'Interrupt' },
  { type: 'defensive', label: 'Defensive' },
  { type: 'offensive', label: 'Offensive' },
  { type: 'trinket', label: 'Trinket' },
] as const

const mythicPlusLegendItems = [
  { type: 'death-player', label: 'Death' },
  { type: 'boss-kill', label: 'Boss kill' },
  { type: 'boss-wipe', label: 'Wipe' },
  { type: 'interrupt', label: 'Interrupt' },
] as const

const legendItems = computed(() =>
  bracket.value === 'mythic-plus' ? mythicPlusLegendItems : arenaLegendItems
)

const bracketLabel: Record<string, string> = {
  '2v2': '2v2',
  '3v3': '3v3',
  'solo-shuffle': 'Solo Shuffle',
  'skirmish': 'Skirmish',
  'mythic-plus': 'Mythic+',
}

const CLASS_COLORS: Record<string, string> = {
  'Death Knight': '#C41E3A',
  'Demon Hunter': '#A330C9',
  'Druid': '#FF7C0A',
  'Evoker': '#33937F',
  'Hunter': '#AAD372',
  'Mage': '#3FC7EB',
  'Monk': '#00FF98',
  'Paladin': '#F48CBA',
  'Priest': '#FFFFFF',
  'Rogue': '#FFF468',
  'Shaman': '#0070DD',
  'Warlock': '#8788EE',
  'Warrior': '#C69B3A',
}

// Infer player → class and spec from spell events
const derivedClassMap = computed((): Map<string, string> => {
  const map = new Map<string, string>()
  for (const ev of props.recording.metadata.events) {
    if ('spellId' in ev && ev.spellId !== undefined && 'casterName' in ev && ev.casterName) {
      const cls = (SPELL_CLASS_MAP as Record<number, string>)[ev.spellId]
      if (cls !== undefined) map.set(ev.casterName, cls)
    }
  }
  return map
})

// Fallback spec map inferred from spell casts (used for old recordings without knownSpecs)
const derivedSpecMap = computed((): Map<string, string> => {
  const map = new Map<string, string>()
  for (const ev of props.recording.metadata.events) {
    if ('spellId' in ev && ev.spellId !== undefined && 'casterName' in ev && ev.casterName) {
      const spec = (SPELL_SPEC_MAP as Record<number, string>)[ev.spellId]
      if (spec !== undefined) map.set(ev.casterName, spec)
    }
  }
  return map
})

// Confirmed healer names: prefer metadata.healerNames (set by StateMachine),
// fall back to isHealerCC flags for old recordings.
const confirmedHealerSet = computed((): Set<string> => {
  const saved = props.recording.metadata.healerNames
  if (saved !== undefined && saved.length > 0) return new Set(saved)
  const s = new Set<string>()
  for (const ev of props.recording.metadata.events) {
    if (ev.isHealerCC && ev.targetName) s.add(ev.targetName)
  }
  return s
})

// Spec name (e.g. "Frost", "Affliction") → class, reversed from WOW_SPEC_ID_MAP —
// lets playerColor/playerSpec resolve a class from metadata.knownSpecs (COMBATANT_INFO,
// covers every player regardless of what they cast) instead of only from tracked spell
// casts, which previously left DPS/healer-only players with no class color at all in
// the Meters panel whenever they happened not to cast a tracked cc/defensive/offensive/
// interrupt/trinket spell during the visible match.
const SPEC_NAME_TO_CLASS: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const entry of Object.values(WOW_SPEC_ID_MAP)) {
    map[entry.spec] = entry.class
  }
  return map
})()

function playerColor(name: string): string {
  const cls = derivedClassMap.value.get(name) ?? SPEC_NAME_TO_CLASS[props.recording.metadata.knownSpecs?.[name] ?? '']
  return cls !== undefined ? (CLASS_COLORS[cls] ?? '#d4d4d8') : '#d4d4d8'
}

function playerSpec(name: string): string {
  // Primary: reliable spec from COMBATANT_INFO (saved to metadata.knownSpecs)
  const saved = props.recording.metadata.knownSpecs
  if (saved !== undefined) {
    const spec = saved[name]
    if (spec !== undefined) return spec
  }
  // Fallback: inferred from distinctive spell IDs
  const inferred = derivedSpecMap.value.get(name)
  if (inferred !== undefined) return inferred
  // Last resort: healer spec by class if confirmed healer
  if (confirmedHealerSet.value.has(name)) {
    const cls = derivedClassMap.value.get(name)
    if (cls !== undefined) return (HEALER_SPEC_BY_CLASS as Record<string, string>)[cls] ?? ''
  }
  return ''
}

// -------------------------------------------------------------------------
// Event type filter (click legend to toggle)
// -------------------------------------------------------------------------

function toggleType(type: TimelineEventType): void {
  const next = new Set(hiddenTypes.value)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  hiddenTypes.value = next
}

const visibleEvents = computed(() =>
  events.value
    .filter((ev) => !hiddenTypes.value.has(ev.type))
    .sort((a, b) => a.timestamp - b.timestamp)
)

watch(visibleEvents, () => {
  playerStore.setEvents(visibleEvents.value)
})

// Events text list excludes deaths/kills — they have their own dedicated Death Log
// section now, with a much richer recap than the flat list ever showed. The video
// scrubber timeline (TimelineCanvas, driven by visibleEvents above) still shows
// Death/Kill tick marks for seeking, this only affects the text list below it.
const eventsListItems = computed(() =>
  visibleEvents.value.filter((ev) => ev.type !== 'death-player' && ev.type !== 'death-enemy')
)

// -------------------------------------------------------------------------
// Custom fullscreen
// -------------------------------------------------------------------------
const isFullscreen = ref(false)

function toggleFullscreen(): void {
  isFullscreen.value = !isFullscreen.value
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isFullscreen.value) isFullscreen.value = false
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// -------------------------------------------------------------------------
// Meters — Details!/Skada-style per-player Damage Done / Damage Taken / Healing Done
// -------------------------------------------------------------------------
const showMeters = ref(false)

const dmgDoneMeter = computed(() =>
  computeMeter(props.recording.metadata.playerDamageDone, props.recording.metadata.duration)
)
const dmgTakenMeter = computed(() =>
  computeMeter(props.recording.metadata.playerDamageTaken, props.recording.metadata.duration)
)
const healDoneMeter = computed(() =>
  computeMeter(props.recording.metadata.playerHealingDone, props.recording.metadata.duration)
)
const hasMeterData = computed(
  () => dmgDoneMeter.value.length > 0 || dmgTakenMeter.value.length > 0 || healDoneMeter.value.length > 0
)

// -------------------------------------------------------------------------
// Scoreboard / CC table
// -------------------------------------------------------------------------
const showScoreboard = ref(false)

const scoreboardRows = computed(() =>
  computeScoreboard(props.recording.metadata.events, props.recording.metadata.duration)
)

// -------------------------------------------------------------------------
// Cooldown timeline — per-player trinket/defensive/offensive CD usage
// -------------------------------------------------------------------------
const showCooldowns = ref(false)

const cooldownRows = computed(() =>
  computeCooldownRows(props.recording.metadata.events, derivedTeams.value.playerTeam, derivedTeams.value.enemyTeam)
)

// -------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------
const showEvents = ref(false)

// -------------------------------------------------------------------------
// Death Log — all deaths/kills regardless of the Events legend's hidden-type
// filters, so hiding "Death"/"Kill" there doesn't also empty this section.
// -------------------------------------------------------------------------
const showDeathLog = ref(false)

function unitClass(name: string): string | undefined {
  return derivedClassMap.value.get(name) ?? SPEC_NAME_TO_CLASS[props.recording.metadata.knownSpecs?.[name] ?? '']
}

const deathEvents = computed(() => {
  const raw = events.value.filter((ev) => ev.type === 'death-player' || ev.type === 'death-enemy')
  // Hunters can Feign Death, which fires UNIT_DIED without an actual death — the combat
  // log can't tell real deaths from feigns, so we only keep the LAST death per Hunter
  // (the one that actually ends their game), dropping earlier feign-death false positives.
  const lastHunterDeathAt = new Map<string, number>()
  for (const ev of raw) {
    if (ev.unit && unitClass(ev.unit) === 'Hunter') {
      lastHunterDeathAt.set(ev.unit, Math.max(ev.timestamp, lastHunterDeathAt.get(ev.unit) ?? -Infinity))
    }
  }
  return raw
    .filter((ev) => !ev.unit || unitClass(ev.unit) !== 'Hunter' || ev.timestamp === lastHunterDeathAt.get(ev.unit))
    .sort((a, b) => a.timestamp - b.timestamp)
})

// -------------------------------------------------------------------------
// Graphs
// -------------------------------------------------------------------------
const showGraphs = ref(false)

function buildSvgPath(data: number[], w: number, h: number): string {
  if (data.length < 2) return ''
  const maxVal = Math.max(...data)
  if (maxVal === 0) return ''
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - (v / maxVal) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return 'M ' + pts.join(' L ')
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return String(Math.round(n))
}


const dmgMaxVal = computed(() => {
  const t = props.recording.metadata.teamDmgBySecond ?? []
  const e = props.recording.metadata.enemyDmgBySecond ?? []
  return Math.max(...t, ...e, 1)
})
const healMaxVal = computed(() => {
  const t = props.recording.metadata.teamHealBySecond ?? []
  const e = props.recording.metadata.enemyHealBySecond ?? []
  return Math.max(...t, ...e, 1)
})

function buildSvgPathNorm(data: number[], maxVal: number, w: number, h: number): string {
  if (data.length < 2 || maxVal === 0) return ''
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - (v / maxVal) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return 'M ' + pts.join(' L ')
}

const dmgTeamPathNorm = computed(() => {
  const d = props.recording.metadata.teamDmgBySecond
  return d ? buildSvgPathNorm(d, dmgMaxVal.value, 560, 80) : ''
})
const dmgEnemyPathNorm = computed(() => {
  const d = props.recording.metadata.enemyDmgBySecond
  return d ? buildSvgPathNorm(d, dmgMaxVal.value, 560, 80) : ''
})
const healTeamPathNorm = computed(() => {
  const d = props.recording.metadata.teamHealBySecond
  return d ? buildSvgPathNorm(d, healMaxVal.value, 560, 80) : ''
})
const healEnemyPathNorm = computed(() => {
  const d = props.recording.metadata.enemyHealBySecond
  return d ? buildSvgPathNorm(d, healMaxVal.value, 560, 80) : ''
})

const hasDmgData = computed(() =>
  (props.recording.metadata.teamDmgBySecond?.length ?? 0) > 0 ||
  (props.recording.metadata.enemyDmgBySecond?.length ?? 0) > 0
)
const hasHealData = computed(() =>
  (props.recording.metadata.teamHealBySecond?.length ?? 0) > 0 ||
  (props.recording.metadata.enemyHealBySecond?.length ?? 0) > 0
)

// -------------------------------------------------------------------------
// Player ratings helper
// -------------------------------------------------------------------------
function playerRating(name: string): number | undefined {
  return props.recording.metadata.playerRatings?.[name]
}
</script>

<template>
  <div
    class="flex flex-col"
    :class="isFullscreen ? 'fixed inset-0 z-50 bg-[#0f0f0f]' : 'h-full'"
  >
    <!-- Video -->
    <div
      class="relative bg-black flex-shrink-0"
      :style="isFullscreen ? 'flex: 1 1 0; min-height: 0' : 'aspect-ratio: 16/9; max-height: 42%'"
    >
      <video
        ref="videoRef"
        class="w-full h-full object-contain"
        controls
        :src="videoSrc"
        @timeupdate="onTimeUpdate"
        @loadedmetadata="onLoadedMetadata"
        @play="onPlay"
        @pause="onPause"
        @ended="onEnded"
      />
    </div>

    <!-- Playback controls -->
    <div class="flex-shrink-0 px-4 py-2 flex items-center gap-3">
      <button
        class="text-xs text-zinc-400 hover:text-white px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
        @click="skip(-10)"
      >
        ←10s
      </button>
      <button
        class="text-xs text-zinc-400 hover:text-white px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
        @click="skip(10)"
      >
        +10s→
      </button>
      <div class="flex items-center gap-1">
        <button
          v-for="rate in SPEED_OPTIONS"
          :key="rate"
          class="text-xs px-2 py-1 rounded"
          :class="playbackRate === rate ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'"
          @click="selectSpeed(rate)"
        >
          {{ rate }}x
        </button>
      </div>
      <button
        class="ml-auto text-xs text-zinc-400 hover:text-white px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
        :title="isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'"
        @click="toggleFullscreen"
      >
        {{ isFullscreen ? '✕ Exit' : '⛶' }}
      </button>
    </div>

    <!-- Timeline (always visible) -->
    <div class="flex-shrink-0 px-4 pb-2">
      <div class="flex items-center justify-between text-xs text-zinc-600 mb-1">
        <span>{{ currentTimeLabel }}</span>
        <span>{{ totalTimeLabel }}</span>
      </div>
      <div class="relative w-full select-none">
        <TimelineCanvas @seek="handleSeek" />
      </div>
      <div class="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        <button
          v-for="item in legendItems"
          :key="item.type"
          class="flex items-center gap-1.5 rounded px-1 py-0.5 transition-opacity"
          :class="hiddenTypes.has(item.type) ? 'opacity-30' : 'opacity-100 hover:opacity-80'"
          :title="hiddenTypes.has(item.type) ? 'Show ' + item.label : 'Hide ' + item.label"
          @click="toggleType(item.type)"
        >
          <span
            class="w-2 h-2 rounded-sm flex-shrink-0"
            :style="{ backgroundColor: TIMELINE_COLORS[item.type] ?? '#888' }"
          />
          <span
            class="text-xs text-zinc-500"
            :class="hiddenTypes.has(item.type) ? 'line-through' : ''"
          >{{ item.label }}</span>
        </button>
      </div>
    </div>

    <!-- Detail panel — hidden in fullscreen -->
    <div
      v-if="!isFullscreen"
      class="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-4"
    >
      <!-- Match header -->
      <div class="flex items-center gap-3 pt-1">
        <div class="flex-1 min-w-0">
          <h3 class="text-sm font-semibold text-white truncate">
            {{ zone }}
            <span
              v-if="recording.metadata.round !== undefined"
              class="text-zinc-500 font-normal"
            > · R{{ recording.metadata.round }}</span>
          </h3>
          <p class="text-xs text-zinc-500 mt-0.5">
            {{ formattedDate }} · {{ formattedDuration }}
          </p>
        </div>
        <span
          class="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
          :class="{
            'bg-blue-900 text-blue-300': bracket === '2v2',
            'bg-purple-900 text-purple-300': bracket === '3v3',
            'bg-amber-900 text-amber-300': bracket === 'solo-shuffle',
            'bg-zinc-800 text-zinc-400': bracket === 'skirmish',
            'bg-teal-900 text-teal-300': bracket === 'mythic-plus',
          }"
        >
          {{ bracketLabel[bracket] ?? bracket }}
        </span>
        <span
          class="text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0"
          :class="result === 'WIN' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-400'"
        >
          {{ resultLabel }}
        </span>
        <template v-if="rating !== null">
          <span class="text-xs text-zinc-400 flex-shrink-0">
            {{ rating.before }}
            <span class="text-zinc-600">→</span>
            <span :class="rating.after >= rating.before ? 'text-green-400' : 'text-red-400'">{{ rating.after }}</span>
          </span>
        </template>
      </div>

      <!-- Teams -->
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-zinc-900 rounded-lg p-3">
          <p
            class="text-xs font-semibold uppercase tracking-wider mb-2"
            style="color: #f0b429;"
          >
            Your Team
          </p>
          <div
            v-for="name in derivedTeams.playerTeam"
            :key="name"
            class="flex items-center gap-1 py-0.5"
          >
            <button
              class="min-w-0 flex-1 text-xs truncate text-left hover:underline"
              :style="{ color: playerColor(name) }"
              @click="openPlayer(name)"
            >
              {{ name }}<span
                v-if="playerSpec(name)"
                class="text-zinc-500"
              > ({{ playerSpec(name) }})</span>
            </button>
            <span
              v-if="playerRating(name) !== undefined"
              class="text-[10px] text-zinc-500 flex-shrink-0 ml-1"
            >{{ playerRating(name) }}</span>
          </div>
          <p
            v-if="derivedTeams.playerTeam.length === 0"
            class="text-xs text-zinc-600"
          >
            —
          </p>
        </div>
        <div class="bg-zinc-900 rounded-lg p-3">
          <p
            class="text-xs font-semibold uppercase tracking-wider mb-2"
            style="color: #a855f7;"
          >
            Enemy Team
          </p>
          <div
            v-for="name in derivedTeams.enemyTeam"
            :key="name"
            class="flex items-center gap-1 py-0.5"
          >
            <button
              class="min-w-0 flex-1 text-xs truncate text-left hover:underline"
              :style="{ color: playerColor(name) }"
              @click="openPlayer(name)"
            >
              {{ name }}<span
                v-if="playerSpec(name)"
                class="text-zinc-500"
              > ({{ playerSpec(name) }})</span>
            </button>
            <span
              v-if="playerRating(name) !== undefined"
              class="text-[10px] text-zinc-500 flex-shrink-0 ml-1"
            >{{ playerRating(name) }}</span>
          </div>
          <p
            v-if="derivedTeams.enemyTeam.length === 0"
            class="text-xs text-zinc-600"
          >
            —
          </p>
        </div>
      </div>

      <!-- Mistakes (collapsible) -->
      <div v-if="mistakes.length > 0">
        <button
          class="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 hover:text-zinc-300 w-full text-left"
          @click="showMistakes = !showMistakes"
        >
          <span>Mistakes</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 leading-none">{{ mistakes.length }}</span>
          <span class="text-zinc-600">{{ showMistakes ? '▲' : '▼' }}</span>
        </button>
        <div
          v-if="showMistakes"
        >
          <!-- Per-player filter — defaults to showing everyone's mistakes. -->
          <div
            v-if="mistakePlayers.length > 1"
            class="flex flex-wrap gap-1.5 mb-2"
          >
            <button
              class="px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors"
              :class="mistakePlayerFilter === null
                ? 'bg-zinc-700 border-zinc-500 text-zinc-100'
                : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:border-zinc-500'"
              @click="mistakePlayerFilter = null"
            >
              All
            </button>
            <button
              v-for="name in mistakePlayers"
              :key="name"
              class="px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors"
              :class="mistakePlayerFilter === name
                ? 'bg-zinc-700 border-zinc-500'
                : 'bg-zinc-900 border-zinc-700 hover:border-zinc-500'"
              :style="{ color: playerColor(name) }"
              @click="mistakePlayerFilter = name"
            >
              {{ name }}
            </button>
          </div>

          <p
            v-if="filteredMistakes.length === 0"
            class="text-xs text-zinc-600 py-2 text-center"
          >
            No mistakes for this player
          </p>

          <div class="space-y-1.5">
            <button
              v-for="(m, i) in filteredMistakes"
              :key="i"
              class="w-full flex items-start gap-2 text-left bg-zinc-900 hover:bg-zinc-800/80 rounded-lg p-2.5 transition-colors"
              @click="handleSeek(m.timestamp)"
            >
              <span
                class="text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none border flex-shrink-0 mt-0.5"
                :class="SEVERITY_CLASSES[m.severity]"
              >{{ m.severity }}</span>
              <div class="flex-1 min-w-0">
                <p class="text-xs text-zinc-200 font-medium">
                  <span
                    v-for="(seg, si) in highlightNames(m.title)"
                    :key="si"
                    :style="seg.color ? { color: seg.color } : {}"
                  >{{ seg.text }}</span><span
                    v-if="m.targetName"
                    class="text-zinc-500 font-normal"
                  > · <span :style="{ color: playerColor(m.targetName) }">{{ m.targetName }}</span></span>
                </p>
                <p class="text-xs text-zinc-500 mt-0.5">
                  <span
                    v-for="(seg, si) in highlightNames(m.tip)"
                    :key="si"
                    :style="seg.color ? { color: seg.color } : {}"
                  >{{ seg.text }}</span>
                </p>
              </div>
              <span class="text-[10px] text-zinc-600 flex-shrink-0 mt-0.5">{{ fmtSecs(m.timestamp) }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Meters — Details!/Skada-style Damage Done / Damage Taken / Healing Done -->
      <div v-if="hasMeterData">
        <button
          class="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 hover:text-zinc-300 w-full text-left"
          @click="showMeters = !showMeters"
        >
          <span>Meters</span>
          <span class="text-zinc-600">{{ showMeters ? '▲' : '▼' }}</span>
        </button>
        <div
          v-if="showMeters"
          class="space-y-2"
        >
          <MeterWidget
            title="Damage Done"
            :rows="dmgDoneMeter"
            :format-total="fmtK"
            rate-label="DPS"
            :player-color="playerColor"
          />
          <MeterWidget
            title="Damage Taken"
            :rows="dmgTakenMeter"
            :format-total="fmtK"
            rate-label="DTPS"
            :player-color="playerColor"
          />
          <MeterWidget
            title="Healing Done"
            :rows="healDoneMeter"
            :format-total="fmtK"
            rate-label="HPS"
            :player-color="playerColor"
          />
        </div>
      </div>

      <!-- Scoreboard / CC table (collapsible) -->
      <div v-if="scoreboardRows.length > 0">
        <button
          class="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 hover:text-zinc-300 w-full text-left"
          @click="showScoreboard = !showScoreboard"
        >
          <span>Scoreboard</span>
          <span class="text-zinc-600">{{ showScoreboard ? '▲' : '▼' }}</span>
        </button>
        <div
          v-if="showScoreboard"
          class="bg-zinc-900 rounded-lg p-3 overflow-x-auto"
        >
          <table class="w-full text-xs border-collapse">
            <thead>
              <tr class="text-zinc-500 text-left">
                <th class="pb-1.5 pr-2 font-medium">
                  Player
                </th>
                <th class="pb-1.5 px-2 font-medium text-right">
                  Kicks Taken
                </th>
                <th class="pb-1.5 px-2 font-medium text-right">
                  Kicks Done
                </th>
                <th class="pb-1.5 px-2 font-medium text-right">
                  CC Taken
                </th>
                <th class="pb-1.5 px-2 font-medium text-right">
                  CC Done
                </th>
                <th class="pb-1.5 pl-2 font-medium text-right">
                  Shielding
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in scoreboardRows"
                :key="row.name"
                class="border-t border-zinc-800/60"
              >
                <td class="py-1 pr-2 min-w-0">
                  <span
                    class="truncate block"
                    :style="{ color: playerColor(row.name) }"
                  >{{ row.name }}</span>
                </td>
                <td class="py-1 px-2 text-right text-zinc-300">
                  {{ row.kicksTaken }}
                  <span class="text-zinc-600">({{ row.kicksTakenPerMin.toFixed(1) }}/min)</span>
                </td>
                <td class="py-1 px-2 text-right text-zinc-300">
                  {{ row.kicksDone }}
                  <span class="text-zinc-600">({{ row.kicksDonePerMin.toFixed(1) }}/min)</span>
                </td>
                <td class="py-1 px-2 text-right text-zinc-300">
                  {{ row.ccUptimeSecs.toFixed(1) }}s
                  <span class="text-zinc-600">({{ row.ccUptimePct.toFixed(0) }}%)</span>
                </td>
                <td class="py-1 px-2 text-right text-zinc-300">
                  {{ row.ccOutputSecs.toFixed(1) }}s
                </td>
                <td class="py-1 pl-2 text-right text-zinc-300">
                  {{ recording.metadata.playerAbsorb?.[row.name] ? fmtK(recording.metadata.playerAbsorb[row.name]!) : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Cooldown timeline (collapsible) -->
      <div v-if="cooldownRows.length > 0">
        <button
          class="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 hover:text-zinc-300 w-full text-left"
          @click="showCooldowns = !showCooldowns"
        >
          <span>Cooldowns</span>
          <span class="text-zinc-600">{{ showCooldowns ? '▲' : '▼' }}</span>
        </button>
        <div
          v-if="showCooldowns"
          class="bg-zinc-900 rounded-lg p-3"
        >
          <CooldownTimeline
            :rows="cooldownRows"
            :duration="recording.metadata.duration"
            :player-color="playerColor"
            @seek="handleSeek"
          />
        </div>
      </div>

      <!-- Graphs (collapsible) -->
      <div v-if="hasDmgData || hasHealData">
        <button
          class="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 hover:text-zinc-300 w-full text-left"
          @click="showGraphs = !showGraphs"
        >
          <span>Graphs</span>
          <span class="text-zinc-600">{{ showGraphs ? '▲' : '▼' }}</span>
        </button>
        <div
          v-if="showGraphs"
          class="space-y-3"
        >
          <!-- Damage Done -->
          <div
            v-if="hasDmgData"
            class="bg-zinc-900 rounded-lg p-3"
          >
            <div class="flex items-center justify-between mb-1">
              <p class="text-xs text-zinc-400 font-medium">
                Damage Done
              </p>
              <div class="flex items-center gap-3 text-[10px]">
                <span class="flex items-center gap-1"><span class="w-3 h-0.5 bg-[#f0b429] inline-block" />Your Team ({{ fmtK(dmgMaxVal) }})</span>
                <span class="flex items-center gap-1"><span class="w-3 h-0.5 bg-[#a855f7] inline-block" />Enemy</span>
              </div>
            </div>
            <svg
              viewBox="0 0 560 80"
              class="w-full"
              preserveAspectRatio="none"
            >
              <path
                v-if="dmgTeamPathNorm"
                :d="dmgTeamPathNorm"
                stroke="#f0b429"
                stroke-width="1.5"
                fill="none"
                stroke-linejoin="round"
              />
              <path
                v-if="dmgEnemyPathNorm"
                :d="dmgEnemyPathNorm"
                stroke="#a855f7"
                stroke-width="1.5"
                fill="none"
                stroke-linejoin="round"
              />
            </svg>
          </div>

          <!-- Healing Done -->
          <div
            v-if="hasHealData"
            class="bg-zinc-900 rounded-lg p-3"
          >
            <div class="flex items-center justify-between mb-1">
              <p class="text-xs text-zinc-400 font-medium">
                Healing Done
              </p>
              <div class="flex items-center gap-3 text-[10px]">
                <span class="flex items-center gap-1"><span class="w-3 h-0.5 bg-[#22c55e] inline-block" />Your Team ({{ fmtK(healMaxVal) }})</span>
                <span class="flex items-center gap-1"><span class="w-3 h-0.5 bg-[#ef4444] inline-block" />Enemy</span>
              </div>
            </div>
            <svg
              viewBox="0 0 560 80"
              class="w-full"
              preserveAspectRatio="none"
            >
              <path
                v-if="healTeamPathNorm"
                :d="healTeamPathNorm"
                stroke="#22c55e"
                stroke-width="1.5"
                fill="none"
                stroke-linejoin="round"
              />
              <path
                v-if="healEnemyPathNorm"
                :d="healEnemyPathNorm"
                stroke="#ef4444"
                stroke-width="1.5"
                fill="none"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>
      </div>

      <!-- Events (collapsible) -->
      <div>
        <button
          class="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 hover:text-zinc-300 w-full text-left"
          @click="showEvents = !showEvents"
        >
          <span>Events</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 leading-none">{{ eventsListItems.length }}</span>
          <span class="text-zinc-600">{{ showEvents ? '▲' : '▼' }}</span>
        </button>
        <div
          v-if="showEvents"
          class="space-y-0.5"
        >
          <div
            v-for="(ev, i) in eventsListItems"
            :key="i"
            class="flex flex-col text-xs py-1 px-2 rounded"
            :class="ev.isHealerCC ? 'bg-purple-950/40 hover:bg-purple-950/60' : 'hover:bg-zinc-800/60'"
          >
            <div class="flex items-center gap-2 min-w-0">
              <!-- Timestamp — click to seek -->
              <button
                class="w-10 flex-shrink-0 text-zinc-500 tabular-nums hover:text-zinc-300 text-left"
                @click="handleSeek(ev.timestamp)"
              >
                {{ fmtSecs(Math.max(0, ev.timestamp - 2)) }}
              </button>

              <!-- Color dot -->
              <span
                class="w-1.5 h-1.5 rounded-sm flex-shrink-0"
                :style="{ backgroundColor: TIMELINE_COLORS[ev.type] ?? '#888' }"
              />

              <!-- Type label -->
              <span class="flex-shrink-0 text-zinc-400">
                {{ EVENT_TYPE_LABEL[ev.type] ?? ev.type }}
              </span>

              <!-- Interrupt success/fail badge -->
              <span
                v-if="ev.type === 'interrupt' && ev.isSuccessful === true"
                class="flex-shrink-0 text-green-400 font-bold text-[10px] bg-green-950/60 px-1 rounded"
                title="Successful interrupt"
              >✓</span>
              <span
                v-else-if="ev.type === 'interrupt' && ev.isSuccessful === false"
                class="flex-shrink-0 text-red-400 font-bold text-[10px] bg-red-950/60 px-1 rounded"
                :title="ev.mistakeReason ?? 'Bad interrupt'"
              >✗</span>

              <!-- Mistake marker (non-interrupt mistakes, e.g. DR-immune CC) -->
              <span
                v-if="ev.isMistake && ev.type !== 'interrupt'"
                class="flex-shrink-0 text-red-400 font-bold text-[10px] bg-red-950/60 px-1 rounded"
                :title="ev.mistakeReason"
              >!</span>

              <!-- Spell name + CC duration -->
              <span
                v-if="ev.spellName"
                class="text-zinc-300 truncate"
              >
                {{ ev.spellName }}<span
                  v-if="ev.duration !== undefined"
                  class="text-zinc-500 ml-1"
                >{{ ev.duration }}s</span>
              </span>

              <!-- Caster → Target -->
              <template v-if="ev.casterName">
                <span class="text-zinc-600 flex-shrink-0">by</span>
                <span
                  class="truncate"
                  :style="{ color: playerColor(ev.casterName) }"
                >{{ ev.casterName }}</span>
              </template>
              <template v-if="ev.targetName && ev.targetName !== 'nil'">
                <span class="text-zinc-600 flex-shrink-0">→</span>
                <span
                  class="truncate"
                  :style="{ color: playerColor(ev.targetName) }"
                >{{ ev.targetName }}</span>
              </template>

              <!-- Interrupted spell name (successful interrupts only) -->
              <span
                v-if="ev.type === 'interrupt' && ev.interruptedSpell"
                class="text-zinc-500 flex-shrink-0 truncate"
                :title="`Interrupted: ${ev.interruptedSpell}`"
              >({{ ev.interruptedSpell }})</span>
            </div>
          </div>

          <p
            v-if="eventsListItems.length === 0"
            class="text-xs text-zinc-600 py-2 text-center"
          >
            No tracked events in this match
          </p>
        </div>
      </div>

      <!-- Death Log (collapsible) -->
      <div>
        <button
          class="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 hover:text-zinc-300 w-full text-left"
          @click="showDeathLog = !showDeathLog"
        >
          <span>Death Log</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 leading-none">{{ deathEvents.length }}</span>
          <span class="text-zinc-600">{{ showDeathLog ? '▲' : '▼' }}</span>
        </button>
        <div v-if="showDeathLog">
          <DeathLog
            :deaths="deathEvents"
            :player-color="playerColor"
            @seek="handleSeek"
          />
        </div>
      </div>
    </div>
  </div>
</template>
