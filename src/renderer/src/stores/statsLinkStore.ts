// Shares the configured stats-site + region across components (Team panel links,
// My PVP Hub character links) so they update live when changed in Settings, without
// each consumer re-fetching config individually.

import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { StatsSite, WowRegion } from '@shared/ipc.types'
import { normalizeStatsSite } from '@/utils/characterLinks'

export const useStatsLinkStore = defineStore('statsLink', () => {
  const statsSite = ref<StatsSite>('raiderio')
  const wowRegion = ref<WowRegion>('eu')
  const loaded = ref(false)

  async function load(): Promise<void> {
    if (loaded.value) return
    const cfg = await window.electron.invoke('config:getAll')
    statsSite.value = normalizeStatsSite(cfg.statsSite)
    wowRegion.value = cfg.wowRegion
    loaded.value = true
  }

  function setStatsSite(site: StatsSite): void {
    statsSite.value = site
  }

  function setWowRegion(region: WowRegion): void {
    wowRegion.value = region
  }

  return { statsSite, wowRegion, load, setStatsSite, setWowRegion }
})
