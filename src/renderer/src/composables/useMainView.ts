// Composable for the main application view.
// Loads the recording library, subscribes to IPC push events from the main
// process, and exposes recording actions (delete, open in Finder).

import { onMounted, onUnmounted } from 'vue'
import { useRecordingsStore } from '@/stores/recordingsStore'
import { useAppStore } from '@/stores/appStore'

export function useMainView() {
  const recordingsStore = useRecordingsStore()
  const appStore = useAppStore()

  const unsubs: Array<() => void> = []

  async function loadRecordings(): Promise<void> {
    const list = await window.electron.invoke('storage:getRecordings')
    recordingsStore.setRecordings(list)
    if (list.length > 0 && recordingsStore.selectedId === null) {
      recordingsStore.select(list[0].id)
    }
  }

  async function deleteRecording(id: string): Promise<void> {
    await window.electron.invoke('storage:deleteRecording', { id })
    recordingsStore.remove(id)
  }

  async function openFolder(id: string): Promise<void> {
    await window.electron.invoke('storage:openFolder', { id })
  }

  onMounted(async () => {
    // Load initial recordings list
    await loadRecordings()

    // Sync recorder status
    const status = await window.electron.invoke('recorder:getStatus')
    appStore.setStatus(status)

    // Subscribe to push events
    unsubs.push(
      window.electron.on('recorder:statusChanged', (payload) => {
        appStore.setStatus(payload.status, payload.zone)
      })
    )

    unsubs.push(
      window.electron.on('recorder:error', (payload) => {
        appStore.setError(payload.message)
      })
    )

    unsubs.push(
      window.electron.on('storage:recordingProcessed', (payload) => {
        // Prepend the new recording so it appears at the top
        recordingsStore.setRecordings([payload.recording, ...recordingsStore.recordings])
        if (recordingsStore.selectedId === null) {
          recordingsStore.select(payload.recording.id)
        }
      })
    )
  })

  onUnmounted(() => {
    for (const unsub of unsubs) unsub()
  })

  return { deleteRecording, openFolder }
}
