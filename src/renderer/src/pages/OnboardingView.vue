<script setup lang="ts">
import { onMounted } from 'vue'
import { useOnboarding } from '@/composables/useOnboarding'

const emit = defineEmits<{ complete: [] }>()

const {
  step,
  platform,
  totalSteps,
  readyStep,
  wowPath,
  wowPathState,
  permissionStatus,
  permissionChecking,
  addonState,
  addonInstalling,
  addonInstallError,
  ffmpegState,
  ffmpegPath,
  showFfmpegSection,
  captureSources,
  selectedCaptureSource,
  canAdvance,
  init,
  detectWowPath,
  pickWowFolder,
  checkScreenPermission,
  openSystemPreferences,
  checkAddon,
  installAddon,
  checkFfmpeg,
  next,
  back,
  complete
} = useOnboarding()

onMounted(async () => {
  await init()
  await detectWowPath()
})

async function handleComplete(): Promise<void> {
  await complete()
  emit('complete')
}
</script>

<template>
  <div class="min-h-screen bg-[#0f0f0f] flex items-center justify-center p-6">
    <div class="w-full max-w-xl">
      <!-- Header -->
      <div class="mb-8 text-center">
        <h1 class="text-2xl font-semibold text-white mb-1">
          Depleted
        </h1>
        <p class="text-sm text-zinc-400">
          Setup — step {{ step + 1 }} of {{ totalSteps }}
        </p>
      </div>

      <!-- Step indicator -->
      <div class="flex gap-1.5 mb-8">
        <div
          v-for="i in totalSteps"
          :key="i"
          class="h-1 flex-1 rounded-full transition-colors duration-200"
          :class="i - 1 <= step ? 'bg-blue-500' : 'bg-zinc-700'"
        />
      </div>

      <!-- Step content -->
      <div class="bg-[#1a1a1a] border border-zinc-800 rounded-xl p-6 min-h-[280px] flex flex-col">
        <!-- Step 0: WoW Folder -->
        <template v-if="step === 0">
          <h2 class="text-lg font-medium text-white mb-1">
            World of Warcraft folder
          </h2>
          <p class="text-sm text-zinc-400 mb-6">
            The app needs your WoW installation path to watch the combat log.
          </p>

          <div
            class="flex items-center gap-3 p-3 rounded-lg border mb-4"
            :class="{
              'border-zinc-700 bg-zinc-900': wowPathState === 'idle',
              'border-zinc-600 bg-zinc-900': wowPathState === 'checking',
              'border-green-700 bg-green-950/30': wowPathState === 'ok',
              'border-red-700 bg-red-950/30': wowPathState === 'fail'
            }"
          >
            <span class="text-lg">
              <template v-if="wowPathState === 'ok'">✓</template>
              <template v-else-if="wowPathState === 'fail'">✗</template>
              <template v-else>⋯</template>
            </span>
            <span class="text-sm text-zinc-300 flex-1 truncate font-mono">
              {{ wowPath || (platform === 'win32' ? 'C:\\Program Files (x86)\\World of Warcraft' : '/Applications/World of Warcraft') }}
            </span>
          </div>

          <template v-if="wowPathState === 'fail'">
            <p class="text-sm text-red-400 mb-4">
              The selected folder does not appear to be a valid WoW installation (<code
                class="text-xs"
              >_retail_/Logs/</code>
              not found).
            </p>
          </template>

          <template v-if="wowPathState === 'idle'">
            <p class="text-sm text-zinc-400 mb-4">
              WoW was not found at the default location. Please select your WoW folder.
            </p>
          </template>

          <div class="mt-auto flex gap-3">
            <button
              class="btn-secondary flex-1"
              @click="pickWowFolder"
            >
              Choose folder…
            </button>
          </div>
        </template>

        <!-- Step 1: Advanced Combat Logging -->
        <template v-else-if="step === 1">
          <h2 class="text-lg font-medium text-white mb-1">
            Advanced Combat Logging
          </h2>
          <p class="text-sm text-zinc-400 mb-5">
            Advanced Combat Logging must be enabled in WoW — without it the app won't receive
            the arena data it needs to start and stop recordings.
          </p>
          <div class="bg-zinc-900 border border-zinc-700 rounded-lg p-4 mb-5 space-y-3">
            <p class="text-xs text-zinc-400 font-medium uppercase tracking-wider">
              How to enable
            </p>
            <ol class="space-y-2 text-sm text-zinc-300">
              <li class="flex gap-2">
                <span class="text-zinc-500 flex-shrink-0">1.</span>
                Press <code class="text-xs bg-zinc-800 px-1.5 py-0.5 rounded mx-1">Esc</code> in WoW to open the Game Menu
              </li>
              <li class="flex gap-2">
                <span class="text-zinc-500 flex-shrink-0">2.</span>
                Go to <strong class="text-zinc-200">Options → System → Network</strong>
              </li>
              <li class="flex gap-2">
                <span class="text-zinc-500 flex-shrink-0">3.</span>
                Check <strong class="text-zinc-200">Advanced Combat Logging</strong>
              </li>
            </ol>
          </div>
          <p class="text-xs text-zinc-500">
            You only need to do this once — WoW remembers the setting between sessions.
          </p>
        </template>

        <!-- Step 2: Screen Recording -->
        <template v-else-if="step === 2">
          <h2 class="text-lg font-medium text-white mb-1">
            Screen Recording
          </h2>

          <!-- Windows: no permission model -->
          <template v-if="platform === 'win32'">
            <p class="text-sm text-zinc-400 mb-6">
              Windows does not require a screen recording permission — the app can capture
              your screen without any additional setup.
            </p>
            <div class="flex items-center gap-3 p-3 rounded-lg border border-green-700 bg-green-950/30 mb-4">
              <span class="text-lg text-green-400">✓</span>
              <span class="text-sm text-green-400">No permission required on Windows</span>
            </div>
          </template>

          <!-- macOS: TCC permission check -->
          <template v-else>
            <p class="text-sm text-zinc-400 mb-6">
              The app requires Screen Recording access to capture your gameplay.
            </p>

            <div
              class="flex items-center gap-3 p-3 rounded-lg border mb-4"
              :class="{
                'border-green-700 bg-green-950/30': permissionStatus === 'granted',
                'border-yellow-700 bg-yellow-950/30': permissionStatus === 'not-determined',
                'border-red-700 bg-red-950/30': permissionStatus === 'denied'
              }"
            >
              <span class="text-lg">
                <template v-if="permissionStatus === 'granted'">✓</template>
                <template v-else>✗</template>
              </span>
              <span
                class="text-sm flex-1"
                :class="{
                  'text-green-400': permissionStatus === 'granted',
                  'text-yellow-400': permissionStatus === 'not-determined',
                  'text-red-400': permissionStatus === 'denied'
                }"
              >
                <template v-if="permissionStatus === 'granted'">Permission granted</template>
                <template v-else-if="permissionStatus === 'not-determined'">Permission not yet granted</template>
                <template v-else>Permission denied</template>
              </span>
            </div>

            <template v-if="permissionStatus !== 'granted'">
              <p class="text-sm text-zinc-400 mb-4">
                Open
                <strong class="text-zinc-200">System Settings → Privacy &amp; Security → Screen Recording</strong>
                and enable this app. Then click "Check again".
              </p>
              <p class="text-xs text-zinc-500 mb-4">
                After granting access, you may need to restart the app for the change to take effect.
              </p>
            </template>

            <div class="mt-auto flex gap-3">
              <button
                v-if="permissionStatus !== 'granted'"
                class="btn-secondary flex-1"
                @click="openSystemPreferences"
              >
                Open System Settings
              </button>
              <button
                class="btn-secondary flex-1"
                :disabled="permissionChecking"
                @click="checkScreenPermission"
              >
                {{ permissionChecking ? 'Checking…' : 'Check again' }}
              </button>
            </div>
          </template>
        </template>

        <!-- Step 3: Addon -->
        <template v-else-if="step === 3">
          <h2 class="text-lg font-medium text-white mb-1">
            Companion addon
          </h2>
          <p class="text-sm text-zinc-400 mb-6">
            <strong class="text-zinc-200">DepletedCompanion</strong> tracks your character
            name, class and spec — the app uses this to label your recordings. Click
            <strong class="text-zinc-200">Install</strong> to copy it directly from the app package
            into your WoW AddOns folder.
          </p>

          <template v-if="addonState === 'ok'">
            <div
              class="flex items-center gap-2 p-3 rounded-lg border border-green-700 bg-green-950/30 mb-4"
            >
              <span class="text-green-400">✓</span>
              <span class="text-sm text-green-400">DepletedCompanion installed</span>
            </div>
          </template>
          <template v-else-if="addonState === 'fail'">
            <div
              class="flex items-center gap-2 p-3 rounded-lg border border-yellow-700 bg-yellow-950/30 mb-4"
            >
              <span class="text-yellow-400">!</span>
              <span class="text-sm text-yellow-400">
                Addon not found — you can continue, but install it and <code class="text-xs bg-zinc-800 px-1 rounded">/reload</code> in WoW before recording.
              </span>
            </div>
          </template>

          <div
            v-if="addonInstallError"
            class="flex items-center gap-2 p-3 rounded-lg border border-red-700 bg-red-950/30 mb-4"
          >
            <span class="text-red-400">✕</span>
            <span class="text-sm text-red-400">{{ addonInstallError }}</span>
          </div>

          <div class="mt-auto flex gap-3">
            <button
              class="btn-primary flex-1"
              :disabled="addonInstalling || addonState === 'ok'"
              @click="installAddon"
            >
              {{ addonInstalling ? 'Installing…' : addonState === 'ok' ? 'Installed' : 'Install addon' }}
            </button>
            <button
              class="btn-secondary"
              :disabled="addonState === 'checking' || addonInstalling"
              @click="checkAddon"
            >
              {{ addonState === 'checking' ? 'Checking…' : 'Verify' }}
            </button>
          </div>
        </template>

        <!-- Step 4: Homebrew + FFmpeg -->
        <template v-else-if="step === 4">
          <h2 class="text-lg font-medium text-white mb-1">
            <template v-if="platform === 'win32'">
              FFmpeg
            </template>
            <template v-else>
              Video tools
            </template>
          </h2>
          <p class="text-sm text-zinc-400 mb-5">
            <template v-if="platform === 'win32'">
              FFmpeg trims and generates thumbnails for your recordings after each match. Download
              it from
              <button
                class="text-blue-400 hover:text-blue-300 underline"
                @click="() => window.electron.invoke('system:openUrl', { url: 'https://github.com/BtbN/FFmpeg-Builds/releases' })"
              >
                BtbN FFmpeg Builds
              </button> and add it to your PATH, or place
              <code class="text-xs bg-zinc-800 px-1 rounded">ffmpeg.exe</code> in
              <code class="text-xs bg-zinc-800 px-1 rounded">C:\ffmpeg\bin\</code>.
            </template>
            <template v-else>
              Nothing to install. Depleted records, trims and makes thumbnails with macOS's own
              ScreenCaptureKit and hardware video encoder.
            </template>
          </p>

          <!-- FFmpeg check (Windows only; macOS uses the built-in capture helper) -->
          <template v-if="showFfmpegSection">
            <div :class="platform !== 'win32' ? 'border-t border-zinc-800 pt-5' : ''">
              <p
                v-if="platform !== 'win32'"
                class="text-sm font-medium text-zinc-300 mb-2"
              >
                Step B — FFmpeg
              </p>
              <template v-if="ffmpegState === 'ok'">
                <div
                  class="flex items-center gap-2 p-2.5 rounded-lg border border-green-700 bg-green-950/30"
                >
                  <span class="text-green-400">✓</span>
                  <span class="text-sm text-green-400 font-mono truncate">{{ ffmpegPath }}</span>
                </div>
              </template>
              <template v-else-if="ffmpegState === 'fail'">
                <template v-if="platform === 'win32'">
                  <p class="text-sm text-zinc-400 mb-2">
                    FFmpeg was not found. Download it and place
                    <code class="text-xs bg-zinc-800 px-1 rounded">ffmpeg.exe</code> in one of
                    these locations:
                  </p>
                  <ul class="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 space-y-1 mb-3">
                    <li>C:\ffmpeg\bin\ffmpeg.exe</li>
                    <li>C:\Program Files\ffmpeg\bin\ffmpeg.exe</li>
                    <li>Or anywhere on your system PATH</li>
                  </ul>
                  <p class="text-xs text-zinc-500 mb-1">
                    Download from
                    <button
                      class="text-blue-400 hover:text-blue-300 underline"
                      @click="() => window.electron.invoke('system:openUrl', { url: 'https://github.com/BtbN/FFmpeg-Builds/releases' })"
                    >
                      BtbN FFmpeg Builds
                    </button>
                    and pick <code class="bg-zinc-800 px-1 rounded">ffmpeg-master-latest-win64-gpl.zip</code> (not the <em>-shared</em> variant).
                  </p>
                  <p class="text-xs text-zinc-600 mb-3">
                    Extract the zip, then copy <code class="bg-zinc-800 px-1 rounded">ffmpeg.exe</code> from the <code class="bg-zinc-800 px-1 rounded">bin\</code> folder into one of the paths above.
                  </p>
                </template>
                <template v-else>
                  <p class="text-sm text-zinc-400 mb-2">
                    FFmpeg is not installed. Run in Terminal:
                  </p>
                  <code
                    class="block text-xs font-mono bg-zinc-900 border border-zinc-700 p-2.5 rounded-lg text-zinc-300 mb-3"
                  >
                    brew install ffmpeg
                  </code>
                </template>
                <button
                  class="btn-secondary"
                  @click="checkFfmpeg"
                >
                  Check again
                </button>
              </template>
              <template v-else>
                <button
                  class="btn-secondary"
                  :disabled="ffmpegState === 'checking'"
                  @click="checkFfmpeg"
                >
                  {{ ffmpegState === 'checking' ? 'Checking…' : 'Check FFmpeg' }}
                </button>
              </template>
            </div>
          </template>
        </template>

        <!-- Step 5: capture window -->
        <template v-else-if="step === 5">
          <h2 class="text-lg font-medium text-white mb-1">
            Capture window
          </h2>
          <p class="text-sm text-zinc-400 mb-5">
            The app auto-detects the World of Warcraft window and records it directly —
            no configuration needed. Pick a specific window below only if you run
            multiple WoW clients or want to override the detected one (this can also
            be changed later in Settings).
          </p>
          <div class="space-y-2">
            <button
              class="w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left"
              :class="selectedCaptureSource === null
                ? 'bg-blue-600 border-blue-500'
                : 'bg-zinc-900 border-zinc-700 hover:border-zinc-500'"
              @click="selectedCaptureSource = null"
            >
              <span class="text-base">🎯</span>
              <span class="flex-1 text-sm text-zinc-200">Auto-detect World of Warcraft window</span>
              <span
                class="text-xs"
                :class="captureSources.some((s) => s.isLikelyWow) ? 'text-green-400' : 'text-zinc-500'"
              >{{ captureSources.some((s) => s.isLikelyWow) ? 'found' : 'not found yet' }}</span>
            </button>
            <button
              v-for="src in captureSources"
              :key="src.id"
              class="w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left"
              :class="selectedCaptureSource?.id === src.id
                ? 'bg-blue-600 border-blue-500'
                : 'bg-zinc-900 border-zinc-700 hover:border-zinc-500'"
              @click="selectedCaptureSource = src"
            >
              <img
                v-if="src.thumbnailDataUrl"
                :src="src.thumbnailDataUrl"
                class="w-12 h-7 object-cover rounded bg-black/40"
              >
              <span class="flex-1 text-sm text-zinc-200 truncate">{{ src.name }}</span>
              <span class="text-xs text-zinc-400">{{ src.kind }}</span>
            </button>
          </div>
        </template>

        <!-- Step 4 (macOS) / Step 5 (Windows): Ready -->
        <template v-else-if="step === readyStep">
          <h2 class="text-lg font-medium text-white mb-1">
            You are ready
          </h2>
          <p class="text-sm text-zinc-400 mb-6">
            All checks passed. The app will automatically record your arena matches.
          </p>

          <div class="space-y-2 mb-6">
            <div
              class="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-900 border border-zinc-800"
            >
              <span class="text-green-400 text-base">✓</span>
              <span class="text-sm text-zinc-300">WoW folder</span>
              <span class="text-xs text-zinc-500 font-mono ml-auto truncate max-w-[200px]">{{
                wowPath
              }}</span>
            </div>
            <div
              v-if="platform !== 'win32'"
              class="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-900 border border-zinc-800"
            >
              <span class="text-green-400 text-base">✓</span>
              <span class="text-sm text-zinc-300">Screen Recording</span>
            </div>
            <div
              class="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-900 border border-zinc-800"
            >
              <span
                class="text-base"
                :class="addonState === 'ok' ? 'text-green-400' : 'text-yellow-400'"
              >
                {{ addonState === 'ok' ? '✓' : '!' }}
              </span>
              <span class="text-sm text-zinc-300">DepletedCompanion</span>
              <span
                v-if="addonState !== 'ok'"
                class="text-xs text-yellow-500 ml-auto"
              >
                not found — install &amp; /reload in WoW
              </span>
            </div>
            <div
              v-if="platform === 'win32'"
              class="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-900 border border-zinc-800"
            >
              <span class="text-green-400 text-base">✓</span>
              <span class="text-sm text-zinc-300">FFmpeg</span>
              <span class="text-xs text-zinc-500 font-mono ml-auto truncate max-w-[200px]">{{
                ffmpegPath
              }}</span>
            </div>
            <div
              class="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-900 border border-zinc-800"
            >
              <span class="text-green-400 text-base">✓</span>
              <span class="text-sm text-zinc-300">Capture window</span>
              <span class="text-xs text-zinc-500 ml-auto">{{ selectedCaptureSource?.name ?? 'Auto-detect' }}</span>
            </div>
          </div>
        </template>
      </div>

      <!-- Navigation -->
      <div class="flex gap-3 mt-4">
        <button
          v-if="step > 0"
          class="btn-secondary w-24"
          @click="back"
        >
          Back
        </button>
        <div class="flex-1" />

        <template v-if="step < totalSteps - 1">
          <button
            class="btn-primary w-28"
            :disabled="!canAdvance"
            @click="next"
          >
            Continue
          </button>
        </template>
        <template v-else>
          <button
            class="btn-primary w-28"
            @click="handleComplete"
          >
            Start
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.btn-primary {
  @apply px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500
         text-white text-sm font-medium rounded-lg transition-colors duration-150 cursor-pointer
         disabled:cursor-not-allowed;
}

.btn-secondary {
  @apply px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-600
         text-zinc-200 text-sm font-medium rounded-lg border border-zinc-700
         transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed;
}
</style>
