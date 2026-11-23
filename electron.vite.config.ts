import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'

// index.html's CSP lets the page reach the dev server's reload socket (ws://localhost).
// A built app has no dev server, so the release copy of the page drops that source.
const DEV_SOCKET_SOURCE = ' ws://localhost:*'
function releaseCsp(): Plugin {
  return {
    name: 'depleted-release-csp',
    apply: 'build',
    transformIndexHtml(html) {
      if (!html.includes(DEV_SOCKET_SOURCE)) return html
      return html.split(DEV_SOCKET_SOURCE).join('')
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        // Two preload scripts: the main app's typed IPC bridge, and a minimal
        // capture-only bridge for the hidden WindowCaptureRecorder window.
        input: {
          index: resolve('src/preload/index.ts'),
          capture: resolve('src/preload/capture.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue(), releaseCsp()],
    build: {
      rollupOptions: {
        // Two HTML entries: the main app UI, and the hidden capture window that
        // runs getDisplayMedia + MediaRecorder (see src/renderer/src/capture/).
        input: {
          index: resolve('src/renderer/index.html'),
          capture: resolve('src/renderer/capture.html')
        }
      }
    }
  }
})
