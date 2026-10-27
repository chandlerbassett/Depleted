<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{ close: [] }>()

type Status = 'idle' | 'installing' | 'done' | 'error'

const status = ref<Status>('idle')
const errorMessage = ref('')

async function handleUpdate(): Promise<void> {
  status.value = 'installing'
  const config = await window.electron.invoke('config:getAll')
  const result = await window.electron.invoke('system:installAddon', { wowPath: config.wowPath })
  if (result.success) {
    status.value = 'done'
  } else {
    errorMessage.value = result.error ?? 'Unknown error'
    status.value = 'error'
  }
}
</script>

<template>
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
    <div class="bg-zinc-900 border border-zinc-800 rounded-xl w-96 p-5">
      <h2 class="text-sm font-semibold text-zinc-200 mb-3">
        Addon update available
      </h2>

      <div v-if="status === 'idle' || status === 'installing'">
        <p class="text-xs text-zinc-400 mb-4">
          Your installed DepletedCompanion addon is out of date. Updating it fixes how
          the app tells "connected" from a stale session — install the new version, then
          type <span class="text-zinc-200 font-mono">/reload</span> in WoW (or log out and
          back in) for it to take effect.
        </p>
        <div class="flex gap-2 justify-end">
          <button
            class="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
            :disabled="status === 'installing'"
            @click="emit('close')"
          >
            Later
          </button>
          <button
            class="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium disabled:opacity-50"
            :disabled="status === 'installing'"
            @click="handleUpdate"
          >
            {{ status === 'installing' ? 'Updating…' : 'Update addon' }}
          </button>
        </div>
      </div>

      <div v-else-if="status === 'done'">
        <p class="text-xs text-green-400 mb-4">
          ✓ Addon updated. Type <span class="font-mono">/reload</span> in WoW (or log out
          and back in) to apply it.
        </p>
        <div class="flex justify-end">
          <button
            class="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
            @click="emit('close')"
          >
            OK
          </button>
        </div>
      </div>

      <div v-else-if="status === 'error'">
        <p class="text-xs text-red-400 mb-4">
          Update failed: {{ errorMessage }}
        </p>
        <div class="flex justify-end">
          <button
            class="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
            @click="emit('close')"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
