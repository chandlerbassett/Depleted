// The IPC channels the page may use, as the preload script checks them. Both maps are
// typed against the channel interfaces, so adding a channel there without listing it here
// fails to compile, and a channel the renderer sends that isn't listed here never reaches
// ipcRenderer (there's no way around it from a page, however it got to run code).

import type { IpcCommands, IpcEvents } from './ipc.types'

const COMMAND_CHANNELS: Readonly<Record<keyof IpcCommands, true>> = {
  'recorder:getStatus': true,
  'storage:getRecordings': true,
  'storage:deleteRecording': true,
  'storage:openFolder': true,
  'storage:getCoachData': true,
  'storage:saveClip': true,
  'storage:deleteClip': true,
  'storage:showClip': true,
  'coach:getWclStatus': true,
  'coach:setWclCredentials': true,
  'coach:clearWclCredentials': true,
  'coach:getBenchmark': true,
  'coach:listCharacters': true,
  'coach:getKeySummaries': true,
  'coach:findWclFight': true,
  'config:get': true,
  'config:set': true,
  'config:getAll': true,
  'system:getAddonStatus': true,
  'system:checkBrew': true,
  'system:checkFfmpeg': true,
  'system:checkScreenPermission': true,
  'system:requestScreenPermission': true,
  'system:checkAddon': true,
  'system:installAddon': true,
  'system:openAddonSource': true,
  'system:openAddonsDir': true,
  'system:listCaptureWindows': true,
  'system:checkWowPath': true,
  'system:openSystemPreferences': true,
  'system:pickFolder': true,
  'system:openUrl': true,
  'system:relaunch': true,
  'system:getPlatform': true,
  'system:getVersion': true,
  'updater:getReady': true,
  'updater:install': true,
  'testMode:start': true,
  'testMode:cleanup': true
}

const EVENT_CHANNELS: Readonly<Record<keyof IpcEvents, true>> = {
  'recorder:statusChanged': true,
  'recorder:error': true,
  'updater:ready': true,
  'storage:recordingProcessed': true,
  'storage:orphanedRecordings': true,
  'addon:statusChanged': true,
  'testMode:countdown': true
}

export function isCommandChannel(channel: unknown): channel is keyof IpcCommands {
  return typeof channel === 'string' && Object.hasOwn(COMMAND_CHANNELS, channel)
}

export function isEventChannel(channel: unknown): channel is keyof IpcEvents {
  return typeof channel === 'string' && Object.hasOwn(EVENT_CHANNELS, channel)
}
