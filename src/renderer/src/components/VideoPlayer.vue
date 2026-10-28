<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import type { Recording, TimelineEventType } from '@shared/ipc.types'
import { usePlayerStore } from '@/stores/playerStore'
import { useStatsLinkStore } from '@/stores/statsLinkStore'
import { useRecordingsStore } from '@/stores/recordingsStore'
import { usePlayer } from '@/composables/usePlayer'
import TimelineCanvas from './TimelineCanvas.vue'
import MeterWidget from './MeterWidget.vue'
import DeathLog from './DeathLog.vue'
import CoachPanel from './CoachPanel.vue'
import { TIMELINE_COLORS, SPELL_CLASS_MAP, SPELL_SPEC_MAP, WOW_SPEC_ID_MAP } from '@shared/constants'
import { toFileUrl } from '@/utils/fileUrl'
import { buildCharacterStatsUrl } from '@/utils/characterLinks'
import { computeMeter } from '@/composables/useMeters'

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

watch(
  () => props.recording.id,
  () => {
    playerStore.setCurrentTime(0)
    playerStore.setDuration(0)
    playerStore.setPlaying(false)
    hiddenTypes.value = new Set()
    playerStore.setEvents(props.recording.metadata.events)
  },
  { immediate: true }
)

const result = computed(() => props.recording.metadata.result)
const mythicPlus = computed(() => props.recording.metadata.mythicPlus)
// The key's level and how it ended
const resultLabel = computed(() => {
  const mp = mythicPlus.value
  const outcome = mp.outcome === 'completed' ? 'Completed' : mp.outcome === 'depleted' ? 'Depleted' : 'Abandoned'
  // Level 0: recovered after a crash with no key info
  return mp.keystoneLevel > 0 ? `+${mp.keystoneLevel} ${outcome}` : outcome
})
const zone = computed(() => props.recording.metadata.zone)
const formattedDuration = computed(() => fmtSecs(props.recording.metadata.duration))
const formattedDate = computed(() => formatDate(props.recording.metadata.date))
const currentTimeLabel = computed(() => fmtSecs(currentTime.value))
const totalTimeLabel = computed(() => fmtSecs(duration.value || props.recording.metadata.duration))

const events = computed(() => props.recording.metadata.events)

const party = computed(() => [...props.recording.metadata.teamComp].sort((a, b) => a.localeCompare(b)))

function handleSeek(time: number): void {
  seekTo(Math.max(0, time - 2))
}

// Moments opened from Trends: seek once the video can, or right away if it already is
const recordingsStore = useRecordingsStore()
const { pendingSeek } = storeToRefs(recordingsStore)

function applyPendingSeek(): void {
  if ((videoRef.value?.readyState ?? 0) < 1) return
  const at = recordingsStore.takePendingSeek(props.recording.id)
  if (at !== null) handleSeek(at)
}

function handleLoadedMetadata(e: Event): void {
  onLoadedMetadata(e)
  applyPendingSeek()
}

watch(pendingSeek, applyPendingSeek)

const EVENT_TYPE_LABEL: Record<string, string> = {
  'interrupt': 'Interrupt',
  'death-player': 'Death',
  'boss-kill': 'Boss kill',
  'boss-wipe': 'Wipe',
  'key-start': 'Key start',
  'key-end': 'Key end',
}

const legendItems = [
  { type: 'death-player', label: 'Death' },
  { type: 'boss-kill', label: 'Boss kill' },
  { type: 'boss-wipe', label: 'Wipe' },
  { type: 'interrupt', label: 'Interrupt' },
] as const

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

// Spec name (e.g. "Frost", "Affliction") → class, reversed from WOW_SPEC_ID_MAP —
// lets playerColor/playerSpec resolve a class from metadata.knownSpecs (COMBATANT_INFO,
// covers every player regardless of what they cast) instead of only from tracked spell
// casts, which leave players with no class color in the Meters panel whenever they
// didn't happen to cast a tracked spell.
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
  return derivedSpecMap.value.get(name) ?? ''
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

// Events text list excludes deaths — they have their own Death Log section. The video
// scrubber timeline (TimelineCanvas, driven by visibleEvents above) still shows death
// tick marks for seeking; this only affects the text list below it.
const eventsListItems = computed(() => visibleEvents.value.filter((ev) => ev.type !== 'death-player'))

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
// Coach — per-player review with jump-to-video moments
// -------------------------------------------------------------------------
const showCoach = ref(true)

// -------------------------------------------------------------------------
// Meters — Details!/Skada-style per-player Damage Done / Healing Done
// -------------------------------------------------------------------------
const showMeters = ref(false)

// Per-second rates use the key timer (the video also has the post-roll)
const meterSecs = computed(() => {
  const keyMs = props.recording.metadata.mythicPlus.totalTimeMs
  return keyMs > 0 ? keyMs / 1000 : props.recording.metadata.duration
})
const dmgDoneMeter = computed(() => computeMeter(props.recording.metadata.playerDamageDone, meterSecs.value))
const healDoneMeter = computed(() => computeMeter(props.recording.metadata.playerHealingDone, meterSecs.value))
const hasMeterData = computed(() => dmgDoneMeter.value.length > 0 || healDoneMeter.value.length > 0)

// -------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------
const showEvents = ref(false)

// -------------------------------------------------------------------------
// Death Log — all deaths regardless of the Events legend's hidden-type filters,
// so hiding "Death" there doesn't also empty this section.
// -------------------------------------------------------------------------
const showDeathLog = ref(false)

function unitClass(name: string): string | undefined {
  return derivedClassMap.value.get(name) ?? SPEC_NAME_TO_CLASS[props.recording.metadata.knownSpecs?.[name] ?? '']
}

const deathEvents = computed(() => {
  const raw = events.value.filter((ev) => ev.type === 'death-player')
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

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return String(Math.round(n))
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
        @loadedmetadata="handleLoadedMetadata"
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
      <!-- Key header -->
      <div class="flex items-center gap-3 pt-1">
        <div class="flex-1 min-w-0">
          <h3 class="text-sm font-semibold text-white truncate">
            {{ zone }}
          </h3>
          <p class="text-xs text-zinc-500 mt-0.5">
            {{ formattedDate }} · {{ formattedDuration }}
          </p>
        </div>
        <span
          class="text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0"
          :class="result === 'WIN' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-400'"
        >
          {{ resultLabel }}
        </span>
      </div>

      <!-- Party -->
      <div class="bg-zinc-900 rounded-lg p-3">
        <p
          class="text-xs font-semibold uppercase tracking-wider mb-2"
          style="color: #f0b429;"
        >
          Party
        </p>
        <div class="grid grid-cols-2 gap-x-3">
          <button
            v-for="name in party"
            :key="name"
            class="min-w-0 text-xs truncate text-left hover:underline py-0.5"
            :style="{ color: playerColor(name) }"
            @click="openPlayer(name)"
          >
            {{ name }}<span
              v-if="playerSpec(name)"
              class="text-zinc-500"
            > ({{ playerSpec(name) }})</span>
          </button>
        </div>
        <p
          v-if="party.length === 0"
          class="text-xs text-zinc-600"
        >
          —
        </p>
      </div>

      <!-- Coach -->
      <div>
        <button
          class="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 hover:text-zinc-300 w-full text-left"
          @click="showCoach = !showCoach"
        >
          <span>Coach</span>
          <span class="text-zinc-600">{{ showCoach ? '▲' : '▼' }}</span>
        </button>
        <CoachPanel
          v-if="showCoach"
          :recording-id="recording.id"
          :dungeon="zone"
          :key-level="mythicPlus?.keystoneLevel ?? 0"
          :date="recording.metadata.date"
          :player-color="playerColor"
          @seek="handleSeek"
        />
      </div>

      <!-- Meters — Details!/Skada-style Damage Done / Healing Done -->
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
            title="Healing Done"
            :rows="healDoneMeter"
            :format-total="fmtK"
            rate-label="HPS"
            :player-color="playerColor"
          />
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
            class="flex flex-col text-xs py-1 px-2 rounded hover:bg-zinc-800/60"
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
                title="Bad interrupt"
              >✗</span>

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
            No tracked events in this key
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
