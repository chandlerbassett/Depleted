<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRecordingsStore } from '@/stores/recordingsStore'
import type { Clip, Recording } from '@shared/ipc.types'
import { RAID_DIFFICULTY_LABEL } from '@shared/constants'
import { toMediaUrl } from '@shared/appUrl'
import { clipSourceLabel, levelBadge, outcomeLabel, recordingTitle } from '@/utils/recordingLabels'
import { allClips, groupRaidNights } from '@/utils/sidebarGroups'
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
// Sections and what's expanded, remembered between launches
// -------------------------------------------------------------------------

type Section = 'mythic-plus' | 'raids' | 'clips'
const STORAGE_KEY = 'depleted.sidebar'

function loadOpen(): { sections: Section[]; nights: string[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as { sections?: Section[]; nights?: string[] }
    return { sections: saved.sections ?? ['mythic-plus', 'raids', 'clips'], nights: saved.nights ?? [] }
  } catch {
    return { sections: ['mythic-plus', 'raids', 'clips'], nights: [] }
  }
}

const saved = loadOpen()
const openSections = ref(new Set<Section>(saved.sections))
const openNights = ref(new Set<string>(saved.nights))

function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ sections: [...openSections.value], nights: [...openNights.value] }))
}

function toggleSection(s: Section): void {
  if (openSections.value.has(s)) openSections.value.delete(s)
  else openSections.value.add(s)
  persist()
}

function toggleNight(id: string): void {
  if (openNights.value.has(id)) openNights.value.delete(id)
  else openNights.value.add(id)
  persist()
}

// -------------------------------------------------------------------------
// Mythic+
// -------------------------------------------------------------------------

interface DateGroup {
  day: string
  label: string
  items: Recording[]
}

const keys = computed(() => props.recordings.filter((r) => r.metadata.mythicPlus !== undefined))

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
// Raids
// -------------------------------------------------------------------------

const nights = computed(() => groupRaidNights(props.recordings))

// Nights already opened for the user once, so closing one sticks
const seenNights = new Set<string>(saved.nights)
// The newest night, and whichever holds the selected pull, open without a click
watch(
  [nights, selectedId],
  ([list, id]) => {
    const newest = list[0]
    const holding = list.find((n) => n.bosses.some((b) => b.pulls.some((p) => p.id === id)))
    let changed = false
    for (const n of [newest, holding]) {
      if (n !== undefined && !openNights.value.has(n.id) && !seenNights.has(n.id)) {
        openNights.value.add(n.id)
        changed = true
      }
      if (n !== undefined) seenNights.add(n.id)
    }
    if (changed) persist()
  },
  { immediate: true }
)

function nightLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

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
        Start WoW and run a Mythic+ key or pull a raid boss. Depleted records it automatically.
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
                  :src="toMediaUrl(item.thumbnailPath)"
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
                  {{ recordingTitle(item.metadata) }}
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
      <!-- Raids: night → boss → pull                                       -->
      <!-- ================================================================ -->
      <button
        class="sticky top-0 z-20 w-full flex items-center gap-2 px-3 py-2 bg-[#0f0f0f] border-b border-zinc-800 text-left hover:bg-zinc-900"
        @click="toggleSection('raids')"
      >
        <span class="text-[10px] text-zinc-600 w-2">{{ openSections.has('raids') ? '▼' : '▶' }}</span>
        <span class="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex-1">Raids</span>
        <span class="text-[10px] text-zinc-600 tabular-nums">{{ nights.length }}</span>
      </button>
      <ul v-if="openSections.has('raids')">
        <li
          v-if="nights.length === 0"
          class="px-3 py-2 text-[11px] text-zinc-600"
        >
          No raid pulls recorded yet
        </li>
        <li
          v-for="night in nights"
          :key="night.id"
          class="border-b border-zinc-800/60"
        >
          <button
            class="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-zinc-800/40"
            @click="toggleNight(night.id)"
          >
            <span class="text-[10px] text-zinc-600 w-2 mt-0.5">{{ openNights.has(night.id) ? '▼' : '▶' }}</span>
            <div class="min-w-0 flex-1">
              <p class="text-xs text-zinc-200 font-medium truncate">
                {{ night.zone }}
              </p>
              <p class="text-[11px] text-zinc-500 mt-0.5">
                {{ nightLabel(night.startedAt) }}
                · {{ night.difficulties.map((d) => RAID_DIFFICULTY_LABEL[d]).join(' / ') }}
                · {{ night.pullCount }} pull{{ night.pullCount === 1 ? '' : 's' }}
                <span
                  v-if="night.killCount > 0"
                  class="text-green-400"
                >· {{ night.killCount }} kill{{ night.killCount === 1 ? '' : 's' }}</span>
              </p>
            </div>
          </button>

          <div
            v-if="openNights.has(night.id)"
            class="pb-1"
          >
            <div
              v-for="boss in night.bosses"
              :key="boss.encounterId"
            >
              <div class="flex items-center gap-2 pl-7 pr-3 pt-1.5 pb-0.5">
                <span class="text-[11px] font-semibold text-zinc-400 truncate flex-1">{{ boss.name }}</span>
                <span
                  class="text-[10px]"
                  :class="boss.killed ? 'text-green-400' : 'text-zinc-600'"
                >{{ boss.killed ? 'Killed' : `${boss.pulls.length} pull${boss.pulls.length === 1 ? '' : 's'}` }}</span>
              </div>

              <div
                v-for="pull in boss.pulls"
                :key="pull.id"
                class="group relative cursor-pointer transition-colors"
                :class="selectedId === pull.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'"
                @click="select(pull.id)"
              >
                <div class="flex items-center gap-2 pl-7 pr-2 py-1">
                  <div
                    class="w-14 flex-shrink-0 bg-zinc-900 rounded-sm overflow-hidden"
                    style="aspect-ratio: 16/9"
                  >
                    <img
                      :src="toMediaUrl(pull.thumbnailPath)"
                      class="w-full h-full object-cover"
                      loading="lazy"
                      @error="($event.target as HTMLImageElement).style.display = 'none'"
                    >
                  </div>
                  <span class="text-[11px] text-zinc-300 tabular-nums">
                    {{ pull.metadata.raid!.pullNumber > 0 ? `Pull ${pull.metadata.raid!.pullNumber}` : 'Pull' }}
                  </span>
                  <span
                    class="text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none"
                    :class="pull.metadata.result === 'WIN' ? 'bg-green-900 text-green-300' : 'bg-red-900/70 text-red-400'"
                  >{{ outcomeLabel(pull.metadata) }}</span>
                  <span
                    v-if="night.difficulties.length > 1"
                    class="text-[10px] text-amber-300/80"
                  >{{ levelBadge(pull.metadata) }}</span>
                  <span class="ml-auto text-[10px] text-zinc-500 tabular-nums">
                    <template v-if="pull.clips.length > 0">✂ {{ pull.clips.length }} · </template>{{ formatDuration(pull.metadata.duration) }}
                  </span>
                </div>

                <!-- Hover actions -->
                <div class="absolute top-1 right-1 hidden group-hover:flex gap-1">
                  <button
                    class="p-1 rounded bg-zinc-900/90 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                    title="Show in Finder"
                    @click="handleOpenFolder($event, pull.id)"
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
                    title="Delete pull"
                    @click="handleDelete($event, pull.id)"
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

                <!-- The pull's clips -->
                <div
                  v-if="pull.clips.length > 0"
                  class="pl-14"
                >
                  <SidebarClipRow
                    v-for="clip in pull.clips"
                    :key="clip.id"
                    :clip="clip"
                    :selected="selectedClipId === clip.id"
                    @select="selectClip(clip.id)"
                    @delete="onDeleteClip(clip)"
                  />
                </div>
              </div>
            </div>
          </div>
        </li>
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
