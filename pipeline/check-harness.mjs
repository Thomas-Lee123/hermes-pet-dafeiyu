// Smoke check: does the harness page still load its (now dynamic) imports?
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CDP, newPage, evaluate, waitFor } from './cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = process.env.HNODE, CHROME = process.env.HCHROME
const PORT = 4320, DBG = 9229
const profile = mkdtempSync(join(tmpdir(), 'whale-check-'))
const server = spawn(NODE, [join(HERE, 'serve2.mjs'), String(PORT)], { stdio: 'ignore' })
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--no-sandbox', '--force-device-scale-factor=1', '--window-size=1600,1600', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup)

try {
  for (let i = 0; i < 120; i++) { try { await fetch(`http://127.0.0.1:${DBG}/json/version`); break; } catch {} await new Promise(r => setTimeout(r, 250)) }
  const cdp = await CDP.attach(DBG)
  const { sessionId } = await newPage(cdp, 'about:blank')
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  for (const q of ['', '&pkg=' + encodeURIComponent('/coopanion-src/packages/cortico-world-desktop-pet')]) {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/whale-bake/harness.html?scheme=deepseek-maid&run=${Math.random()}${q}` }, sessionId)
    const t0 = Date.now()
    await waitFor(cdp, sessionId, 'window.__bake && window.__bake.ready', 60000)
    const scheme = await evaluate(cdp, sessionId, '__bake.scheme')
    console.log(`ready in ${Date.now() - t0}ms  scheme=${scheme}  ${q ? 'with ?pkg=' : 'default pkg'}`)
  }
  cdp.close()
} catch (e) { console.error('CHECK FAILED:', e.message); process.exitCode = 1 } finally { cleanup() }
