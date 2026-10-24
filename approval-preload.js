'use strict';
// Permission popup preload (sandboxed): only the popup's own IPC channels.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = ['approval-win:respond', 'approval-win:approve-safe'];
const EVENTS = ['approval-win:data'];

contextBridge.exposeInMainWorld('approval', {
  invoke(channel, payload) {
    if (!INVOKE.includes(channel)) return Promise.reject(new Error('blocked channel ' + channel));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, fn) {
    if (!EVENTS.includes(channel) || typeof fn !== 'function') return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
