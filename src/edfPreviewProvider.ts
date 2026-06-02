import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseEdfHeader, readSignalData, EdfHeader, EdfFormat } from './edfParser';
import { validateEdfHeader, validateRawHeader, ValidationIssue } from './edfValidator';

// Maximum channels shown in the signal preview (keeps the canvas manageable).
const MAX_PREVIEW_CHANNELS = 32;
// Canvas display columns (horizontal resolution of the min-max envelope).
const DISPLAY_POINTS = 1200;

class EdfDocument implements vscode.CustomDocument {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly header: EdfHeader | null,
    public readonly error: string | null,
    public readonly issues: ValidationIssue[],
  ) {}
  dispose(): void {}
}

export class EdfPreviewProvider implements vscode.CustomReadonlyEditorProvider<EdfDocument> {
  static readonly viewType = 'edfBdfViewer.preview';

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      EdfPreviewProvider.viewType,
      new EdfPreviewProvider(context),
      { supportsMultipleEditorsPerDocument: true },
    );
  }

  async openCustomDocument(uri: vscode.Uri): Promise<EdfDocument> {
    let bytes: Uint8Array;
    try {
      bytes = await readHeaderBytes(uri);
    } catch (e) {
      return new EdfDocument(uri, null, e instanceof Error ? e.message : String(e), []);
    }

    try {
      const header = parseEdfHeader(bytes);
      const issues = validateEdfHeader(bytes, header);
      return new EdfDocument(uri, header, null, issues);
    } catch (e) {
      // Full parse failed — still validate the raw bytes so the error page shows
      // specific field-level issues rather than just the exception message.
      const issues = validateRawHeader(bytes);
      return new EdfDocument(uri, null, e instanceof Error ? e.message : String(e), issues);
    }
  }

  async resolveCustomEditor(
    document: EdfDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const nonce = crypto.randomBytes(16).toString('base64url');
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = document.error
      ? buildErrorHtml(document.error, document.issues)
      : buildPreviewHtml(document.uri, document.header!, document.issues, nonce);

    if (!document.header) { return; }

    webviewPanel.webview.onDidReceiveMessage(
      async (msg: { command: string }) => {
        if (msg.command !== 'loadSignals') { return; }
        try {
          const header = document.header!;
          const dataBuf = await readDataBytes(document.uri, header);
          const all = readSignalData(dataBuf, header, 30, DISPLAY_POINTS);
          const data = all.slice(0, MAX_PREVIEW_CHANNELS);
          webviewPanel.webview.postMessage({
            command: 'signals',
            data,
            total: all.length,
          });
        } catch (e) {
          webviewPanel.webview.postMessage({
            command: 'signalError',
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
      undefined,
      this.context.subscriptions,
    );
  }
}

// ── File reading helpers ────────────────────────────────────────────────────

/** Read only the fixed+signal header bytes from the file (avoids loading full recording). */
async function readHeaderBytes(uri: vscode.Uri): Promise<Uint8Array> {
  if (uri.scheme !== 'file') {
    return vscode.workspace.fs.readFile(uri);
  }
  return new Promise((resolve, reject) => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(uri.fsPath, 'r');
      const fixed = Buffer.alloc(256);
      const fixedRead = fs.readSync(fd, fixed, 0, 256, 0);
      if (fixedRead < 256) {
        resolve(fixed.subarray(0, fixedRead)); return;
      }
      const ns = parseInt(fixed.subarray(252, 256).toString('ascii').trim(), 10);
      if (isNaN(ns) || ns <= 0 || ns > 512) { resolve(fixed); return; }
      const total = (ns + 1) * 256;
      const buf = Buffer.alloc(total);
      fixed.copy(buf, 0);
      fs.readSync(fd, buf, 256, ns * 256, 256);
      resolve(buf);
    } catch (e) { reject(e); }
    finally { if (fd !== undefined) { fs.closeSync(fd); } }
  });
}

/** Read the data records needed for the first maxSeconds (called on demand). */
async function readDataBytes(uri: vscode.Uri, header: EdfHeader): Promise<Uint8Array> {
  const recDur = parseFloat(header.recordDurationSec);
  const numRec = isFinite(recDur) && recDur > 0
    ? Math.min(header.numDataRecords, Math.ceil(30 / recDur))
    : 0;

  const isBdf = header.format.startsWith('BDF');
  const bps = isBdf ? 3 : 2;
  const recordSize = header.signals.reduce((a, s) => a + s.samplesPerRecord * bps, 0);
  const totalBytes = numRec * recordSize;

  if (totalBytes <= 0) { return new Uint8Array(0); }

  if (uri.scheme !== 'file') {
    const all = await vscode.workspace.fs.readFile(uri);
    return all.slice(header.headerBytes, header.headerBytes + totalBytes);
  }

  return new Promise((resolve, reject) => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(uri.fsPath, 'r');
      const buf = Buffer.alloc(totalBytes);
      const read = fs.readSync(fd, buf, 0, totalBytes, header.headerBytes);
      resolve(buf.subarray(0, read));
    } catch (e) { reject(e); }
    finally { if (fd !== undefined) { fs.closeSync(fd); } }
  });
}

// ── HTML helpers ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDuration(numRecords: number, durationSec: string): string {
  const total = numRecords * parseFloat(durationSec);
  if (!isFinite(total) || total <= 0) { return ''; }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatBadgeColor(fmt: EdfFormat): string {
  return fmt.startsWith('BDF') ? '#7c5cbf' : fmt.includes('+') ? '#2e7d32' : '#1565c0';
}

// ── Validation card ─────────────────────────────────────────────────────────

function buildValidationCard(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return `
  <div class="card v-ok">
    <div class="card-header">&#10003; Validation &mdash; no issues detected</div>
  </div>`;
  }

  const errCount  = issues.filter(i => i.severity === 'error').length;
  const warnCount = issues.filter(i => i.severity === 'warning').length;
  const summary   = [
    errCount  ? `${errCount} error${errCount  > 1 ? 's' : ''}` : '',
    warnCount ? `${warnCount} warning${warnCount > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(', ');

  const rows = issues.map(issue => `
        <tr>
          <td><span class="issue-badge badge-${issue.severity}">${issue.severity === 'error' ? 'Error' : 'Warning'}</span></td>
          <td class="issue-field">${esc(issue.field)}</td>
          <td>${esc(issue.message)}</td>
        </tr>`).join('');

  return `
  <div class="card v-err">
    <div class="card-header">&#10006; Validation &mdash; ${esc(summary)}</div>
    <div class="table-wrap">
      <table class="issue-table">
        <thead>
          <tr>
            <th style="width:80px">Severity</th>
            <th style="width:200px">Field</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
    </div>
  </div>`;
}

// ── Main HTML builder ───────────────────────────────────────────────────────

function buildPreviewHtml(uri: vscode.Uri, h: EdfHeader, issues: ValidationIssue[], nonce: string): string {
  const fileName  = esc(path.basename(uri.fsPath));
  const durationStr = formatDuration(h.numDataRecords, h.recordDurationSec);
  const badgeColor  = formatBadgeColor(h.format);
  const bitDepth    = h.format.startsWith('BDF') ? '24-bit (BioSemi)' : '16-bit';
  const canPreview  = h.numDataRecords > 0 && parseFloat(h.recordDurationSec) > 0;

  const signalRows = h.signals.map((sig, i) => {
    const recDur = parseFloat(h.recordDurationSec);
    const hz = isFinite(recDur) && recDur > 0
      ? (sig.samplesPerRecord / recDur).toFixed(1)
      : `${sig.samplesPerRecord} spr`;
    return `
    <tr>
      <td class="num">${i + 1}</td>
      <td class="lbl">${esc(sig.label)}</td>
      <td>${esc(sig.transducerType)}</td>
      <td class="mono">${esc(sig.physicalDimension)}</td>
      <td class="mono nowrap">${esc(sig.physicalMin)} / ${esc(sig.physicalMax)}</td>
      <td class="mono nowrap">${esc(sig.digitalMin)} / ${esc(sig.digitalMax)}</td>
      <td>${esc(sig.prefiltering)}</td>
      <td class="mono nowrap">${esc(hz)} Hz</td>
    </tr>`;
  }).join('');

  const recordsLine = h.numDataRecords >= 0
    ? `${h.numDataRecords} × ${esc(h.recordDurationSec)} s${durationStr ? ` <strong>(${esc(durationStr)})</strong>` : ''}`
    : '<em>unknown</em>';

  const signalViewerSection = canPreview ? `
  <div class="card" id="signal-card">
    <div class="card-header">Signal Preview (unfiltered) &mdash; first 30 s</div>
    <div class="card-body">
      <div id="load-section">
        <p class="hint">Waveform rendering is loaded on demand. Shows the first 30 s (up to ${MAX_PREVIEW_CHANNELS} channels).</p>
        <button id="load-btn">Load signal preview</button>
        <span id="load-err" class="err-inline" style="display:none"></span>
      </div>
      <div id="canvas-wrap" style="display:none; overflow-x:auto;"></div>
    </div>
  </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>EDF/BDF Header</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
      padding: 24px 28px;
      margin: 0;
    }
    .title { display:flex; align-items:center; gap:10px; margin-bottom:24px; flex-wrap:wrap; }
    .badge {
      padding: 3px 11px; border-radius:4px; font-weight:700; font-size:0.78em;
      letter-spacing:0.6px; color:#fff; background:${badgeColor};
      text-transform:uppercase; flex-shrink:0;
    }
    .filename { font-size:1.1em; font-weight:600; opacity:0.9; word-break:break-all; }
    .card {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius:6px; margin-bottom:18px; overflow:hidden;
    }
    .card-header {
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.12));
      padding:7px 16px; font-weight:600; font-size:0.82em;
      letter-spacing:0.6px; text-transform:uppercase; opacity:0.85;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    .card-body { padding:14px 16px; }
    .info-grid { display:grid; grid-template-columns:max-content 1fr; gap:7px 24px; }
    .info-label { opacity:0.55; white-space:nowrap; padding-right:8px; }
    .info-value { font-weight:500; }
    .table-wrap { overflow-x:auto; }
    table { width:100%; border-collapse:collapse; font-size:0.9em; }
    thead th {
      text-align:left; padding:8px 12px;
      background:var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.12));
      font-weight:600; white-space:nowrap;
      border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      position:sticky; top:0;
    }
    tbody td {
      padding:7px 12px;
      border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
      vertical-align:middle;
    }
    tbody tr:last-child td { border-bottom:none; }
    tbody tr:hover td { background:var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
    .mono { font-family:var(--vscode-editor-font-family, monospace); font-size:0.95em; }
    .num  { text-align:right; opacity:0.45; user-select:none; width:36px; }
    .lbl  { font-weight:600; font-family:var(--vscode-editor-font-family, monospace); }
    .nowrap { white-space:nowrap; }
    .muted  { opacity:0.45; font-style:italic; }
    /* Validation card */
    .v-ok .card-header  { background:rgba(46,125,50,0.12); border-bottom-color:rgba(46,125,50,0.25); color:#4caf50; }
    .v-err .card-header { background:rgba(183,28,28,0.10); border-bottom-color:rgba(183,28,28,0.25); color:#ef5350; }
    .issue-table { font-size:0.88em; }
    .issue-badge {
      display:inline-block; padding:2px 7px; border-radius:3px;
      font-weight:700; font-size:0.78em; letter-spacing:0.3px; white-space:nowrap;
    }
    .badge-error   { background:rgba(183,28,28,0.18); color:#ef5350; }
    .badge-warning { background:rgba(230,119,0,0.18); color:#ffa726; }
    .issue-field { font-family:var(--vscode-editor-font-family,monospace); font-size:0.9em; white-space:nowrap; }
    /* Signal viewer */
    .hint { margin:0 0 12px; opacity:0.55; font-size:0.9em; }
    button#load-btn {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius:4px; padding:6px 16px;
      font-size:0.9em; cursor:pointer;
    }
    button#load-btn:hover { opacity:0.9; }
    button#load-btn:disabled { opacity:0.5; cursor:not-allowed; }
    .err-inline { color:var(--vscode-errorForeground, #f48771); margin-left:12px; font-size:0.9em; }
    canvas { display:block; image-rendering:pixelated; }
  </style>
</head>
<body>

  <div class="title">
    <span class="badge">${esc(h.format)}</span>
    <span class="filename">${fileName}</span>
  </div>

  ${buildValidationCard(issues)}

  <div class="card">
    <div class="card-header">General</div>
    <div class="card-body">
      <div class="info-grid">
        <span class="info-label">Format</span>
        <span class="info-value">${esc(h.format)} &mdash; ${esc(bitDepth)}</span>
        <span class="info-label">Start date / time</span>
        <span class="info-value mono">${esc(h.startDate)} &nbsp; ${esc(h.startTime)}</span>
        <span class="info-label">Data records</span>
        <span class="info-value">${recordsLine}</span>
        <span class="info-label">Number of signals</span>
        <span class="info-value">${h.numSignals}</span>
        <span class="info-label">Header size</span>
        <span class="info-value">${h.headerBytes} bytes</span>
        ${h.reserved ? `<span class="info-label">Reserved field</span>
        <span class="info-value mono">${esc(h.reserved)}</span>` : ''}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">Patient identification</div>
    <div class="card-body mono">
      ${h.patientId ? esc(h.patientId) : '<span class="muted">not specified</span>'}
    </div>
  </div>

  <div class="card">
    <div class="card-header">Recording identification</div>
    <div class="card-body mono">
      ${h.recordingId ? esc(h.recordingId) : '<span class="muted">not specified</span>'}
    </div>
  </div>

  <div class="card">
    <div class="card-header">Signals &mdash; ${h.numSignals} channel${h.numSignals !== 1 ? 's' : ''}</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="num">#</th>
            <th>Label</th>
            <th>Transducer</th>
            <th>Unit</th>
            <th>Phys min / max</th>
            <th>Dig min / max</th>
            <th>Prefiltering</th>
            <th>Sample rate</th>
          </tr>
        </thead>
        <tbody>
          ${signalRows || '<tr><td colspan="8" class="muted" style="text-align:center;padding:16px">No signals</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>

  ${signalViewerSection}

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const btn    = document.getElementById('load-btn');
  const errEl  = document.getElementById('load-err');

  if (btn) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      if (errEl) { errEl.style.display = 'none'; }
      vscode.postMessage({ command: 'loadSignals' });
    });
  }

  window.addEventListener('message', function (ev) {
    const msg = ev.data;
    if (msg.command === 'signals') {
      onSignals(msg.data, msg.total);
    } else if (msg.command === 'signalError') {
      if (btn)   { btn.disabled = false; btn.textContent = 'Retry'; }
      if (errEl) { errEl.textContent = msg.error; errEl.style.display = 'inline'; }
    }
  });

  function onSignals(signals, total) {
    var loadSection = document.getElementById('load-section');
    var wrap = document.getElementById('canvas-wrap');
    if (!signals || !signals.length) {
      if (loadSection) { loadSection.innerHTML = '<p class="muted">No signal data available.</p>'; }
      return;
    }
    if (loadSection) { loadSection.style.display = 'none'; }
    if (!wrap) { return; }
    wrap.style.display = 'block';

    if (total > signals.length) {
      var note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'Showing first ' + signals.length + ' of ' + total + ' channels.';
      wrap.appendChild(note);
    }

    renderSignals(signals, wrap);
  }

  function renderSignals(signals, container) {
    var cs     = getComputedStyle(document.body);
    var monoFn = cs.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
    var COLORS = [
      '#4dd0e1','#81c784','#ffb74d','#f06292',
      '#ce93d8','#80cbc4','#aed581','#4fc3f7',
      '#ff8a65','#a5d6a7','#90caf9','#ffe082'
    ];

    var LABEL_W = 80;
    var ROW_H   = 72;
    var TIME_H  = 26;
    var PAD     = 5;

    var dpr   = window.devicePixelRatio || 1;
    var cssW  = container.clientWidth || 900;
    var cssH  = signals.length * ROW_H + TIME_H;
    var plotW = cssW - LABEL_W;
    var dur   = signals[0].durationSec;

    var canvas = document.createElement('canvas');
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width  = '100%';
    canvas.style.height = cssH + 'px';
    container.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    if (!ctx) { return; }
    ctx.scale(dpr, dpr);

    /* ── Time axis ─────────────────────────────────── */
    var tick = dur <= 30 ? 5 : dur <= 120 ? 10 : 30;
    for (var t = 0; t <= dur; t += tick) {
      var tx = LABEL_W + (t / dur) * plotW;
      ctx.strokeStyle = 'rgba(128,128,128,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.lineTo(tx, cssH - TIME_H);
      ctx.stroke();
      ctx.fillStyle = 'rgba(128,128,128,0.5)';
      ctx.font = '10px ' + monoFn;
      ctx.textAlign = 'center';
      ctx.fillText(t + 's', tx, cssH - 8);
    }
    ctx.fillStyle = 'rgba(128,128,128,0.4)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(dur.toFixed(1) + ' s', cssW - 4, cssH - 8);

    /* ── Per-channel rows ──────────────────────────── */
    signals.forEach(function (sig, i) {
      var y0    = i * ROW_H;
      var color = COLORS[i % COLORS.length];
      var plotH = ROW_H - PAD * 2;
      var range = (sig.physMax - sig.physMin) || 1;
      var n     = sig.envelope.length / 2;

      /* Alternating background */
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(128,128,128,0.04)';
        ctx.fillRect(LABEL_W, y0, plotW, ROW_H);
      }

      /* Row separator */
      ctx.strokeStyle = 'rgba(128,128,128,0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y0 + ROW_H - 0.5);
      ctx.lineTo(cssW, y0 + ROW_H - 0.5);
      ctx.stroke();

      /* Label */
      ctx.fillStyle = color;
      ctx.font = 'bold 11px ' + monoFn;
      ctx.textAlign = 'left';
      ctx.fillText((sig.label || ('Ch ' + (i + 1))).trim(), 4, y0 + PAD + 14);

      /* Unit */
      ctx.fillStyle = 'rgba(128,128,128,0.55)';
      ctx.font = '9px sans-serif';
      ctx.fillText(sig.unit.trim(), 4, y0 + PAD + 26);

      /* Y-range */
      ctx.font = '8px ' + monoFn;
      ctx.fillStyle = 'rgba(128,128,128,0.35)';
      ctx.fillText(sig.physMax.toFixed(0), 4, y0 + PAD + 2);
      ctx.fillText(sig.physMin.toFixed(0), 4, y0 + ROW_H - PAD - 1);

      /* Waveform (min-max envelope as vertical lines) */
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var col = 0; col < n; col++) {
        var x    = LABEL_W + (col / n) * plotW + 0.5;
        var minV = sig.envelope[col * 2];
        var maxV = sig.envelope[col * 2 + 1];
        var yTop = y0 + PAD + plotH * (1 - (maxV - sig.physMin) / range);
        var yBot = y0 + PAD + plotH * (1 - (minV - sig.physMin) / range);
        yTop = Math.max(y0 + PAD, yTop);
        yBot = Math.min(y0 + PAD + plotH, Math.max(yBot, yTop + 0.5));
        ctx.moveTo(x, yTop);
        ctx.lineTo(x, yBot);
      }
      ctx.stroke();
    });
  }
}());
</script>

</body>
</html>`;
}

function buildErrorHtml(error: string, issues: ValidationIssue[]): string {
  const rows = issues.map(i => `
      <tr>
        <td><span class="badge badge-${i.severity}">${i.severity === 'error' ? 'Error' : 'Warning'}</span></td>
        <td class="field">${esc(i.field)}</td>
        <td>${esc(i.message)}</td>
      </tr>`).join('');

  const issuesSection = issues.length > 0 ? `
  <h3>Detected header issues</h3>
  <table>
    <thead><tr><th style="width:80px">Severity</th><th style="width:180px">Field</th><th>Message</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>EDF/BDF Parse Error</title>
  <style>
    body { background:var(--vscode-editor-background); color:var(--vscode-editor-foreground);
           font-family:var(--vscode-font-family, sans-serif); font-size:var(--vscode-font-size,13px); padding:32px; margin:0; }
    .box { border:1px solid var(--vscode-inputValidation-errorBorder,#f48771); border-radius:6px;
           padding:16px 20px; max-width:800px; margin-bottom:20px; }
    h2   { margin:0 0 8px; color:var(--vscode-errorForeground,#f48771); font-size:1em; }
    p    { margin:0; opacity:0.8; }
    h3   { margin:20px 0 8px; font-size:0.9em; opacity:0.7; text-transform:uppercase; letter-spacing:0.5px; }
    table{ width:100%; border-collapse:collapse; font-size:0.9em; max-width:800px; }
    th   { text-align:left; padding:7px 10px; background:rgba(128,128,128,0.1);
           border-bottom:1px solid rgba(128,128,128,0.2); }
    td   { padding:7px 10px; border-bottom:1px solid rgba(128,128,128,0.1); vertical-align:top; }
    tr:last-child td { border-bottom:none; }
    .badge { display:inline-block; padding:2px 7px; border-radius:3px; font-weight:700;
             font-size:0.78em; letter-spacing:0.3px; white-space:nowrap; }
    .badge-error   { background:rgba(183,28,28,0.18); color:#ef5350; }
    .badge-warning { background:rgba(230,119,0,0.18); color:#ffa726; }
    .field { font-family:var(--vscode-editor-font-family,monospace); font-size:0.9em; white-space:nowrap; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Cannot parse EDF/BDF header</h2>
    <p>${esc(error)}</p>
  </div>
  ${issuesSection}
</body>
</html>`;
}
