<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { WclFightResult } from '@shared/wclFight.types'

const props = defineProps<{
  recordingId: string
  playerColor: (name: string) => string
}>()

// Looked up once per recording per session: a fight that isn't uploaded yet costs API
// points on every look, so "Look again" is up to the user
const results = new Map<string, WclFightResult>()

const result = ref<WclFightResult | null>(null)
const loading = ref(false)

async function load(id: string, refresh: boolean): Promise<void> {
  const known = results.get(id)
  if (!refresh && known !== undefined) {
    result.value = known
    return
  }
  loading.value = true
  const r = await window.electron
    .invoke('coach:findWclFight', { id, refresh })
    .catch((err: unknown): WclFightResult => ({ status: 'error', message: String(err) }))
  results.set(id, r)
  if (props.recordingId === id) {
    result.value = r
    loading.value = false
  }
}

watch(() => props.recordingId, (id) => void load(id, false), { immediate: true })

const link = computed(() => (result.value?.status === 'ok' ? result.value.link : null))
const parses = computed(() =>
  [...(link.value?.parses ?? [])].sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || b.amount - a.amount)
)

// WCL's parse colours
function parseColor(p: number | null): string {
  if (p === null) return '#71717a'
  if (p >= 100) return '#e5cc80'
  if (p >= 99) return '#e268a8'
  if (p >= 95) return '#ff8000'
  if (p >= 75) return '#a335ee'
  if (p >= 50) return '#0070ff'
  if (p >= 25) return '#1eff00'
  return '#9d9d9d'
}

function fmtAmount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

function openReport(): void {
  if (link.value !== null) void window.electron.invoke('system:openUrl', { url: link.value.url })
}

// Ranking names have no realm; the recording's have "Name-Realm"
function shortName(name: string): string {
  return name.split('-')[0] ?? name
}
</script>

<template>
  <div class="text-xs">
    <p
      v-if="loading"
      class="text-zinc-600 py-1"
    >
      Looking for this fight on Warcraft Logs…
    </p>
    <p
      v-else-if="result?.status === 'no-credentials'"
      class="text-zinc-500 py-1"
    >
      Connect Warcraft Logs in Settings to find this fight's log.
    </p>
    <div
      v-else-if="result?.status === 'not-found' || result?.status === 'error'"
      class="text-zinc-500 py-1"
    >
      {{ result.message }}.
      <button
        class="ml-1 text-blue-400 hover:underline"
        @click="load(recordingId, true)"
      >
        Look again
      </button>
    </div>
    <div v-else-if="link !== null">
      <div class="flex items-center gap-2 mb-2">
        <button
          class="text-blue-400 hover:underline truncate"
          :title="link.url"
          @click="openReport"
        >
          {{ link.reportTitle || link.reportCode }} ↗
        </button>
        <button
          class="ml-auto text-zinc-600 hover:text-zinc-300 flex-shrink-0"
          title="Fetch the fight and parses again"
          @click="load(recordingId, true)"
        >
          Refresh
        </button>
      </div>
      <p
        v-if="parses.length === 0"
        class="text-zinc-600"
      >
        No parses: wipes aren't ranked, and a kill can take a few minutes after upload. Refresh to check again.
      </p>
      <div
        v-for="p in parses"
        :key="`${p.role}:${p.name}`"
        class="flex items-center gap-2 py-0.5"
      >
        <span
          class="w-8 text-right font-semibold tabular-nums"
          :style="{ color: parseColor(p.percent) }"
        >{{ p.percent !== null ? Math.floor(p.percent) : '·' }}</span>
        <span
          class="flex-1 min-w-0 truncate"
          :style="{ color: playerColor(p.name) }"
        >{{ shortName(p.name) }} <span class="text-zinc-600">{{ p.spec }}</span></span>
        <span class="text-zinc-500 tabular-nums">{{ fmtAmount(p.amount) }}</span>
      </div>
    </div>
  </div>
</template>
