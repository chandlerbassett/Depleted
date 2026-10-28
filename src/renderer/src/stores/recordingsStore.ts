import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Recording } from '@shared/ipc.types'

export const useRecordingsStore = defineStore('recordings', () => {
  const recordings = ref<Recording[]>([])
  const selectedId = ref<string | null>(null)

  const selected = ref<Recording | null>(null)
  // A moment to jump to once the selected recording's video loads (from Trends)
  const pendingSeek = ref<{ id: string; at: number } | null>(null)

  function setRecordings(list: Recording[]): void {
    recordings.value = list
  }

  function select(id: string): void {
    selectedId.value = id
    selected.value = recordings.value.find((r) => r.id === id) ?? null
  }

  function openAt(id: string, at: number): void {
    pendingSeek.value = { id, at }
    select(id)
  }

  function takePendingSeek(id: string): number | null {
    const p = pendingSeek.value
    if (p === null || p.id !== id) return null
    pendingSeek.value = null
    return p.at
  }

  function deselect(): void {
    selectedId.value = null
    selected.value = null
  }

  function remove(id: string): void {
    recordings.value = recordings.value.filter((r) => r.id !== id)
    if (selectedId.value === id) {
      deselect()
    }
  }

  return { recordings, selectedId, selected, pendingSeek, setRecordings, select, openAt, takePendingSeek, deselect, remove }
})
