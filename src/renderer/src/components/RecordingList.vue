<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRecordingsStore } from '@/stores/recordingsStore'
import type { Recording } from '@shared/ipc.types'
import { toFileUrl } from '@/utils/fileUrl'

const props = defineProps<{
  recordings: Recording[]
  onDelete: (id: string) => void
  onDeleteGroup: (ids: string[]) => void
  onOpenFolder: (id: string) => void
}>()

const recordingsStore = useRecordingsStore()
const { selectedId } = storeToRefs(recordingsStore)

const expandedGroups = ref(new Set<string>())

function select(id: string): void {
  recordingsStore.select(id)
}

function handleDelete(e: MouseEvent, id: string): void {
  e.stopPropagation()
  props.onDelete(id)
}

function handleDeleteGroup(e: MouseEvent, group: SoloShuffleGroup): void {
  e.stopPropagation()
  props.onDeleteGroup(group.recordings.map((r) => r.id))
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
// Solo Shuffle grouping
// -------------------------------------------------------------------------

interface SoloShuffleGroup {
  type: 'group'
  sessionId: string
  zone: string
  date: string
  wins: number
  losses: number
  recordings: Recording[]
}

type ListItem = Recording | SoloShuffleGroup

const listItems = computed((): ListItem[] => {
  const groups = new Map<string, SoloShuffleGroup>()
  const singles: Recording[] = []

  for (const r of props.recordings) {
    if (r.metadata.bracket === 'solo-shuffle' && r.metadata.sessionId) {
      const g = groups.get(r.metadata.sessionId)
      if (g) {
        g.recordings.push(r)
        if (r.metadata.result === 'WIN') g.wins++
        else g.losses++
        // Use earliest date for sorting
        if (r.metadata.date < g.date) g.date = r.metadata.date
      } else {
        groups.set(r.metadata.sessionId, {
          type: 'group',
          sessionId: r.metadata.sessionId,
          zone: r.metadata.zone,
          date: r.metadata.date,
          wins: r.metadata.result === 'WIN' ? 1 : 0,
          losses: r.metadata.result === 'LOSS' ? 1 : 0,
          recordings: [r]
        })
      }
    } else {
      singles.push(r)
    }
  }

  // Sort rounds within each group
  for (const g of groups.values()) {
    g.recordings.sort((a, b) => (a.metadata.round ?? 0) - (b.metadata.round ?? 0))
  }

  const items: ListItem[] = [...singles, ...groups.values()]
  items.sort((a, b) => {
    const dateA = 'metadata' in a ? a.metadata.date : a.date
    const dateB = 'metadata' in b ? b.metadata.date : b.date
    return dateB.localeCompare(dateA)
  })
  return items
})

interface DateGroup {
  day: string
  label: string
  items: ListItem[]
}

const groupedByDate = computed((): DateGroup[] => {
  const map = new Map<string, DateGroup>()
  for (const item of listItems.value) {
    const iso = 'metadata' in item ? item.metadata.date : item.date
    const day = calendarDay(iso)
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

function toggleGroup(sessionId: string): void {
  const next = new Set(expandedGroups.value)
  if (next.has(sessionId)) next.delete(sessionId)
  else next.add(sessionId)
  expandedGroups.value = next
}

function isGroupExpanded(sessionId: string): boolean {
  return expandedGroups.value.has(sessionId)
}

function isRecording(item: ListItem): item is Recording {
  return 'metadata' in item
}
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
        Start WoW and enter an arena — the app will record automatically.
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

      <template
        v-for="item in group.items"
        :key="isRecording(item) ? item.id : item.sessionId"
      >
        <!-- Solo Shuffle Group header -->
        <li
          v-if="!isRecording(item)"
          class="group/group border-b border-zinc-800/60 relative"
        >
          <!-- Group header row -->
          <button
            class="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-zinc-800/50 text-left transition-colors"
            @click="toggleGroup(item.sessionId)"
          >
            <!-- Expand arrow -->
            <span class="text-zinc-600 text-xs w-3 flex-shrink-0">
              {{ isGroupExpanded(item.sessionId) ? '▼' : '▶' }}
            </span>

            <!-- Thumbnail placeholder -->
            <div
              class="w-16 flex-shrink-0 bg-zinc-900 rounded overflow-hidden"
              style="aspect-ratio: 16/9"
            >
              <img
                v-if="item.recordings[0]?.thumbnailPath"
                :src="toFileUrl(item.recordings[0].thumbnailPath)"
                class="w-full h-full object-cover"
                loading="lazy"
                @error="($event.target as HTMLImageElement).style.display = 'none'"
              >
              <div class="w-full h-full flex items-center justify-center text-zinc-700 text-xs">
                ▶
              </div>
            </div>

            <!-- Group info -->
            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium text-zinc-200 truncate">
                {{ item.zone }}
              </p>
              <p class="text-[10px] text-zinc-500 mt-0.5">
                <span class="text-green-400">{{ item.wins }}W</span>
                <span class="text-zinc-600 mx-0.5">-</span>
                <span class="text-red-400">{{ item.losses }}L</span>
                <span class="text-zinc-600 mx-1">·</span>
                {{ formatDate(item.date) }}
              </p>
              <p class="text-[10px] text-amber-600/80 mt-0.5">
                Solo Shuffle · {{ item.recordings.length }} rounds
              </p>
            </div>
          </button>

          <!-- Group delete button (visible on hover) -->
          <button
            class="absolute top-2 right-2 hidden group-hover/group:flex p-1 rounded bg-zinc-900/90 hover:bg-red-900/70 text-zinc-400 hover:text-red-400 transition-colors"
            title="Delete all rounds"
            @click="handleDeleteGroup($event, item)"
          >
            <svg
              class="w-3 h-3"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M6 2h4v1h3v1H3V3h3V2zM4 5h8l-.8 9H4.8L4 5zm2 2v5h1V7H6zm3 0v5h1V7H9z" />
            </svg>
          </button>

          <!-- Expanded rounds -->
          <ul v-if="isGroupExpanded(item.sessionId)">
            <li
              v-for="rec in item.recordings"
              :key="rec.id"
              class="group relative cursor-pointer border-t border-zinc-800/40 transition-colors duration-100"
              :class="selectedId === rec.id ? 'bg-zinc-800' : 'bg-zinc-900/50 hover:bg-zinc-800/60'"
              @click="select(rec.id)"
            >
              <div class="flex items-center gap-2 px-3 py-2 pl-8">
                <!-- Result dot -->
                <span
                  class="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  :class="rec.metadata.result === 'WIN' ? 'bg-green-500' : 'bg-red-500'"
                />
                <span class="text-xs text-zinc-300 font-medium">
                  Round {{ rec.metadata.round ?? '?' }}
                </span>
                <span
                  class="text-[10px] font-bold"
                  :class="rec.metadata.result === 'WIN' ? 'text-green-400' : 'text-red-400'"
                >
                  {{ rec.metadata.result }}
                </span>
                <span class="ml-auto text-[10px] text-zinc-600">
                  {{ formatDuration(rec.metadata.duration) }}
                </span>
              </div>

              <!-- Hover actions -->
              <div class="absolute top-1 right-1 hidden group-hover:flex gap-1">
                <button
                  class="p-1 rounded bg-zinc-900/90 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                  title="Show in Finder"
                  @click="handleOpenFolder($event, rec.id)"
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
                  @click="handleDelete($event, rec.id)"
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
          </ul>
        </li>

        <!-- Regular recording -->
        <li
          v-else
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
                  class="text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none"
                  :class="{
                    'bg-green-900 text-green-300': item.metadata.result === 'WIN',
                    'bg-red-900/70 text-red-400': item.metadata.result === 'LOSS'
                  }"
                >
                  {{ item.metadata.result }}
                </span>
                <span
                  class="text-[10px] px-1.5 py-0.5 rounded-full leading-none"
                  :class="{
                    'bg-blue-900/60 text-blue-300': item.metadata.bracket === '2v2',
                    'bg-purple-900/60 text-purple-300': item.metadata.bracket === '3v3',
                    'bg-zinc-800 text-zinc-500': item.metadata.bracket === 'skirmish',
                    'bg-teal-900/60 text-teal-300': item.metadata.bracket === 'mythic-plus'
                  }"
                >
                  {{ item.metadata.mythicPlus ? `+${item.metadata.mythicPlus.keystoneLevel}` : item.metadata.bracket }}
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

              <!-- Rating change -->
              <div
                v-if="item.metadata.rating !== null"
                class="text-[11px] text-zinc-400 mt-0.5"
              >
                {{ item.metadata.rating.before }}
                <span class="text-zinc-600">→</span>
                <span
                  :class="
                    item.metadata.rating.after >= item.metadata.rating.before
                      ? 'text-green-400'
                      : 'text-red-400'
                  "
                >
                  {{ item.metadata.rating.after }}
                </span>
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
      </template>
    </ul>
  </div>
</template>
