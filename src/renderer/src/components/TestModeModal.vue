<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { toMediaUrl } from '@shared/appUrl'

const emit = defineEmits<{ close: [] }>()

type Phase = 'idle' | 'recording' | 'done' | 'error'

const phase = ref<Phase>('idle')
const secondsRemaining = ref(0)
const errorMessage = ref('')
const videoUrl = ref<string | null>(null)

let unsubscribeCountdown: (() => void) | null = null

async function startTest(): Promise<void> {
  phase.value = 'recording'
  secondsRemaining.value = 10
  unsubscribeCountdown = window.electron.on('testMode:countdown', (payload) => {
    secondsRemaining.value = payload.secondsRemaining
  })

  const result = await window.electron.invoke('testMode:start')

  unsubscribeCountdown?.()
  unsubscribeCountdown = null

  if (result.success) {
    videoUrl.value = result.videoPath ? toMediaUrl(result.videoPath) : null
    phase.value = 'done'
  } else {
    errorMessage.value = result.error ?? 'Unknown error'
    phase.value = 'error'
  }
}

async function handleOk(): Promise<void> {
  videoUrl.value = null
  await window.electron.invoke('testMode:cleanup')
  emit('close')
}

onUnmounted(() => {
  unsubscribeCountdown?.()
})
</script>

<template>
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
    <div
      class="bg-zinc-900 border border-zinc-800 rounded-xl p-5 text-center"
      :class="phase === 'done' ? 'w-[480px]' : 'w-80'"
    >
      <h2 class="text-sm font-semibold text-zinc-200 mb-4">
        Test Mode
      </h2>

      <div v-if="phase === 'idle'">
        <p class="text-xs text-zinc-400 mb-4">
          Records a 10-second clip of the WoW window to verify capture is working.
        </p>
        <button
          class="w-full text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium"
          @click="startTest"
        >
          Press to start test
        </button>
      </div>

      <div v-else-if="phase === 'recording'">
        <p class="text-xs text-zinc-400 mb-2">
          Recording...
        </p>
        <p class="text-3xl font-bold text-blue-400 tabular-nums mb-2">
          {{ secondsRemaining }}s
        </p>
        <p
          v-if="secondsRemaining === 10"
          class="text-xs text-zinc-600"
        >
          Recording will start soon
        </p>
      </div>

      <div v-else-if="phase === 'done'">
        <p class="text-xs text-green-400 mb-3">
          ✓ Test recording captured successfully.
        </p>
        <video
          v-if="videoUrl"
          :src="videoUrl"
          controls
          autoplay
          class="w-full rounded-lg mb-4 bg-black"
        />
        <button
          class="w-full text-xs px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
          @click="handleOk"
        >
          OK
        </button>
      </div>

      <div v-else-if="phase === 'error'">
        <p class="text-xs text-red-400 mb-4">
          Test failed: {{ errorMessage }}
        </p>
        <button
          class="w-full text-xs px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
          @click="handleOk"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>
