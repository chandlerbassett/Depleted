// Settings composable.
// Loads the full AppConfig on mount and provides typed setters that persist each
// change immediately via config:set. Path changes (wowPath, storagePath) require
// an app restart to take effect in the recording pipeline.

import { ref, computed, onMounted } from 'vue'
import type { AppConfig, CaptureSource, StatsSite, VideoCodec, WowRegion } from '@shared/ipc.types'
import { useStatsLinkStore } from '@/stores/statsLinkStore'
import { normalizeStatsSite } from '@/utils/characterLinks'

export type BitratePreset = 'low' | 'medium' | 'high' | 'custom'

const BITRATE_PRESETS: Record<Exclude<BitratePreset, 'custom'>, number> = {
  low: 30000,
  medium: 50000,
  high: 80000
}

export const MAX_CUSTOM_BITRATE_MBPS = 100

function detectPreset(bitrate: number): BitratePreset {
  for (const [key, value] of Object.entries(BITRATE_PRESETS)) {
    if (value === bitrate) return key as BitratePreset
  }
  return 'custom'
}

export function useSettings() {
  const statsLinkStore = useStatsLinkStore()
  const config = ref<AppConfig | null>(null)
  const loading = ref(true)
  const platform = ref('darwin')
  // True when a path that requires restart has been changed since last load/restart
  const restartRequired = ref(false)

  async function load(): Promise<void> {
    const [cfg, plt] = await Promise.all([
      window.electron.invoke('config:getAll'),
      window.electron.invoke('system:getPlatform'),
    ])
    config.value = cfg
    platform.value = plt.platform
    loading.value = false
  }

  async function set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): Promise<void> {
    if (config.value === null) return
    config.value[key] = value
    await window.electron.invoke('config:set', { key, value })
  }

  // -------------------------------------------------------------------------
  // WoW path
  // -------------------------------------------------------------------------

  async function pickWowPath(): Promise<void> {
    const { path } = await window.electron.invoke('system:pickFolder')
    if (path === null) return
    const { valid } = await window.electron.invoke('system:checkWowPath', { path })
    if (!valid) return
    await set('wowPath', path)
    restartRequired.value = true
  }

  // -------------------------------------------------------------------------
  // Storage path
  // -------------------------------------------------------------------------

  async function pickStoragePath(): Promise<void> {
    const { path } = await window.electron.invoke('system:pickFolder')
    if (path === null) return
    await set('storagePath', path)
    restartRequired.value = true
  }

  // -------------------------------------------------------------------------
  // Video quality
  // -------------------------------------------------------------------------

  // Picking Custom keeps the current bitrate and shows the input, even when that
  // bitrate happens to match a preset.
  const customSelected = ref(false)

  const bitratePreset = computed<BitratePreset>({
    get: () => {
      if (config.value === null) return 'medium'
      return customSelected.value ? 'custom' : detectPreset(config.value.videoBitrate)
    },
    set: (preset) => {
      if (config.value === null) return
      if (preset === 'custom') {
        customSelected.value = true
        return
      }
      customSelected.value = false
      void set('videoBitrate', BITRATE_PRESETS[preset])
    }
  })

  // In Mbps for the input; stored as kbps.
  const customBitrate = computed<number>({
    get: () => Math.round((config.value?.videoBitrate ?? 30000) / 1000),
    set: (mbps) => {
      if (config.value === null || !Number.isFinite(mbps)) return
      const clamped = Math.min(MAX_CUSTOM_BITRATE_MBPS, Math.max(1, Math.round(mbps)))
      void set('videoBitrate', clamped * 1000)
    }
  })

  async function setCodec(codec: VideoCodec): Promise<void> {
    await set('videoCodec', codec)
  }

  async function setFps(fps: 30 | 60): Promise<void> {
    await set('videoFps', fps)
  }

  async function setResolution(res: string): Promise<void> {
    await set('videoResolution', res)
  }

  // -------------------------------------------------------------------------
  // Capture source (window/screen picker)
  // -------------------------------------------------------------------------

  const captureSources = ref<CaptureSource[]>([])
  const sourcesLoading = ref(false)

  async function loadCaptureSources(): Promise<void> {
    sourcesLoading.value = true
    try {
      captureSources.value = await window.electron.invoke('system:listCaptureWindows')
    } finally {
      sourcesLoading.value = false
    }
  }

  async function selectCaptureSource(source: CaptureSource): Promise<void> {
    await set('captureSourceHint', source.name)
  }

  async function selectAutoDetect(): Promise<void> {
    await set('captureSourceHint', 'auto')
  }

  // -------------------------------------------------------------------------
  // Addon
  // -------------------------------------------------------------------------

  const addonAlreadyInstalled = ref(false)

  async function checkAddonInstalled(): Promise<void> {
    if (config.value === null) return
    const { found } = await window.electron.invoke('system:checkAddon', { wowPath: config.value.wowPath })
    addonAlreadyInstalled.value = found
  }

  async function installAddon(): Promise<{ success: boolean; error?: string }> {
    if (config.value === null) return { success: false, error: 'Config not loaded' }
    const result = await window.electron.invoke('system:installAddon', { wowPath: config.value.wowPath })
    if (result.success) addonAlreadyInstalled.value = true
    return result
  }

  // -------------------------------------------------------------------------
  // Auto-cleanup
  // -------------------------------------------------------------------------

  const cleanupDaysEnabled = computed<boolean>({
    get: () => config.value?.autoCleanupDays !== null && config.value?.autoCleanupDays !== undefined,
    set: (enabled) => {
      if (config.value === null) return
      void set('autoCleanupDays', enabled ? 30 : null)
    },
  })

  const cleanupDays = computed<number>({
    get: () => config.value?.autoCleanupDays ?? 30,
    set: (days) => {
      if (config.value === null || !cleanupDaysEnabled.value) return
      void set('autoCleanupDays', days)
    },
  })

  const cleanupGbEnabled = computed<boolean>({
    get: () =>
      config.value?.autoCleanupMaxGb !== null && config.value?.autoCleanupMaxGb !== undefined,
    set: (enabled) => {
      if (config.value === null) return
      void set('autoCleanupMaxGb', enabled ? 50 : null)
    },
  })

  const cleanupGb = computed<number>({
    get: () => config.value?.autoCleanupMaxGb ?? 50,
    set: (gb) => {
      if (config.value === null || !cleanupGbEnabled.value) return
      void set('autoCleanupMaxGb', gb)
    },
  })

  // -------------------------------------------------------------------------
  // App behaviour
  // -------------------------------------------------------------------------

  const minimizeToTray = computed<boolean>({
    get: () => config.value?.minimizeToTray ?? true,
    set: (enabled) => {
      if (config.value === null) return
      void set('minimizeToTray', enabled)
    },
  })

  // -------------------------------------------------------------------------
  // Character stats site + region
  // -------------------------------------------------------------------------

  const statsSite = computed<StatsSite>({
    get: () => normalizeStatsSite(config.value?.statsSite),
    set: (site) => {
      if (config.value === null) return
      void set('statsSite', site)
      statsLinkStore.setStatsSite(site)
    },
  })

  const wowRegion = computed<WowRegion>({
    get: () => config.value?.wowRegion ?? 'eu',
    set: (region) => {
      if (config.value === null) return
      void set('wowRegion', region)
      statsLinkStore.setWowRegion(region)
    },
  })

  // -------------------------------------------------------------------------
  // Relaunch
  // -------------------------------------------------------------------------

  async function relaunch(): Promise<void> {
    await window.electron.invoke('system:relaunch')
  }

  // Resets the onboarding flag and relaunches so the user can re-run the guided
  // setup checklist (WoW folder, permission, addon, FFmpeg, capture window) — useful
  // when something's misconfigured and the scattered Settings controls aren't as
  // clear as the step-by-step wizard.
  async function rerunSetupWizard(): Promise<void> {
    await window.electron.invoke('config:set', { key: 'onboardingComplete', value: false })
    await relaunch()
  }

  onMounted(async () => {
    await load()
    void loadCaptureSources()
    void checkAddonInstalled()
  })

  return {
    config,
    loading,
    platform,
    restartRequired,
    bitratePreset,
    customBitrate,
    setCodec,
    captureSources,
    sourcesLoading,
    addonAlreadyInstalled,
    cleanupDaysEnabled,
    cleanupDays,
    cleanupGbEnabled,
    cleanupGb,
    minimizeToTray,
    statsSite,
    wowRegion,
    pickWowPath,
    pickStoragePath,
    setFps,
    setResolution,
    selectCaptureSource,
    selectAutoDetect,
    installAddon,
    relaunch,
    rerunSetupWizard,
  }
}
