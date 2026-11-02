import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Clip, Recording } from '@shared/ipc.types'

export const useRecordingsStore = defineStore('recordings', () => {
  const recordings = ref<Recording[]>([])
  const selectedId = ref<string | null>(null)
  // A clip open on its own; selectedId is null while one is
  const selectedClipId = ref<string | null>(null)

  const selected = ref<Recording | null>(null)
  // A moment to jump to once the selected recording's video loads (from Trends)
  const pendingSeek = ref<{ id: string; at: number } | null>(null)

  const selectedClip = computed(() => {
    const id = selectedClipId.value
    if (id === null) return null
    for (const recording of recordings.value) {
      const clip = recording.clips.find((c) => c.id === id)
      if (clip !== undefined) return { clip, recording }
    }
    return null
  })

  function setRecordings(list: Recording[]): void {
    recordings.value = list
  }

  function select(id: string): void {
    selectedClipId.value = null
    selectedId.value = id
    selected.value = recordings.value.find((r) => r.id === id) ?? null
  }

  function selectClip(id: string): void {
    selectedId.value = null
    selected.value = null
    selectedClipId.value = id
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
    selectedClipId.value = null
  }

  function remove(id: string): void {
    recordings.value = recordings.value.filter((r) => r.id !== id)
    if (selectedId.value === id) deselect()
    // Its clips went with it
    if (selectedClipId.value !== null && selectedClip.value === null) selectedClipId.value = null
  }

  function updateClips(recordingId: string, update: (clips: Clip[]) => Clip[]): void {
    recordings.value = recordings.value.map((r) => (r.id === recordingId ? { ...r, clips: update(r.clips) } : r))
    if (selected.value?.id === recordingId) selected.value = recordings.value.find((r) => r.id === recordingId) ?? null
  }

  function addClip(clip: Clip): void {
    updateClips(clip.recordingId, (clips) => [...clips, clip])
  }

  function removeClip(clip: Clip): void {
    updateClips(clip.recordingId, (clips) => clips.filter((c) => c.id !== clip.id))
    if (selectedClipId.value === clip.id) selectedClipId.value = null
  }

  return {
    recordings,
    selectedId,
    selected,
    selectedClipId,
    selectedClip,
    pendingSeek,
    setRecordings,
    select,
    selectClip,
    openAt,
    takePendingSeek,
    deselect,
    remove,
    addClip,
    removeClip
  }
})
