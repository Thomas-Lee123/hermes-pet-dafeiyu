// Minimal Chrome DevTools Protocol client on Node's built-in WebSocket.
export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async attach(port = 9222) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(list.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        const h = c.handlers.get(m.method); if (h) h(m.params, m.sessionId);
      }
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`timeout: ${method}`)); } }, 120000);
    });
  }
  on(method, fn) { this.handlers.set(method, fn); }
  close() { try { this.ws.close(); } catch {} }
}

/** Open a page target and attach a flattened session to it. */
export async function newPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId };
}

/** Evaluate an async expression in the page and return its JSON value. */
export async function evaluate(cdp, sessionId, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('page error: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
  }
  return r.result.value;
}

export async function waitFor(cdp, sessionId, expr, timeoutMs = 60000, everyMs = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await evaluate(cdp, sessionId, `!!(${expr})`, false); } catch {}
    if (v) return true;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${expr}`);
    await new Promise(r => setTimeout(r, everyMs));
  }
}
