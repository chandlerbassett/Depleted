// An IPC event as Electron delivers it from the app's own page: the top frame of a window
// showing app://depleted. Handlers refuse anything else (src/main/system/ipcGuard.ts).
export const appPageEvent = { sender: {}, senderFrame: { origin: 'app://depleted', parent: null } }
