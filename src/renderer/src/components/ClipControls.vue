<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRecordingsStore } from '@/stores/recordingsStore'

const props = defineProps<{
  recordingId: string
  currentTime: number
}>()

const emit = defineEmits<{ seek: [time: number] }>()

const recordingsStore = useRecordingsStore()

const start = ref<number | null>(null)
const end = ref<number | null>(null)
const saving = ref(false)
const message = ref<{ ok: boolean; text: string } | null>(null)

watch(
  () => props.recordingId,
  () => {
    start.value = null
    end.value = null
    message.value = null
  }
)

function fmt(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function markStart(): void {
  start.value = props.currentTime
  if (end.value !== null && end.value <= start.value) end.value = null
  message.value = null
}

function markEnd(): void {
  end.value = props.currentTime
  if (start.value !== null && start.value >= end.value) start.value = null
  message.value = null
}

function lastSeconds(secs: number): void {
  end.value = props.currentTime
  start.value = Math.max(0, props.currentTime - secs)
  message.value = null
}

function clear(): void {
  start.value = null
  end.value = null
  message.value = null
}

const canSave = computed(
  () => start.value !== null && end.value !== null && end.value - start.value >= 1 && !saving.value
)

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const clip = await window.electron.invoke('storage:saveClip', { id: props.recordingId, start: start.value!, end: end.value! })
    recordingsStore.addClip(clip)
    start.value = null
    end.value = null
    message.value = { ok: true, text: 'Clip saved' }
  } catch (err) {
    message.value = { ok: false, text: err instanceof Error ? err.message : String(err) }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex-shrink-0 px-4 pb-2 flex items-center gap-2 flex-wrap text-xs">
    <span class="text-zinc-500">Clip</span>
    <button
      class="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
      title="Start the clip at the current time"
      @click="markStart"
    >
      [ Start
    </button>
    <button
      class="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
      title="End the clip at the current time"
      @click="markEnd"
    >
      End ]
    </button>
    <button
      class="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
      title="The 30 seconds up to the current time"
      @click="lastSeconds(30)"
    >
      Last 30s
    </button>
    <button
      v-if="start !== null"
      class="text-blue-400 hover:underline tabular-nums"
      @click="emit('seek', start)"
    >
      {{ fmt(start) }}
    </button>
    <span
      v-if="start !== null || end !== null"
      class="text-zinc-600"
    >→</span>
    <button
      v-if="end !== null"
      class="text-blue-400 hover:underline tabular-nums"
      @click="emit('seek', end)"
    >
      {{ fmt(end) }}
    </button>
    <span
      v-if="start !== null && end !== null"
      class="text-zinc-500 tabular-nums"
    >({{ Math.round(end - start) }}s)</span>
    <button
      v-if="start !== null && end !== null"
      class="px-2 py-1 rounded font-medium"
      :class="canSave ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-zinc-800 text-zinc-600'"
      :disabled="!canSave"
      @click="save"
    >
      {{ saving ? 'Saving…' : 'Save clip' }}
    </button>
    <button
      v-if="start !== null || end !== null"
      class="text-zinc-600 hover:text-zinc-300"
      title="Clear"
      @click="clear"
    >
      ✕
    </button>
    <span
      v-if="message !== null"
      :class="message.ok ? 'text-green-400' : 'text-red-400'"
    >{{ message.text }}</span>
  </div>
</template>
