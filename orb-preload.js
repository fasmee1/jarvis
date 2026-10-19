'use strict';
// Floating Orb preload (sandboxed): only the orb's own IPC channels.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = ['orb:ready', 'orb:cmd', 'orb:panel', 'orb:focusable', 'orb:menu', 'orb:drag', 'orb:hit'];
const EVENTS = ['orb:state', 'orb:level', 'orb:visible', 'orb:config', 'orb:layout'];

contextBridge.exposeInMainWorld('orb', {
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
