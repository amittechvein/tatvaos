// One render at a time, in its own thread, so a render that runs too long can
// be killed without taking the server with it (server.mjs).
import { parentPort } from 'node:worker_threads';
import { renderDoc } from './render-doc.mjs';
import { renderSheet } from './render-sheet.mjs';

// Say so once the schema is loaded: a job handed to a worker still loading
// would spend its time limit on start-up (found 30 Sept by the timeout test).
parentPort.postMessage({ ready: true });

parentPort.on('message', async ({ id, kind, updates }) => {
  try {
    const input = updates.map((u) => new Uint8Array(u));
    if (kind === 'sheet') {
      const r = await renderSheet(input);
      parentPort.postMessage({ id, ok: true, result: r }, [r.state.buffer, r.xlsx.buffer]);
    } else {
      const r = renderDoc(input);
      parentPort.postMessage({ id, ok: true, result: r }, [r.state.buffer]);
    }
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e).slice(0, 200) });
  }
});
