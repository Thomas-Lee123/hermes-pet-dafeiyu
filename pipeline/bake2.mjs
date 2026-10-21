// Bake the Coopanion whale into a Hermes petdex sheet — one seamless loop per state.
//
// Why this replaces bake.mjs: Hermes plays 6 frames per state over a fixed 1100 ms
// (agent/pet/constants.py: FRAMES_PER_STATE=6, LOOP_MS=1100 → 183 ms a frame). The old
// bake sampled every state at that same 183 ms for a fixed 6 frames, which is wrong for
// every single state here, because each animation has its own period:
//   walk 476 ms a stride · run 227 ms · breath 2618 ms · wave pulse 1600 ms · jump ~1200 ms
// Sampling a 227 ms run cycle every 183 ms aliases the gait into noise; sampling 920 ms of
// a 1600 ms wave misses most of the arm; sampling 920 ms of a 1200 ms jump cuts the landing.
// This bake instead gives each state a source-time span that is exactly one period (or one
// whole gesture), samples 6 evenly spaced phases inside it, and lets the cell play that span
// in 1100 ms. Slow-motion for the fast states, seamless for all of them.
//
// It also fixes three things the old baker carried over from its page:
//   · one page load per state — `act('wave')` and `setExpr()` leave `pet.mode` alone, so a
//     row baked after a walk inherited walk mode, and `review` (after `run`) inherited the
//     ninja-run pose. A fresh page is always a clean idle.
//   · deterministic — blinks and glances run on Math.random(); both frozen.
//   · fx particles — the harness page defines the .tearf/.p-heart/.p-dust classes the demo
//     page carries, so a sad pet no longer bakes with black blobs (unset var(--tear) = black).
//
// Framing: one box for every row, sized from the ink actually captured (not from
// getBoundingClientRect, which reports the figure's canvas viewport, and not from the
// thought bubble, which used to inflate the box until the pet filled half the cell).
//
// env: HNODE HCHROME HOUT [HSCHEME] [HDEST]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, newPage, evaluate, waitFor } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.env.HNODE, CHROME = process.env.HCHROME, OUT = process.env.HOUT;
const PORT = 4320, DBG = 9224;
const COLS = 8, ROWS = 9, FW = 192, FH = 208, REAL = 6;
const SCHEME = process.env.HSCHEME || 'deepseek-maid';
// Where the Coopanion package sits under the serve2 root (the parent of this folder).
// Set HPKGURL when your checkout has a different layout, e.g. HPKGURL=/vendor/coopanion/
const PKG_URL = process.env.HPKGURL || '/coopanion-src/packages/cortico-world-desktop-pet';
const STEP = 1 / 60;                    // the kit's springs are tuned for this; never step larger

// ---- the figure's own periods, read off web/kit/body.js and web/whale/figure.js ----
const BREATH = 2 * Math.PI / 2.4;       // 2.618 s — `breath = sin(t*2.4)`; the only idle motion
const WALK_P = 1 / 2.1;                 // 0.476 s — `pet.phase += 2π*2.1*dt`, one stride cycle
const RUN_P = 1 / 4.4;                  // 0.227 s — `pet.phase += 2π*4.4*dt`
const YAWN_P = 4.2;                     // 4.200 s — FACES.sleepy: `yawn = (t%4.2)/1.6`

// span  = seconds of source the six frames cover, i.e. what one 1100 ms loop plays.
// pre   = seconds of source to run before frame 0.
// warm  = seconds of source to run after setup, for ramps that the setup itself starts
//         (walk speed and lean).
// settle = seconds of plain idle to run BEFORE the setup. On a fresh page every spring in the
//         figure starts at rest and rings toward its target; the pendant springs are
//         spring(28, 1.8), a damping ratio of 0.17, so they are still visibly swinging 10 s
//         later. Measured: the wrap discontinuity of the idle row falls from 2.5x a normal
//         step to 1.5x once the settle is long enough. Nothing here may be asked of her until
//         she has stopped ringing.
const SETTLE = 20;
const STATES = [
  { row: 'idle', kind: 'expr', word: 'neutral', span: BREATH, settle: SETTLE, warm: 2 },
  { row: 'running-right', kind: 'walk', dir: 'right', run: false, warm: 1.2, span: WALK_P, settle: SETTLE },
  { row: 'running-left', kind: 'walk', dir: 'left', run: false, warm: 1.2, span: WALK_P, settle: SETTLE },
  // the pulse is 1.6 s (arm up 0.24 s..1.28 s, face happy 0..1.8 s) but the arm spring lags
  // ~0.7 s behind its envelope, so the span runs well past the end of the pulse: frame 5 lands
  // at 2.47 s with the arm down and the face back to neutral, both matching frame 0. At 1.6 s
  // the loop wrapped with the arm still up and the face still happy — a visible snap.
  { row: 'waving', kind: 'play', word: 'wave', span: 2.6, settle: SETTLE },
  { row: 'jumping', kind: 'play', word: 'jump', pre: 0.02, span: 0.95, settle: SETTLE },
  { row: 'failed', kind: 'expr', word: 'sad', span: BREATH, settle: SETTLE, warm: 2, noFx: true },
  { row: 'waiting', kind: 'expr', word: 'sleepy', span: YAWN_P, settle: SETTLE, warm: 2 },   // one yawn a loop
  { row: 'running', kind: 'walk', dir: 'right', run: true, warm: 1.2, span: RUN_P, settle: SETTLE },
  // the thought trail is the figure's own: three circles on `(t*.8 + i/3) % 1`, a 1.25 s cycle,
  // so the span is one bubble cycle rather than one breath (a bubble jumping back is the one
  // discontinuity of the row you can actually see)
  { row: 'review', kind: 'expr', word: 'thinking', span: 1.25, settle: SETTLE, warm: 2 },
];

// A generous window around the pet, native stage pixels. Every capture is taken inside it;
// the final cell is cropped out of these pixels once the real ink union is known.
const CAP = { x: 580, y: 700, width: 480, height: 560, scale: 1 };
const PAD = 1.06;          // breathing room round the ink union
const ANCHOR_X = 800;      // ctl.pet.x — pin() holds her here, so it is the same on every row

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'whale-bake2-'));
const server = spawn(NODE, [join(HERE, 'serve2.mjs'), String(PORT)], { stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--no-sandbox', '--force-device-scale-factor=1', '--window-size=1600,1600', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

async function advance(cdp, sid, seconds) {
  if (!(seconds > 0)) return;
  const n = Math.max(1, Math.ceil(seconds / STEP - 1e-9));
  const dt = seconds / n;
  await evaluate(cdp, sid, `(async()=>{for(let i=0;i<${n};i++) __bake.step(${dt});})()`, true);
}
const setupJs = s => s.kind === 'expr' ? `__bake.expr(${JSON.stringify(s.word)}, 1e6)`
  : s.kind === 'walk' ? `__bake.walk(${JSON.stringify(s.dir)}, ${!!s.run})`
    : `__bake.play(${JSON.stringify(s.word)})`;

const union = list => list.reduce((a, b) => ({
  x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
}), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

try {
  for (let i = 0; i < 120; i++) { try { await fetch(`http://127.0.0.1:${DBG}/json/version`); break; } catch {} await new Promise(r => setTimeout(r, 250)); }
  const cdp = await CDP.attach(DBG);
  // two pages: the pet lives on a fresh one per state (nothing leaks between rows), and a
  // second, never-navigated page holds the frames that have been decoded so far
  const { sessionId } = await newPage(cdp, 'about:blank');
  const { sessionId: comp } = await newPage(cdp, `http://127.0.0.1:${PORT}/whale-bake/compose.html`);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, comp);
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);

  const ink = [];   // per state: [{x0,y0,x1,y1}] in stage px
  let schemeSeen = null;

  for (let si = 0; si < STATES.length; si++) {
    const s = STATES[si];
    // a fresh page per row: `act('wave')` never resets pet.mode, so rows would otherwise
    // inherit whatever mode the previous row left behind (wave baked mid-walk, review mid-run).
    // Page.navigate resolves before the new document commits, and Runtime.evaluate would then
    // still answer from the outgoing page — so tag each load and wait for the tag to come back.
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/whale-bake/harness.html?scheme=${SCHEME}&run=${si}&pkg=${encodeURIComponent(PKG_URL)}` }, sessionId);
    await waitFor(cdp, sessionId, `window.__bake && window.__bake.ready && new URLSearchParams(location.search).get('run') === '${si}'`, 60000);
    // the compositor page is open too, and a background tab has no surface to photograph
    await cdp.send('Page.bringToFront', {}, sessionId);
    schemeSeen = schemeSeen || await evaluate(cdp, sessionId, '__bake.scheme');

    await evaluate(cdp, sessionId, '__bake.freeze();');
    if (s.settle) await advance(cdp, sessionId, s.settle);
    await evaluate(cdp, sessionId, `${setupJs(s)}; ${s.noFx ? '__bake.noFx();' : ''}`);
    // draw once before anything is captured: the figure mounts its canvas on the first
    // render, and step() is what turns pet.expr into pet._fc — a row with no warm-up
    // (waving, jumping, the expression rows) would otherwise photograph frame 0 with the
    // neutral face still in _fc, and with the canvas not yet mounted
    await evaluate(cdp, sessionId, '__bake.flush();');
    if (s.warm) await advance(cdp, sessionId, s.warm);
    if (s.pre) await advance(cdp, sessionId, s.pre);

    const per = s.span / REAL;               // source seconds between two frames
    const boxes = [];
    for (let i = 0; i < REAL; i++) {
      const { data } = await cdp.send('Page.captureScreenshot',
        { format: 'png', clip: CAP, captureBeyondViewport: false, fromSurface: true }, sessionId);
      const bb = await evaluate(cdp, comp, `__c.take(${JSON.stringify(data)})`, true);
      if (!bb) throw new Error(`${s.row} frame ${i}: captured image is fully transparent`);
      // image pixel → stage px (the capture is 1:1)
      boxes.push({ x0: bb.x0 + CAP.x, y0: bb.y0 + CAP.y, x1: bb.x1 + CAP.x, y1: bb.y1 + CAP.y });
      await advance(cdp, sessionId, per);
    }
    ink.push(boxes);
    const u = union(boxes);
    console.log(`  ${s.row.padEnd(14)} span ${s.span.toFixed(3)}s  ink x ${u.x0}-${u.x1}  y ${u.y0}-${u.y1}  (${u.x1 - u.x0}x${u.y1 - u.y0})`);
  }

  const u = union(ink.flat());
  console.log(`\nink union: x ${u.x0}..${u.x1} (${u.x1 - u.x0})  y ${u.y0}..${u.y1} (${u.y1 - u.y0})`);
  const margins = { left: u.x0 - CAP.x, right: CAP.x + CAP.width - u.x1, top: u.y0 - CAP.y, bottom: CAP.y + CAP.height - u.y1 };
  console.log('capture margins:', JSON.stringify(margins));
  if (Object.values(margins).some(m => m < 4)) console.warn('  !! ink touches the capture window - raise CAP in bake2.mjs');

  // ---- the one box every row shares ----
  let h = (u.y1 - u.y0) * PAD;
  let w = h * FW / FH;
  if ((u.x1 - u.x0) * 1.02 > w) { w = (u.x1 - u.x0) * 1.02; h = w * FH / FW; }
  const box = { x: ANCHOR_X - w / 2, y: u.y1 + 2 - h, w, h };
  const scale = FW / w;
  console.log(`box: x ${box.x.toFixed(1)} y ${box.y.toFixed(1)} w ${w.toFixed(1)} h ${h.toFixed(1)}  (1 cell px = ${(1 / scale).toFixed(2)} stage px)`);
  if (box.x < CAP.x || box.y < CAP.y || box.x + box.w > CAP.x + CAP.width || box.y + box.h > CAP.y + CAP.height)
    throw new Error('the framed box falls outside the captured window - raise CAP');

  const su = union(ink[0]);
  console.log(`standing pose fills ${((su.y1 - su.y0) / h * 100).toFixed(0)}% of the cell height (old sheet: 56%)`);

  const sheetB64 = await evaluate(cdp, comp,
    `__c.compose(${JSON.stringify(CAP)}, ${JSON.stringify(box)}, ${COLS}, ${FW}, ${FH}, ${ROWS}, ${REAL})`, true);
  const dest = join(OUT, 'spritesheet.png');
  writeFileSync(dest, Buffer.from(sheetB64, 'base64'));
  console.log(`\nscheme: ${schemeSeen}`);
  console.log('spritesheet:', COLS * FW, 'x', ROWS * FH, '->', dest);
  if (process.env.HDEST) { mkdirSync(dirname(process.env.HDEST), { recursive: true }); copyFileSync(dest, process.env.HDEST); console.log('copied ->', process.env.HDEST); }
  cdp.close();
} catch (e) { console.error('BAKE FAILED:', e.message); process.exitCode = 1; } finally { cleanup(); }
