<script setup lang="ts">
import type { Clip } from '@shared/ipc.types'
import { toMediaUrl } from '@shared/appUrl'
import { fmtClock } from '@/utils/recordingLabels'

defineProps<{
  clip: Clip
  // Shown in the Clips section, where the clip is away from its recording
  title?: string
  selected: boolean
}>()

const emit = defineEmits<{ select: []; delete: [] }>()
</script>

<template>
  <div
    class="group relative flex items-center gap-2 py-1 pr-2 cursor-pointer transition-colors"
    :class="selected ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'"
    @click.stop="emit('select')"
  >
    <div
      class="w-12 flex-shrink-0 bg-zinc-900 rounded-sm overflow-hidden relative"
      style="aspect-ratio: 16/9"
    >
      <img
        v-if="clip.thumbnailPath !== null"
        :src="toMediaUrl(clip.thumbnailPath)"
        class="w-full h-full object-cover"
        loading="lazy"
      >
      <span class="absolute inset-0 flex items-center justify-center text-[9px] text-zinc-500">✂</span>
    </div>
    <div class="min-w-0 flex-1">
      <p
        v-if="title !== undefined"
        class="text-[11px] text-zinc-300 truncate"
      >
        {{ title }}
      </p>
      <p class="text-[10px] text-zinc-500 tabular-nums">
        {{ fmtClock(clip.start) }} → {{ fmtClock(clip.end) }} · {{ Math.round(clip.end - clip.start) }}s
      </p>
    </div>
    <button
      class="hidden group-hover:block p-0.5 text-zinc-500 hover:text-red-400"
      title="Delete clip"
      @click.stop="emit('delete')"
    >
      <svg
        class="w-3 h-3"
        viewBox="0 0 16 16"
        fill="currentColor"
      >
        <path d="M6 2h4v1h3v1H3V3h3V2zM4 5h8l-.8 9H4.8L4 5zm2 2v5h1V7H6zm3 0v5h1V7H9z" />
      </svg>
    </button>
  </div>
</template>
