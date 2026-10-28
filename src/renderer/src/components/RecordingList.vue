<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useRecordingsStore } from '@/stores/recordingsStore'
import type { Recording } from '@shared/ipc.types'
import { toFileUrl } from '@/utils/fileUrl'

const props = defineProps<{
  recordings: Recording[]
  onDelete: (id: string) => void
  onOpenFolder: (id: string) => void
}>()

const recordingsStore = useRecordingsStore()
const { selectedId } = storeToRefs(recordingsStore)

function select(id: string): void {
  recordingsStore.select(id)
}

function handleDelete(e: MouseEvent, id: string): void {
  e.stopPropagation()
  props.onDelete(id)
}

function handleOpenFolder(e: MouseEvent, id: string): void {
  e.stopPropagation()
  props.onOpenFolder(id)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function calendarDay(iso: string): string {
  return iso.slice(0, 10) // 'YYYY-MM-DD'
}

function dayLabel(day: string): string {
  const today = calendarDay(new Date().toISOString())
  const yesterday = calendarDay(new Date(Date.now() - 86_400_000).toISOString())
  if (day === today) return 'Today'
  if (day === yesterday) return 'Yesterday'
  return new Date(day + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const OUTCOME_LABEL = { completed: 'Completed', depleted: 'Depleted', abandoned: 'Abandoned' } as const

interface DateGroup {
  day: string
  label: string
  items: Recording[]
}

const groupedByDate = computed((): DateGroup[] => {
  const map = new Map<string, DateGroup>()
  const sorted = [...props.recordings].sort((a, b) => b.metadata.date.localeCompare(a.metadata.date))
  for (const item of sorted) {
    const day = calendarDay(item.metadata.date)
    let g = map.get(day)
    if (!g) {
      g = { day, label: dayLabel(day), items: [] }
      map.set(day, g)
    }
    g.items.push(item)
  }
  return Array.from(map.values())
})

const isEmpty = computed(() => props.recordings.length === 0)
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- Empty state -->
    <div
      v-if="isEmpty"
      class="flex-1 flex flex-col items-center justify-center text-center px-4 py-8"
    >
      <div class="text-3xl mb-3 opacity-30">
        🎬
      </div>
      <p class="text-zinc-400 text-sm font-medium">
        No recordings yet
      </p>
      <p class="text-zinc-600 text-xs mt-1">
        Start WoW and run a Mythic+ key. Depleted records it automatically.
      </p>
    </div>

    <!-- List -->
    <ul
      v-else
      class="flex-1 overflow-y-auto"
    >
      <template
        v-for="group in groupedByDate"
        :key="group.day"
      >
        <!-- Date separator -->
        <li class="sticky top-0 z-10 px-3 py-1.5 bg-[#0f0f0f]/95 backdrop-blur-sm border-b border-zinc-800/60">
          <span class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{{ group.label }}</span>
        </li>

        <li
          v-for="item in group.items"
          :key="item.id"
          class="group relative cursor-pointer border-b border-zinc-800/60 transition-colors duration-100"
          :class="selectedId === item.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'"
          @click="select(item.id)"
        >
          <div class="flex items-stretch gap-0">
            <!-- Thumbnail -->
            <div
              class="w-24 flex-shrink-0 relative bg-zinc-900"
              style="aspect-ratio: 16/9"
            >
              <img
                v-if="item.thumbnailPath"
                :src="toFileUrl(item.thumbnailPath)"
                class="w-full h-full object-cover"
                loading="lazy"
                @error="($event.target as HTMLImageElement).style.display = 'none'"
              >
              <div class="absolute inset-0 flex items-center justify-center text-zinc-700 text-lg">
                ▶
              </div>
            </div>

            <!-- Info -->
            <div class="flex-1 min-w-0 px-3 py-2.5 flex flex-col justify-between">
              <div class="flex items-start gap-1.5 flex-wrap">
                <!-- Level 0: recovered after a crash with no key info -->
                <span
                  v-if="item.metadata.mythicPlus.keystoneLevel > 0"
                  class="text-[10px] px-1.5 py-0.5 rounded-full leading-none bg-teal-900/60 text-teal-300"
                >
                  +{{ item.metadata.mythicPlus.keystoneLevel }}
                </span>
                <span
                  class="text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none"
                  :class="item.metadata.result === 'WIN' ? 'bg-green-900 text-green-300' : 'bg-red-900/70 text-red-400'"
                >
                  {{ OUTCOME_LABEL[item.metadata.mythicPlus.outcome] }}
                </span>
              </div>

              <p class="text-xs text-zinc-200 font-medium truncate mt-1">
                {{ item.metadata.zone }}
              </p>

              <div class="flex items-center gap-2 mt-1">
                <span class="text-[11px] text-zinc-500">{{ formatDate(item.metadata.date) }}</span>
                <span class="text-zinc-700">·</span>
                <span class="text-[11px] text-zinc-500">{{ formatDuration(item.metadata.duration) }}</span>
              </div>
            </div>
          </div>

          <!-- Hover actions -->
          <div class="absolute top-1.5 right-1.5 hidden group-hover:flex gap-1">
            <button
              class="p-1 rounded bg-zinc-900/90 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="Show in Finder"
              @click="handleOpenFolder($event, item.id)"
            >
              <svg
                class="w-3 h-3"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M2 2h5v2H4v8h8V9h2v5H2V2z" />
                <path d="M9 2h5v5h-2V4.414L7.707 8.707 6.293 7.293 10.586 3H9V2z" />
              </svg>
            </button>
            <button
              class="p-1 rounded bg-zinc-900/90 hover:bg-red-900/70 text-zinc-400 hover:text-red-400 transition-colors"
              title="Delete recording"
              @click="handleDelete($event, item.id)"
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
        </li>
      </template>
    </ul>
  </div>
</template>
