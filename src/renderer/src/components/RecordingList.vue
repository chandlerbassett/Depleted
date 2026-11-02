<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRecordingsStore } from '@/stores/recordingsStore'
import type { Clip, Recording } from '@shared/ipc.types'
import { toFileUrl } from '@/utils/fileUrl'
import { clipSourceLabel, levelBadge, outcomeLabel } from '@/utils/recordingLabels'
import { allClips } from '@/utils/sidebarGroups'
import SidebarClipRow from './SidebarClipRow.vue'

const props = defineProps<{
  recordings: Recording[]
  onDelete: (id: string) => void
  onOpenFolder: (id: string) => void
  onDeleteClip: (clip: Clip) => void
}>()

const recordingsStore = useRecordingsStore()
const { selectedId, selectedClipId } = storeToRefs(recordingsStore)

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

// -------------------------------------------------------------------------
// Sections that are expanded, remembered between launches
// -------------------------------------------------------------------------

type Section = 'mythic-plus' | 'clips'
const STORAGE_KEY = 'depleted.sidebar'

function loadOpen(): Section[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as { sections?: Section[] }
    return saved.sections ?? ['mythic-plus', 'clips']
  } catch {
    return ['mythic-plus', 'clips']
  }
}

const openSections = ref(new Set<Section>(loadOpen()))

function toggleSection(s: Section): void {
  if (openSections.value.has(s)) openSections.value.delete(s)
  else openSections.value.add(s)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ sections: [...openSections.value] }))
}

// -------------------------------------------------------------------------
// Mythic+
// -------------------------------------------------------------------------

interface DateGroup {
  day: string
  label: string
  items: Recording[]
}

const keys = computed(() => props.recordings)

const keysByDate = computed((): DateGroup[] => {
  const map = new Map<string, DateGroup>()
  const sorted = [...keys.value].sort((a, b) => b.metadata.date.localeCompare(a.metadata.date))
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

// -------------------------------------------------------------------------
// Clips
// -------------------------------------------------------------------------

const clips = computed(() => allClips(props.recordings))

function selectClip(id: string): void {
  recordingsStore.selectClip(id)
}

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

    <div
      v-else
      class="flex-1 overflow-y-auto"
    >
      <!-- ================================================================ -->
      <!-- Mythic+                                                          -->
      <!-- ================================================================ -->
      <button
        class="sticky top-0 z-20 w-full flex items-center gap-2 px-3 py-2 bg-[#0f0f0f] border-b border-zinc-800 text-left hover:bg-zinc-900"
        @click="toggleSection('mythic-plus')"
      >
        <span class="text-[10px] text-zinc-600 w-2">{{ openSections.has('mythic-plus') ? '▼' : '▶' }}</span>
        <span class="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex-1">Mythic+</span>
        <span class="text-[10px] text-zinc-600 tabular-nums">{{ keys.length }}</span>
      </button>
      <ul v-if="openSections.has('mythic-plus')">
        <li
          v-if="keys.length === 0"
          class="px-3 py-2 text-[11px] text-zinc-600"
        >
          No keys recorded yet
        </li>
        <template
          v-for="group in keysByDate"
          :key="group.day"
        >
          <li class="px-3 py-1 bg-zinc-900/40 border-b border-zinc-800/60">
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
                  <span
                    v-if="levelBadge(item.metadata) !== null"
                    class="text-[10px] px-1.5 py-0.5 rounded-full leading-none bg-teal-900/60 text-teal-300"
                  >
                    {{ levelBadge(item.metadata) }}
                  </span>
                  <span
                    class="text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none"
                    :class="item.metadata.result === 'WIN' ? 'bg-green-900 text-green-300' : 'bg-red-900/70 text-red-400'"
                  >
                    {{ outcomeLabel(item.metadata) }}
                  </span>
                </div>

                <p class="text-xs text-zinc-200 font-medium truncate mt-1">
                  {{ item.metadata.zone }}
                </p>

                <div class="flex items-center gap-2 mt-1">
                  <span class="text-[11px] text-zinc-500">{{ formatDate(item.metadata.date) }}</span>
                  <span class="text-zinc-700">·</span>
                  <span class="text-[11px] text-zinc-500">{{ formatDuration(item.metadata.duration) }}</span>
                  <template v-if="item.clips.length > 0">
                    <span class="text-zinc-700">·</span>
                    <span class="text-[11px] text-zinc-500">✂ {{ item.clips.length }}</span>
                  </template>
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

            <!-- The key's clips -->
            <div
              v-if="item.clips.length > 0"
              class="pl-6 pb-1"
            >
              <SidebarClipRow
                v-for="clip in item.clips"
                :key="clip.id"
                :clip="clip"
                :selected="selectedClipId === clip.id"
                @select="selectClip(clip.id)"
                @delete="onDeleteClip(clip)"
              />
            </div>
          </li>
        </template>
      </ul>

      <!-- ================================================================ -->
      <!-- Clips                                                            -->
      <!-- ================================================================ -->
      <button
        class="sticky top-0 z-20 w-full flex items-center gap-2 px-3 py-2 bg-[#0f0f0f] border-b border-zinc-800 text-left hover:bg-zinc-900"
        @click="toggleSection('clips')"
      >
        <span class="text-[10px] text-zinc-600 w-2">{{ openSections.has('clips') ? '▼' : '▶' }}</span>
        <span class="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex-1">Clips</span>
        <span class="text-[10px] text-zinc-600 tabular-nums">{{ clips.length }}</span>
      </button>
      <ul
        v-if="openSections.has('clips')"
        class="pl-3"
      >
        <li
          v-if="clips.length === 0"
          class="py-2 text-[11px] text-zinc-600"
        >
          No clips yet. Use the Clip buttons under any recording.
        </li>
        <li
          v-for="entry in clips"
          :key="entry.clip.id"
        >
          <SidebarClipRow
            :clip="entry.clip"
            :title="clipSourceLabel(entry.recording.metadata)"
            :selected="selectedClipId === entry.clip.id"
            @select="selectClip(entry.clip.id)"
            @delete="onDeleteClip(entry.clip)"
          />
        </li>
      </ul>
    </div>
  </div>
</template>
