/**
 * Drives the real app over the DevTools protocol against the sample topology:
 * clicks through selection, the resize dialog and the pending queue, capturing
 * a screenshot at each step. Verifies the UI works, not just that it renders.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = process.argv[2] ?? '/tmp/pf-shots';
const PORT = 9333;
mkdirSync(OUT, { recursive: true });

const child = spawn('npx', ['electron', '.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, PF_MOCK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let elog = '';
child.stdout.on('data', (d) => { elog += d; });
child.stderr.on('data', (d) => { elog += d; });

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} timed out`)); }, 20000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${expression} -> ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  return r.result.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log(`  captured ${name}.png`);
}

/** Clicks the first element whose trimmed text matches, via a real DOM click. */
const clickText = (sel, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find(e => e.textContent.trim().replace(/\\s+/g,' ').includes(${JSON.stringify(text)}));
  if (!el) return 'NOT FOUND: ' + ${JSON.stringify(text)};
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'ok';
})()`;

const fail = [];
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fail.push(label);
}

try {
  // Wait for the debug endpoint and the page target.
  let list = [];
  for (let i = 0; i < 60; i++) {
    try { list = await targets(); if (list.some(t => t.type === 'page')) break; } catch {}
    await sleep(500);
  }
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error(`no page target. electron said:\n${elog}`);

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(2500);

  console.log('\n1. initial view');
  const diskCount = await evaluate(`document.querySelectorAll('.disk').length`);
  check('all four sample disks render', diskCount === 4, `got ${diskCount}`);
  const segs = await evaluate(`document.querySelectorAll('.seg').length`);
  check('disk map draws segments', segs >= 12, `got ${segs}`);
  // Guards a real regression: a generic .row flex utility once matched the
  // table's <tr className="row">, collapsing every cell to 25px.
  const cols = await evaluate(`(() => {
    const t = document.querySelector('table.parts');
    const th = [...t.querySelectorAll('thead th')].map(e => Math.round(e.getBoundingClientRect().width));
    const td = [...t.querySelectorAll('tbody tr:first-child td')].map(e => Math.round(e.getBoundingClientRect().width));
    return { th, td };
  })()`);
  check('table body columns line up with the header',
    cols.th.every((w, i) => Math.abs(w - cols.td[i]) <= 1),
    `th ${cols.th.join('/')} vs td ${cols.td.join('/')}`);
  await shot('01-overview');

  console.log('\n2. select the Media volume on disk 1');
  check('row click registered', await evaluate(clickText('tr.row', 'D: Media')) === 'ok');
  await sleep(400);
  const selCount = await evaluate(`document.querySelectorAll('.seg.sel, tr.row.sel').length`);
  check('selection highlights map and table', selCount >= 2, `got ${selCount}`);
  const resizeEnabled = await evaluate(
    `!([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Resize'))||{}).disabled`);
  check('Resize action becomes available', resizeEnabled === true);
  await shot('02-selected');

  console.log('\n3. open the resize dialog');
  check('resize opens', await evaluate(clickText('button', 'Resize / Move')) === 'ok');
  await sleep(500);
  const hasDlg = await evaluate(`!!document.querySelector('.dlg')`);
  check('dialog rendered', hasDlg === true);
  const sliderMax = await evaluate(`Number(document.querySelector('input[type=range]').max)`);
  // Media is 1.76 TB with 400 GB unallocated directly after it.
  check('slider max spans the adjacent free space', sliderMax > 2.1e12, `max ${(sliderMax/1e12).toFixed(2)} TB`);
  await shot('03-resize-dialog');

  console.log('\n4. shrink it and queue the change');
  // Ask for 900 GB. The dialog will refuse to go below the data the volume
  // actually holds, so the expected outcome is read back from the control
  // rather than assumed.
  const sized = await evaluate(`(() => {
    const r = document.querySelector('input[type=range]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(r, String(900 * 1024 * 1024 * 1024));
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return { asked: 900 * 1024 ** 3, got: Number(r.value), min: Number(r.min) };
  })()`);
  check('shrink is clamped to the data the volume holds',
    sized.got === sized.min && sized.got > sized.asked,
    `asked ${(sized.asked / 1024 ** 3).toFixed(0)} GiB, floor ${(sized.min / 1024 ** 3).toFixed(0)} GiB`);
  const freedExpected = 1800 * 1024 ** 3 - sized.got + 400 * 1024 ** 3;
  await sleep(300);
  await shot('04-resize-adjusted');
  check('queued', await evaluate(clickText('button', 'Add to queue')) === 'ok');
  await sleep(1200);
  const queued = await evaluate(`document.querySelectorAll('.op').length`);
  check('operation lands in the queue', queued === 1, `got ${queued}`);
  const applyEnabled = await evaluate(
    `!([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Apply'))||{}).disabled`);
  check('Apply stays disabled when offline staging is unavailable', applyEnabled === false);
  await shot('05-queued');

  console.log('\n5. the map previews the pending layout');
  const preview = await evaluate(`(() => {
    const d = [...document.querySelectorAll('.disk')].find(x => x.textContent.includes('WD40EZAZ'));
    const free = [...d.querySelectorAll('.seg.free')].map(s => s.textContent);
    return { ghost: d.querySelectorAll('.seg.ghost').length, free };
  })()`);
  check('pending disk is flagged', preview.ghost > 0, `${preview.ghost} segments`);
  // The shrink and the 400 GB gap that already followed Media should merge
  // into one contiguous region.
  const merged = preview.free.map(t => {
    const m = /([\d.]+)\s*(GB|TB)/.exec(t);
    return m ? Number(m[1]) * (m[2] === 'TB' ? 1024 ** 4 : 1024 ** 3) : 0;
  });
  const wanted = merged.some(b => Math.abs(b - freedExpected) / freedExpected < 0.02);
  check('shrink merges with the adjacent gap into one free region', wanted,
    `expected ~${(freedExpected / 1024 ** 3).toFixed(0)} GiB, saw ${preview.free.join(' | ')}`);

  console.log('\n6. queue a second change on the system disk');
  check('select C:', await evaluate(clickText('tr.row', 'C: Windows')) === 'ok');
  await sleep(300);
  check('open resize', await evaluate(clickText('button', 'Resize / Move')) === 'ok');
  await sleep(500);
  // Drag well below what Windows reports as its online shrink floor.
  await evaluate(`(() => {
    const r = document.querySelector('input[type=range]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(r, r.min);
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(300);
  const warnsOffline = await evaluate(
    `[...document.querySelectorAll('.dlg .note')].map(n=>n.textContent).join(' ')`);
  check('dialog warns the shrink needs a restart', /restart/i.test(warnsOffline), warnsOffline.slice(0, 90));
  await shot('06-offline-warning');
  await evaluate(clickText('button', 'Add to queue'));
  await sleep(1200);
  const sideText = await evaluate(`document.querySelector('.side').textContent`);
  check('queue explains the reboot requirement', /restart/i.test(sideText));
  check('system-disk warning surfaces', /back up/i.test(sideText));
  await shot('07-two-ops');

  console.log('\n7. delete confirmation is gated');
  check('select Backups', await evaluate(clickText('tr.row', 'E: Backups')) === 'ok');
  await sleep(300);
  check('open delete', await evaluate(clickText('button', 'Delete')) === 'ok');
  await sleep(500);
  const delDisabled = await evaluate(
    `([...document.querySelectorAll('.dlg .foot button')].pop()||{}).disabled`);
  check('delete stays disabled until confirmed', delDisabled === true);
  await shot('08-delete-guard');

  console.log('\n8. sample data cannot invoke destructive system actions');
  const applyError = await evaluate(`window.pf.apply([]).then(() => '', e => e.message)`);
  check('sample mode refuses apply in the main process', /read-only/.test(applyError));
  const rebootError = await evaluate(`window.pf.reboot().then(() => '', e => e.message)`);
  check('sample mode refuses reboot in the main process', /unavailable/.test(rebootError));

  console.log(`\n${fail.length ? `FAILED: ${fail.join(', ')}` : 'ALL CHECKS PASSED'}`);
  process.exitCode = fail.length ? 1 : 0;
} catch (e) {
  console.error('\nERROR:', e.message);
  console.error(elog.slice(-1500));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  child.kill('SIGKILL');
  // The debug socket and the Electron child both hold the loop open.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}
