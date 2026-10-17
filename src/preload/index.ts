import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, CaptureCommand, Settings, TerryAPI } from '../shared/types'
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`terry:${name}`, ...args)
const api: TerryAPI = {
  hideWindow: () => invoke('hide-window'), suspendShortcut: paused => invoke('suspend-shortcut', paused),
  getState: () => invoke('get-state'), toggle: () => invoke('toggle'), cancel: () => invoke('cancel'),
  retry: () => invoke('retry'), importAudio: () => invoke('import-audio'), refresh: () => invoke('refresh'),
  copyTranscript: raw => invoke('copy', raw), clearTranscript: () => invoke('clear'),
  saveSettings: (settings: Settings) => invoke('save-settings', settings),
  selectMicrophone: (deviceId, label) => invoke('select-microphone', deviceId, label),
  learnCorrections: (createdAt, correctedText, corrections) => invoke('learn-corrections', createdAt, correctedText, corrections),
  previewSound: settings => invoke('preview-sound', settings),
  listSoundClips: settings => invoke('list-sound-clips', settings),
  chooseFile: kind => invoke('choose-file', kind), downloadModel: () => invoke('download-model'),
  openPermission: kind => invoke('open-permission', kind), showSettings: () => invoke('show-settings'),
  onShortcutCandidate(callback) {
    const listener = (_event: Electron.IpcRendererEvent, shortcut: string) => callback(shortcut)
    ipcRenderer.on('terry:shortcut-candidate', listener)
    return () => ipcRenderer.removeListener('terry:shortcut-candidate', listener)
  },
  onOpenSettings(callback) {
    const listener = (_event: Electron.IpcRendererEvent, target: unknown) => callback(target === 'shortcut' || target === 'microphone' ? target : undefined)
    ipcRenderer.on('terry:settings', listener)
    return () => ipcRenderer.removeListener('terry:settings', listener)
  },
  onState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state)
    ipcRenderer.on('terry:state', listener)
    return () => ipcRenderer.removeListener('terry:state', listener)
  },
  onCapture(callback) {
    const listener = (_event: Electron.IpcRendererEvent, command: CaptureCommand) => callback(command)
    ipcRenderer.on('terry:capture', listener)
    return () => ipcRenderer.removeListener('terry:capture', listener)
  },
  capturePrepared: (ready, inputDevice, message) => ipcRenderer.send('terry:capture-prepared', ready, inputDevice, message),
  captureStarted: (id, inputDevice) => ipcRenderer.send('terry:capture-started', id, inputDevice),
  captureWarning: (id, message) => ipcRenderer.send('terry:capture-warning', id, message),
  captureLevel: (id, level) => ipcRenderer.send('terry:capture-level', id, level),
  captureComplete: (id, samples) => ipcRenderer.send('terry:capture-complete', id, samples),
  captureFailed: (id, message, samples) => ipcRenderer.send('terry:capture-failed', id, message, samples)
}
contextBridge.exposeInMainWorld('terry', api)
