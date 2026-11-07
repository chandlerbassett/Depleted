<script setup lang="ts">
import { computed } from 'vue'
import type { Clip, Recording } from '@shared/ipc.types'
import { useRecordingsStore } from '@/stores/recordingsStore'
import { toMediaUrl } from '@shared/appUrl'
import { clipSourceLabel, fmtClock } from '@/utils/recordingLabels'

const props = defineProps<{
  clip: Clip
  recording: Recording
}>()

const emit = defineEmits<{ delete: [clip: Clip]; show: [clip: Clip] }>()

const recordingsStore = useRecordingsStore()

const source = computed(() => clipSourceLabel(props.recording.metadata))
const recordedOn = computed(() =>
  new Date(props.recording.metadata.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
)

function openInRecording(): void {
  recordingsStore.openAt(props.recording.id, props.clip.start)
}
</script>

<template>
  <div class="flex flex-col">
    <div
      class="relative bg-black flex-shrink-0"
      style="aspect-ratio: 16/9; max-height: 70%"
    >
      <video
        :key="clip.id"
        class="w-full h-full object-contain"
        controls
        autoplay
        :src="toMediaUrl(clip.videoPath)"
      />
    </div>

    <div class="px-4 py-3 flex items-start gap-3">
      <div class="flex-1 min-w-0">
        <h3 class="text-sm font-semibold text-white truncate">
          {{ source }}
        </h3>
        <p class="text-xs text-zinc-500 mt-0.5 tabular-nums">
          {{ recording.metadata.zone }} · {{ recordedOn }} · {{ fmtClock(clip.start) }} → {{ fmtClock(clip.end) }}
          ({{ Math.round(clip.end - clip.start) }}s)
        </p>
      </div>
      <button
        class="text-xs text-zinc-300 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
        title="Open the full recording at the start of this clip"
        @click="openInRecording"
      >
        Open in recording
      </button>
      <button
        class="text-xs text-zinc-300 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
        @click="emit('show', clip)"
      >
        Show in Finder
      </button>
      <button
        class="text-xs text-red-400 px-2 py-1 rounded bg-zinc-800 hover:bg-red-900/60"
        @click="emit('delete', clip)"
      >
        Delete
      </button>
    </div>
  </div>
</template>
