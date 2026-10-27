<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { CoachData } from '@shared/coach.types'
import { reviewPlayer, fmtClock, DOWNTIME_MIN_SECS, type FindingKind } from '@shared/coachAnalysis'

const props = defineProps<{
  recordingId: string
  playerColor: (name: string) => string
}>()

const emit = defineEmits<{ seek: [time: number] }>()

const coach = ref<CoachData | null>(null)
const loading = ref(false)
const selectedGuid = ref<string | null>(null)
const showUtility = ref(false)

// Character the addon reports, used to pick "you" in the party by default
let addonName: string | null = null

async function load(id: string): Promise<void> {
  loading.value = true
  coach.value = null
  try {
    if (addonName === null) {
      const status = await window.electron.invoke('system:getAddonStatus')
      addonName = status.connected && status.name ? status.name : ''
    }
    const data = await window.electron.invoke('storage:getCoachData', { id })
    if (props.recordingId !== id) return
    coach.value = data
    selectedGuid.value = pickDefault(data)
  } finally {
    if (props.recordingId === id) loading.value = false
  }
}

function pickDefault(data: CoachData | null): string | null {
  if (data === null || data.players.length === 0) return null
  const me = addonName ? data.players.find((p) => p.name === addonName || p.name.startsWith(`${addonName}-`)) : undefined
  return (me ?? sortedPlayers(data)[0]!).guid
}

function sortedPlayers(data: CoachData): CoachData['players'] {
  return [...data.players].sort((a, b) => a.name.localeCompare(b.name))
}

watch(() => props.recordingId, (id) => void load(id), { immediate: true })

const players = computed(() => (coach.value !== null ? sortedPlayers(coach.value) : []))
const review = computed(() =>
  coach.value !== null && selectedGuid.value !== null ? reviewPlayer(coach.value, selectedGuid.value) : null
)
const moments = computed(() => review.value?.findings.slice(0, 8) ?? [])
const throughputCds = computed(() => review.value?.cooldowns.filter((cd) => cd.throughput) ?? [])
const utilityCds = computed(() => review.value?.cooldowns.filter((cd) => !cd.throughput) ?? [])
const duration = computed(() => coach.value?.duration ?? 1)

const KIND_COLOR: Record<FindingKind, string> = {
  'death': '#ef4444',
  'downtime': '#f59e0b',
  'cooldown': '#3b82f6',
  'low-output': '#a855f7'
}

function shortName(name: string): string {
  return name.split('-')[0] ?? name
}

function pct(t: number): string {
  return `${Math.min(100, Math.max(0, (t / duration.value) * 100))}%`
}
</script>

<template>
  <div class="bg-zinc-900 rounded-lg p-3 space-y-3">
    <p
      v-if="loading"
      class="text-xs text-zinc-600"
    >
      Loading…
    </p>
    <p
      v-else-if="coach === null"
      class="text-xs text-zinc-500"
    >
      Coaching needs keys recorded with this version of Depleted or later.
    </p>

    <template v-else>
      <!-- Player picker -->
      <div class="flex flex-wrap gap-1">
        <button
          v-for="p in players"
          :key="p.guid"
          class="text-xs px-2 py-0.5 rounded"
          :class="selectedGuid === p.guid ? 'bg-zinc-700' : 'bg-zinc-800/60 hover:bg-zinc-800'"
          :style="{ color: playerColor(p.name) }"
          @click="selectedGuid = p.guid"
        >
          {{ shortName(p.name) }}
        </button>
      </div>

      <template v-if="review !== null">
        <!-- Headline numbers -->
        <div class="grid grid-cols-4 gap-2 text-center">
          <div>
            <p class="text-sm font-semibold text-white">
              {{ Math.round(review.activePct * 100) }}%
            </p>
            <p class="text-[10px] text-zinc-500">
              Active
            </p>
          </div>
          <div>
            <p class="text-sm font-semibold text-white">
              {{ review.castsPerMin.toFixed(0) }}
            </p>
            <p class="text-[10px] text-zinc-500">
              Casts/min
            </p>
          </div>
          <div>
            <p class="text-sm font-semibold text-white">
              {{ Math.round(review.downtimeSecs) }}s
            </p>
            <p
              class="text-[10px] text-zinc-500"
              :title="`Gaps of ${DOWNTIME_MIN_SECS}s or more with no casts while the party was fighting`"
            >
              Idle in combat
            </p>
          </div>
          <div>
            <p class="text-sm font-semibold text-white">
              {{ review.deaths.length }}
            </p>
            <p class="text-[10px] text-zinc-500">
              Deaths
            </p>
          </div>
        </div>

        <!-- Moments to watch -->
        <div>
          <p class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
            Moments to watch
          </p>
          <div
            v-for="(f, i) in moments"
            :key="i"
            class="flex items-start gap-2 text-xs py-1 px-1 rounded hover:bg-zinc-800/60 cursor-pointer"
            @click="emit('seek', f.at)"
          >
            <span class="w-9 flex-shrink-0 text-zinc-500 tabular-nums">{{ fmtClock(Math.max(0, f.at - 2)) }}</span>
            <span
              class="w-1.5 h-1.5 mt-1.5 rounded-sm flex-shrink-0"
              :style="{ backgroundColor: KIND_COLOR[f.kind] }"
            />
            <div class="min-w-0">
              <p class="text-zinc-200">
                {{ f.title }}
              </p>
              <p class="text-zinc-500">
                {{ f.detail }}
              </p>
            </div>
          </div>
          <p
            v-if="moments.length === 0"
            class="text-xs text-zinc-600 py-1"
          >
            Nothing stood out in this key.
          </p>
        </div>

        <!-- Throughput cooldowns: uses on a key-length track, ready-but-unused shaded -->
        <div v-if="throughputCds.length > 0">
          <p class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
            Throughput cooldowns
          </p>
          <div
            v-for="cd in throughputCds"
            :key="cd.spellId"
            class="py-1"
          >
            <div class="flex items-center justify-between text-xs">
              <span class="text-zinc-300 truncate">{{ cd.name }}</span>
              <span
                class="text-zinc-500 flex-shrink-0"
                :title="cd.estCooldown !== null ? `Cooldown estimated at ${Math.round(cd.estCooldown)}s from the closest two uses` : ''"
              >
                {{ cd.uses.length }}<template v-if="cd.possibleUses !== null"> of ~{{ cd.possibleUses }}</template> uses
              </span>
            </div>
            <div class="relative h-3 mt-1 rounded bg-zinc-800">
              <div
                v-for="(h, i) in cd.held"
                :key="`h${i}`"
                class="absolute inset-y-0 bg-blue-500/20 cursor-pointer"
                :style="{ left: pct(h.readyAt), width: pct((h.usedAt ?? duration) - h.readyAt) }"
                :title="`Likely ready from ${fmtClock(h.readyAt)}`"
                @click="emit('seek', h.readyAt)"
              />
              <button
                v-for="(t, i) in cd.uses"
                :key="`u${i}`"
                class="absolute inset-y-0 w-1 -ml-0.5 rounded-sm bg-blue-400 hover:bg-white"
                :style="{ left: pct(t) }"
                :title="`Used at ${fmtClock(t)}`"
                @click="emit('seek', t)"
              />
            </div>
          </div>
        </div>

        <!-- Everything else: defensives, movement, utility — listed, not judged -->
        <div v-if="utilityCds.length > 0">
          <button
            class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider hover:text-zinc-300"
            @click="showUtility = !showUtility"
          >
            Defensive and utility {{ showUtility ? '▲' : '▼' }}
          </button>
          <div
            v-if="showUtility"
            class="mt-1 space-y-0.5"
          >
            <div
              v-for="cd in utilityCds"
              :key="cd.spellId"
              class="flex items-center gap-2 text-xs"
            >
              <span class="text-zinc-300 truncate flex-1">{{ cd.name }}</span>
              <button
                v-for="(t, i) in cd.uses"
                :key="i"
                class="text-zinc-500 hover:text-zinc-200 tabular-nums"
                @click="emit('seek', t)"
              >
                {{ fmtClock(t) }}
              </button>
            </div>
          </div>
        </div>

        <p class="text-[10px] text-zinc-600">
          Measured against this key alone. Comparing with top players of the same spec comes next.
        </p>
      </template>
    </template>
  </div>
</template>
