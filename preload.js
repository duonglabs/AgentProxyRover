'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('state'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  rotate: (itemId) => ipcRenderer.invoke('rotate', itemId),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
});

// VPN mode POC — separate namespace so the existing api surface stays untouched
contextBridge.exposeInMainWorld('vpnApi', {
  start: () => ipcRenderer.invoke('vpn:start'),
  stop: () => ipcRenderer.invoke('vpn:stop'),
  status: () => ipcRenderer.invoke('vpn:status'),
  onState: (cb) => ipcRenderer.on('vpn-state', (_e, state) => cb(state)),
});
