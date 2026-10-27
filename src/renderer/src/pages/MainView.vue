<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useAppStore } from '@/stores/appStore'
import { useRecordingsStore } from '@/stores/recordingsStore'
import { useStatsLinkStore } from '@/stores/statsLinkStore'
import { useMainView } from '@/composables/useMainView'
import RecordingList from '@/components/RecordingList.vue'
import VideoPlayer from '@/components/VideoPlayer.vue'
import SettingsView from '@/pages/SettingsView.vue'
import PvpHubView from '@/pages/PvpHubView.vue'
import AddonUpdateModal from '@/components/AddonUpdateModal.vue'
const appStore = useAppStore()
const recordingsStore = useRecordingsStore()
const statsLinkStore = useStatsLinkStore()

const { status, currentZone, lastError, recordingStartedAt } = storeToRefs(appStore)
const { selected } = storeToRefs(recordingsStore)

const { deleteRecording, deleteGroup, openFolder } = useMainView()

const settingsOpen = ref(false)
const activeTab = ref<'2v2' | '3v3' | 'solo-shuffle' | 'skirmish' | 'mythic-plus' | 'hub'>('2v2')

// -------------------------------------------------------------------------
// Live recording elapsed-time indicator — ticks once per second while
// status === 'recording', driven off appStore.recordingStartedAt.
// -------------------------------------------------------------------------

const nowTick = ref(Date.now())
let elapsedTimer: ReturnType<typeof setInterval> | null = null

const elapsedLabel = computed(() => {
  if (recordingStartedAt.value === null) return null
  const secs = Math.max(0, Math.floor((nowTick.value - recordingStartedAt.value) / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
})

// -------------------------------------------------------------------------
// Error banner
// -------------------------------------------------------------------------

const errorCopied = ref(false)

async function copyError(): Promise<void> {
  if (lastError.value === null) return
  await navigator.clipboard.writeText(lastError.value)
  errorCopied.value = true
  setTimeout(() => { errorCopied.value = false }, 1500)
}

const BRACKET_TABS = [
  { key: '2v2' as const, label: '2v2' },
  { key: '3v3' as const, label: '3v3' },
  { key: 'solo-shuffle' as const, label: 'Shuffle' },
  { key: 'skirmish' as const, label: 'Skirmish' },
  { key: 'mythic-plus' as const, label: 'Mythic+' },
] as const

const { recordings } = storeToRefs(recordingsStore)

function bracketCount(bracket: string): number {
  return recordings.value.filter((r) => r.metadata.bracket === bracket).length
}

const filteredRecordings = computed(() =>
  recordings.value.filter((r) => r.metadata.bracket === activeTab.value)
)

// -------------------------------------------------------------------------
// Addon connection status — polls every 5 s (SavedVars flush on WoW reload)
// -------------------------------------------------------------------------

const addonConnected = ref(false)
const addonCharacter = ref('')
const showAddonUpdateModal = ref(false)
let addonUpdatePromptShown = false

let addonPollTimer: ReturnType<typeof setInterval> | null = null
let unsubAddon: (() => void) | null = null

function applyAddonStatus(result: { connected: boolean; name?: string; spec?: string; needsUpdate?: boolean }): void {
  addonConnected.value = result.connected
  addonCharacter.value =
    result.connected && result.name
      ? result.spec
        ? `${result.name} · ${result.spec}`
        : result.name
      : ''
  // Prompt once per app session — the user can dismiss it and keep using the app.
  if (result.needsUpdate && !addonUpdatePromptShown) {
    addonUpdatePromptShown = true
    showAddonUpdateModal.value = true
  }
}

async function refreshAddonStatus(): Promise<void> {
  const result = await window.electron.invoke('system:getAddonStatus')
  applyAddonStatus(result)
}

// -------------------------------------------------------------------------
// Donate button
// -------------------------------------------------------------------------

const DONATE_URL = 'https://www.donationalerts.com/r/alex_mu7'

async function openDonate(): Promise<void> {
  const result = await window.electron.invoke('system:openUrl', { url: DONATE_URL })
  if (!result.success) {
    appStore.setError(`Couldn't open the donation page: ${result.error ?? 'unknown error'}`)
  }
}

// -------------------------------------------------------------------------
// Screen recording permission check
// -------------------------------------------------------------------------

const screenPermission = ref<'granted' | 'denied' | 'not-determined'>('granted')

async function checkScreenPermission(): Promise<void> {
  const result = await window.electron.invoke('system:checkScreenPermission')
  screenPermission.value = result.status
}

async function openSystemPreferences(): Promise<void> {
  await window.electron.invoke('system:openSystemPreferences')
}

onMounted(() => {
  void refreshAddonStatus()
  void checkScreenPermission()
  void statsLinkStore.load()
  // Push updates from main process whenever WoW writes SavedVariables
  unsubAddon = window.electron.on('addon:statusChanged', applyAddonStatus)
  // Slow fallback poll in case the file was already current on mount
  addonPollTimer = setInterval(() => { void refreshAddonStatus() }, 30000)
  elapsedTimer = setInterval(() => { nowTick.value = Date.now() }, 1000)
})

onUnmounted(() => {
  if (addonPollTimer !== null) clearInterval(addonPollTimer)
  if (elapsedTimer !== null) clearInterval(elapsedTimer)
  unsubAddon?.()
})

// -------------------------------------------------------------------------
// Status indicator
// -------------------------------------------------------------------------

const statusLabel = computed(() => {
  switch (status.value) {
    case 'idle':
      return 'Idle'
    case 'waiting':
      return `Watching${currentZone.value ? ' · ' + currentZone.value : ''}`
    case 'recording':
      return `Recording${elapsedLabel.value ? ' · ' + elapsedLabel.value : ''}${currentZone.value ? ' · ' + currentZone.value : ''}`
    case 'processing':
      return 'Processing…'
    case 'error':
      return lastError.value ?? 'Error'
    default:
      return ''
  }
})

const statusDotClass = computed(() => {
  switch (status.value) {
    case 'idle':
      return 'bg-zinc-600'
    case 'waiting':
      return 'bg-yellow-400 animate-pulse'
    case 'recording':
      return 'bg-red-500 animate-pulse'
    case 'processing':
      return 'bg-blue-400 animate-pulse'
    case 'error':
      return 'bg-red-600'
    default:
      return 'bg-zinc-600'
  }
})

const statusTextClass = computed(() => {
  switch (status.value) {
    case 'recording':
      return 'text-red-400'
    case 'error':
      return 'text-red-400'
    case 'waiting':
      return 'text-yellow-400'
    case 'processing':
      return 'text-blue-400'
    default:
      return 'text-zinc-500'
  }
})
</script>

<template>
  <div class="flex flex-col h-screen bg-[#0f0f0f] overflow-hidden">
    <!-- ----------------------------------------------------------------- -->
    <!-- Title bar (macOS hiddenInset — traffic lights inset top-left)      -->
    <!-- ----------------------------------------------------------------- -->
    <div
      class="flex-shrink-0 h-10 flex items-center px-4 border-b border-zinc-800/60 select-none"
      style="-webkit-app-region: drag"
    >
      <!-- Traffic light spacer (≈ 72px for macOS controls) -->
      <div class="w-[72px]" />

      <span class="flex-1 text-center text-xs text-zinc-500 font-medium tracking-wide">
        WoW Arena Recorder
      </span>

      <!-- Right side: status + settings button -->
      <div
        class="flex items-center gap-3"
        style="-webkit-app-region: no-drag"
      >
        <!-- Addon connection indicator -->
        <div
          class="flex items-center gap-1.5"
          :title="addonConnected ? 'Addon connected — ' + addonCharacter : 'Addon not detected. Install via Settings and /reload in WoW.'"
        >
          <span :class="['w-1.5 h-1.5 rounded-full', addonConnected ? 'bg-green-500' : 'bg-zinc-600']" />
          <span :class="['text-xs', addonConnected ? 'text-green-400' : 'text-zinc-600']">
            {{ addonConnected ? addonCharacter || 'Addon' : 'No addon' }}
          </span>
        </div>

        <!-- Divider -->
        <span class="w-px h-3 bg-zinc-700" />

        <!-- Recorder status indicator -->
        <div class="flex items-center gap-1.5">
          <span :class="['w-1.5 h-1.5 rounded-full', statusDotClass]" />
          <span :class="['text-xs', statusTextClass]">{{ statusLabel }}</span>
        </div>

        <!-- Donate button -->
        <button
          class="px-2 py-0.5 rounded text-xs font-medium bg-pink-950/60 text-pink-400 hover:bg-pink-900/60 hover:text-pink-300 transition-colors"
          title="Донаты и ваша поддержка помогают и мотивируют меня развивать данный проект. Спасибо!"
          @click="openDonate"
        >
          Donate
        </button>

        <!-- Settings button -->
        <button
          class="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 transition-colors"
          :class="settingsOpen ? 'bg-zinc-700 text-zinc-300' : ''"
          title="Settings"
          @click="settingsOpen = !settingsOpen"
        >
          <svg
            class="w-3.5 h-3.5"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path
              d="M8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492zM5.754 8a2.246 2.246 0 114.492 0 2.246 2.246 0 01-4.492 0z"
            />
            <path
              d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 01-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 01-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 01.52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 011.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 011.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 01.52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 01-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 01-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 002.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 001.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 00-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 00-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 00-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 003.06 9.377l-.318-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 004.176 4.92l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 002.692-1.115l.094-.319z"
            />
          </svg>
        </button>
      </div>
    </div>

    <!-- ----------------------------------------------------------------- -->
    <!-- Main layout                                                        -->
    <!-- ----------------------------------------------------------------- -->
    <div class="flex flex-1 min-h-0 relative">
      <!-- Error banner — floats above everything so a recorder error is never missed,
           regardless of which panel/tab is active. -->
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        enter-from-class="opacity-0 -translate-y-2"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition-all duration-150 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-2"
      >
        <div
          v-if="lastError"
          class="absolute top-3 right-3 z-30 w-96 max-w-[calc(100%-1.5rem)] rounded-lg border border-red-800/60 bg-red-950/95 backdrop-blur-sm shadow-2xl p-3"
        >
          <div class="flex items-start gap-2">
            <span class="text-red-400 text-sm mt-0.5 flex-shrink-0">⚠</span>
            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium text-red-300 mb-1">
                Recording error
              </p>
              <p class="text-xs text-red-200/90 break-words">
                {{ lastError }}
              </p>
            </div>
            <button
              class="flex-shrink-0 text-red-400 hover:text-red-200 transition-colors"
              title="Dismiss"
              @click="appStore.clearError()"
            >
              <svg
                class="w-3.5 h-3.5"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
              </svg>
            </button>
          </div>
          <div class="flex gap-2 mt-2 pl-6">
            <button
              class="text-xs px-2 py-1 rounded bg-red-900/60 hover:bg-red-800/60 text-red-200 transition-colors"
              @click="copyError"
            >
              {{ errorCopied ? 'Copied ✓' : 'Copy' }}
            </button>
            <button
              class="text-xs px-2 py-1 rounded bg-red-900/60 hover:bg-red-800/60 text-red-200 transition-colors"
              @click="appStore.clearError()"
            >
              Dismiss
            </button>
          </div>
        </div>
      </Transition>

      <!-- Tab bar -->
      <div
        class="absolute top-0 left-0 right-0 flex items-center border-b border-zinc-800/60 bg-[#0f0f0f] z-10"
        style="-webkit-app-region: no-drag"
      >
        <!-- Bracket tabs -->
        <button
          v-for="tab in BRACKET_TABS"
          :key="tab.key"
          class="flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors border-b-2"
          :class="activeTab === tab.key
            ? 'text-zinc-200 border-zinc-400'
            : 'text-zinc-500 border-transparent hover:text-zinc-300'"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
          <span
            class="text-[10px] px-1 py-0.5 rounded leading-none"
            :class="activeTab === tab.key ? 'bg-zinc-600 text-zinc-300' : 'bg-zinc-800 text-zinc-600'"
          >{{ bracketCount(tab.key) }}</span>
        </button>

        <!-- Divider -->
        <span class="w-px h-4 bg-zinc-800 mx-1" />

        <!-- My PVP Hub tab -->
        <button
          class="flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors border-b-2"
          :class="activeTab === 'hub'
            ? 'text-zinc-200 border-zinc-400'
            : 'text-zinc-500 border-transparent hover:text-zinc-300'"
          @click="activeTab = 'hub'"
        >
          My PVP Hub
        </button>
      </div>

      <!-- Tab content (offset for tab bar height ~33px) -->
      <div
        v-if="activeTab === 'hub'"
        class="flex flex-1 min-h-0 mt-[33px] w-full"
      >
        <PvpHubView :recordings="recordings" />
      </div>
      <div
        v-else
        class="flex flex-1 min-h-0 mt-[33px] w-full"
      >
        <!-- Sidebar -->
        <aside class="flex-shrink-0 w-72 border-r border-zinc-800/60 flex flex-col overflow-hidden">
          <RecordingList
            class="flex-1 min-h-0"
            :recordings="filteredRecordings"
            :on-delete="deleteRecording"
            :on-delete-group="deleteGroup"
            :on-open-folder="openFolder"
          />
        </aside>

        <!-- Main panel -->
        <main class="flex-1 min-w-0 flex flex-col overflow-hidden">
          <VideoPlayer
            v-if="selected !== null"
            :recording="selected"
            class="flex-1 min-h-0 overflow-y-auto"
          />
          <div
            v-else
            class="flex-1 flex flex-col items-center justify-center text-center px-8"
          >
            <div class="w-16 h-16 rounded-full bg-zinc-800/60 flex items-center justify-center mb-4">
              <svg
                class="w-7 h-7 text-zinc-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9A2.25 2.25 0 0013.5 5.25h-9A2.25 2.25 0 002.25 7.5v9A2.25 2.25 0 004.5 18.75z"
                />
              </svg>
            </div>
            <p class="text-zinc-300 text-sm font-medium">
              Select a recording
            </p>
            <p class="text-zinc-600 text-xs mt-1 max-w-[260px]">
              Choose a match from the sidebar to watch the replay and review the timeline.
            </p>
            <div
              v-if="screenPermission !== 'granted'"
              class="mt-6 px-4 py-3 rounded-lg bg-red-950/40 border border-red-800/50 text-left max-w-[280px]"
            >
              <p class="text-xs font-medium text-red-400 mb-1">Screen recording permission denied</p>
              <p class="text-xs text-zinc-400 mb-3">
                Recording won't work until this is granted in macOS System Settings.
              </p>
              <div class="flex gap-2">
                <button
                  class="text-xs px-3 py-1.5 rounded bg-red-800/50 hover:bg-red-700/50 text-red-200 transition-colors"
                  @click="openSystemPreferences"
                >
                  Open Settings
                </button>
                <button
                  class="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                  @click="checkScreenPermission"
                >
                  Re-check
                </button>
              </div>
            </div>
            <template v-if="status === 'idle'">
              <div class="mt-6 px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 text-left max-w-[280px]">
                <p class="text-xs text-zinc-400">
                  <span class="text-zinc-200 font-medium">Auto-record is active.</span>
                  Launch WoW and enter an arena — recording starts automatically when a match begins.
                </p>
              </div>
            </template>
          </div>
        </main>
      </div>

      <!-- ----------------------------------------------------------------- -->
      <!-- Settings panel — slide in from the right                          -->
      <!-- ----------------------------------------------------------------- -->
      <Transition
        enter-active-class="transition-transform duration-200 ease-out"
        enter-from-class="translate-x-full"
        enter-to-class="translate-x-0"
        leave-active-class="transition-transform duration-150 ease-in"
        leave-from-class="translate-x-0"
        leave-to-class="translate-x-full"
      >
        <div
          v-if="settingsOpen"
          class="absolute top-0 right-0 h-full w-[75%] border-l border-zinc-800 shadow-2xl z-20"
        >
          <SettingsView @close="settingsOpen = false" />
        </div>
      </Transition>

      <!-- Backdrop: clicking outside closes the panel -->
      <Transition
        enter-active-class="transition-opacity duration-200"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="transition-opacity duration-150"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          v-if="settingsOpen"
          class="absolute inset-0 bg-black/30 z-10"
          @click="settingsOpen = false"
        />
      </Transition>
    </div>

    <AddonUpdateModal
      v-if="showAddonUpdateModal"
      @close="showAddonUpdateModal = false"
    />
  </div>
</template>
