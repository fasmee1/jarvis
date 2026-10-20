'use strict';
// Runs scanAll off the main thread (the first scan reads ~hundreds of MB of transcripts).
const { parentPort, workerData } = require('worker_threads');
const { scanAll, totals } = require('./scan');

try {
  const { base, cache, windows } = workerData;
  const r = scanAll(base, cache);
  parentPort.postMessage({ ok: true, cache: r.cache, totals: totals(r.entries, windows) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
