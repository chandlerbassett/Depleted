<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { buildTrends, isCharacter, type KeySummary, type TrendDirection } from '@shared/coachRecap'
import { fmtClock } from '@shared/coachAnalysis'
import { WOW_SPEC_ID_MAP } from '@shared/constants'

// One character's keys over time: headline numbers per key, and the issues that keep
// coming back with whether they're getting better. Every key links to its moments.

const emit = defineEmits<{ open: [recordingId: string, at: number] }>()

const characters = ref<Array<{ name: string; keys: number }>>([])
const character = ref<string | null>(null)
const summaries = ref<KeySummary[]>([])
const wclConfigured = ref(true)
const loading = ref(false)
const comparing = ref(false)
const specId = ref<number | null>(null)
const expanded = ref(new Set<string>())

onMounted(async () => {
  const [list, addon] = await Promise.all([
    window.electron.invoke('coach:listCharacters'),
    window.electron.invoke('system:getAddonStatus')
  ])
  // Only characters with more than one key have trends
  characters.value = list.filter((c) => c.keys >= 2)
  const me = addon.connected && addon.name ? list.find((c) => isCharacter(c.name, addon.name!)) : undefined
  character.value = me?.name ?? characters.value[0]?.name ?? null
})

let loadToken = 0

watch(character, async (name) => {
  if (name === null) return
  const token = ++loadToken
  loading.value = true
  expanded.value = new Set()
  try {
    // Cached comparisons first so something shows right away, then fetch the rest
    const quick = await window.electron.invoke('coach:getKeySummaries', { playerName: name, fetchMissing: false })
    if (token !== loadToken) return
    apply(quick.summaries)
    wclConfigured.value = quick.wclConfigured
    loading.value = false
    if (quick.wclConfigured && quick.summaries.some((k) => !k.benchmarked)) {
      comparing.value = true
      const full = await window.electron.invoke('coach:getKeySummaries', { playerName: name, fetchMissing: true })
      if (token !== loadToken) return
      apply(full.summaries)
    }
  } finally {
    if (token === loadToken) {
      loading.value = false
      comparing.value = false
    }
  }
})

function apply(list: KeySummary[]): void {
  summaries.value = list
  if (specId.value === null || !specs.value.some((s) => s.id === specId.value)) specId.value = specs.value[0]?.id ?? null
}

// Specs this character has keys in, most keys first
const specs = computed(() => {
  const counts = new Map<number, number>()
  for (const k of summaries.value) if (k.specId !== null) counts.set(k.specId, (counts.get(k.specId) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([id, keys]) => ({ id, keys, name: WOW_SPEC_ID_MAP[id]?.spec ?? `Spec ${id}` }))
})

const trends = computed(() => buildTrends(summaries.value.filter((k) => k.specId === specId.value)))
const keys = computed(() => trends.value.keys)
const unbenchmarked = computed(() => keys.value.filter((k) => !k.benchmarked).length)

interface Metric {
  label: string
  hint: string
  // Higher is better?
  higherBetter: boolean
  fmt: (v: number) => string
  pick: (k: KeySummary) => number | null
}

const METRICS: Metric[] = [
  {
    label: 'Output vs top',
    hint: 'Your DPS (HPS for healers) as a share of the median top run of your spec in that dungeon and level',
    higherBetter: true,
    fmt: (v) => `${Math.round(v)}%`,
    pick: (k) => k.outputPct
  },
  {
    label: 'Active',
    hint: 'Share of the fighting spent casting',
    higherBetter: true,
    fmt: (v) => `${Math.round(v)}%`,
    pick: (k) => k.activePct
  },
  {
    label: 'Deaths',
    hint: 'Deaths per key',
    higherBetter: false,
    fmt: (v) => String(Math.round(v)),
    pick: (k) => k.deaths
  },
  {
    label: 'Cooldowns sat ready',
    hint: 'Share of the fighting your throughput cooldowns were ready but not pressed',
    higherBetter: false,
    fmt: (v) => `${Math.round(v)}%`,
    pick: (k) => k.heldPct
  }
]

const W = 160
const H = 36

function points(m: Metric): Array<{ x: number; y: number; key: KeySummary; value: number }> {
  const withValue = keys.value
    .map((k) => ({ key: k, value: m.pick(k) }))
    .filter((p): p is { key: KeySummary; value: number } => p.value !== null)
  if (withValue.length === 0) return []
  const values = withValue.map((p) => p.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  return withValue.map((p, i) => ({
    ...p,
    x: withValue.length === 1 ? W / 2 : 4 + (i / (withValue.length - 1)) * (W - 8),
    y: hi === lo ? H / 2 : 4 + (1 - (p.value - lo) / span) * (H - 8)
  }))
}

function latest(m: Metric): string {
  const p = points(m)
  return p.length > 0 ? m.fmt(p[p.length - 1]!.value) : '–'
}

// Recent half against the earlier half, as an arrow coloured by whether it's better
function change(m: Metric): { text: string; good: boolean } | null {
  const values = points(m).map((p) => p.value)
  if (values.length < 4) return null
  const half = Math.floor(values.length / 2)
  const avg = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length
  const diff = avg(values.slice(-half)) - avg(values.slice(0, values.length - half))
  if (Math.abs(diff) < 0.5) return { text: 'steady', good: true }
  return { text: `${diff > 0 ? '▲' : '▼'} ${m.fmt(Math.abs(diff))}`, good: diff > 0 === m.higherBetter }
}

const DIRECTION: Record<TrendDirection, { text: string; cls: string }> = {
  improving: { text: 'Improving', cls: 'text-green-400 bg-green-900/30' },
  steady: { text: 'Steady', cls: 'text-zinc-400 bg-zinc-800' },
  worse: { text: 'Getting worse', cls: 'text-rose-400 bg-rose-900/30' }
}

function toggle(issue: string): void {
  const next = new Set(expanded.value)
  if (next.has(issue)) next.delete(issue)
  else next.add(issue)
  expanded.value = next
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function keyLabel(k: { dungeon: string; keyLevel: number; date: string }): string {
  return `${fmtDate(k.date)} · ${k.dungeon} +${k.keyLevel}`
}

function shortName(name: string): string {
  return name.split('-')[0] ?? name
}
</script>

<template>
  <div class="p-5 space-y-4 overflow-y-auto">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-sm font-semibold text-zinc-200">
        Trends
      </h2>
      <select
        v-if="characters.length > 1"
        v-model="character"
        class="text-xs bg-zinc-800 text-zinc-200 rounded px-2 py-1 border border-zinc-700"
      >
        <option
          v-for="c in characters"
          :key="c.name"
          :value="c.name"
        >
          {{ shortName(c.name) }} ({{ c.keys }} keys)
        </option>
      </select>
      <span
        v-else-if="character !== null"
        class="text-xs text-zinc-400"
      >{{ shortName(character) }}</span>
      <div class="flex gap-1">
        <button
          v-for="s in specs"
          :key="s.id"
          class="text-xs px-2 py-0.5 rounded"
          :class="specId === s.id ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800'"
          @click="specId = s.id"
        >
          {{ s.name }} · {{ s.keys }}
        </button>
      </div>
    </div>

    <p
      v-if="character === null"
      class="text-xs text-zinc-500"
    >
      Trends show up once a character has two or more keys recorded with this version of Depleted.
    </p>
    <p
      v-else-if="loading"
      class="text-xs text-zinc-600"
    >
      Reading your keys…
    </p>

    <template v-else-if="character !== null">
      <p
        v-if="keys.length < 2"
        class="text-xs text-zinc-500"
      >
        Only one key in this spec so far. Trends start with the second.
      </p>

      <p
        v-if="!wclConfigured"
        class="text-xs text-zinc-500"
      >
        Connect Warcraft Logs in Settings to compare every key with top players of the same spec.
      </p>
      <p
        v-else-if="comparing"
        class="text-xs text-zinc-600"
      >
        Comparing {{ unbenchmarked }} key{{ unbenchmarked === 1 ? '' : 's' }} with top Warcraft Logs runs…
      </p>

      <!-- Headline numbers per key, oldest to newest -->
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <div
          v-for="m in METRICS"
          :key="m.label"
          class="bg-zinc-900 rounded-lg p-3"
          :title="m.hint"
        >
          <div class="flex items-baseline justify-between">
            <p class="text-[10px] text-zinc-500 uppercase tracking-wider">
              {{ m.label }}
            </p>
            <span
              v-if="change(m) !== null"
              class="text-[10px]"
              :class="change(m)!.good ? 'text-green-400' : 'text-rose-400'"
            >{{ change(m)!.text }}</span>
          </div>
          <p class="text-lg font-semibold text-white">
            {{ latest(m) }}
            <span class="text-[10px] font-normal text-zinc-500">last key</span>
          </p>
          <svg
            :viewBox="`0 0 ${W} ${H}`"
            class="w-full h-9"
            preserveAspectRatio="none"
          >
            <polyline
              v-if="points(m).length > 1"
              :points="points(m).map((p) => `${p.x},${p.y}`).join(' ')"
              fill="none"
              stroke="#71717a"
              stroke-width="1.5"
              vector-effect="non-scaling-stroke"
            />
            <circle
              v-for="p in points(m)"
              :key="p.key.recordingId"
              :cx="p.x"
              :cy="p.y"
              r="2.5"
              fill="#f0b429"
              class="cursor-pointer"
              @click="emit('open', p.key.recordingId, 0)"
            >
              <title>{{ keyLabel(p.key) }}: {{ m.fmt(p.value) }}</title>
            </circle>
          </svg>
        </div>
      </div>

      <!-- Issues in two or more keys -->
      <div>
        <p class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
          Repeating issues
        </p>
        <p
          v-if="trends.issues.length === 0 && keys.length >= 2"
          class="text-xs text-zinc-600"
        >
          Nothing has come up in more than one key.
        </p>
        <div
          v-for="t in trends.issues"
          :key="t.issue"
          class="bg-zinc-900 rounded-lg mb-2"
        >
          <button
            class="w-full text-left px-3 py-2 flex items-center gap-2"
            @click="toggle(t.issue)"
          >
            <span class="text-xs text-zinc-200 flex-1 min-w-0 truncate">{{ t.label }}</span>
            <span
              v-if="t.fromTop"
              class="text-[10px] text-amber-400/80 flex-shrink-0"
            >vs top players</span>
            <span class="text-[10px] text-zinc-400 flex-shrink-0 tabular-nums">{{ t.keys.length }} of {{ t.of }} keys</span>
            <span
              v-if="t.lately === 'clear'"
              class="text-[10px] px-1.5 py-0.5 rounded text-green-400 bg-green-900/30 flex-shrink-0"
              title="Came up before, but not in your last 3 keys"
            >Not lately</span>
            <span
              v-else-if="t.direction !== null"
              class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
              :class="DIRECTION[t.direction].cls"
              title="Your recent keys against your earlier ones"
            >{{ DIRECTION[t.direction].text }}</span>
            <span class="text-zinc-600 text-[10px]">{{ expanded.has(t.issue) ? '▲' : '▼' }}</span>
          </button>
          <div
            v-if="expanded.has(t.issue)"
            class="px-3 pb-2 space-y-0.5"
          >
            <div
              v-for="k in t.keys"
              :key="k.recordingId"
              class="flex items-baseline gap-2 text-xs py-0.5 px-1 rounded hover:bg-zinc-800/60 cursor-pointer"
              @click="emit('open', k.recordingId, k.at)"
            >
              <span class="text-zinc-400 flex-shrink-0 w-48 truncate">{{ keyLabel(k) }}</span>
              <span class="text-zinc-500 flex-1 min-w-0 truncate">{{ k.summary }}</span>
              <span class="text-blue-400 tabular-nums flex-shrink-0">{{ fmtClock(Math.max(0, k.at - 2)) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
