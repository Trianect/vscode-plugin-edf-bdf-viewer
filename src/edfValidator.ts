/**
 * EDF/BDF header validation.
 *
 * Validation rules are derived from the EDFbrowser open-source reference
 * implementation (check_edf_file.cpp, R. T. Milliken et al.) and the
 * EDF+/BDF+ specification at https://www.edfplus.info/specs.
 */
import { EdfHeader } from './edfParser';

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  field: string;
  message: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns 0-based index of the first byte outside printable ASCII [32,126], or -1. */
function firstBadAscii(buf: Uint8Array, offset: number, length: number): number {
  for (let i = 0; i < length; i++) {
    const b = buf[offset + i];
    if (b < 32 || b > 126) { return i; }
  }
  return -1;
}

function isInteger(s: string): boolean {
  return /^\s*[+-]?\d+\s*$/.test(s);
}

function isNumeric(s: string): boolean {
  return /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(s);
}

// ── Main validator ───────────────────────────────────────────────────────────

export function validateEdfHeader(data: Uint8Array, header: EdfHeader): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const isBdf    = header.format.startsWith('BDF');
  const isEdfPlus = header.format === 'EDF+C' || header.format === 'EDF+D';
  const isBdfPlus = header.format === 'BDF+C' || header.format === 'BDF+D';
  const isPlus   = isEdfPlus || isBdfPlus;

  function err(field: string, message: string): void {
    issues.push({ severity: 'error', field, message });
  }
  function warn(field: string, message: string): void {
    issues.push({ severity: 'warning', field, message });
  }

  function checkAscii(offset: number, length: number, field: string): void {
    const bad = firstBadAscii(data, offset, length);
    if (bad >= 0) {
      err(field,
        `Character ${bad + 1} is not valid 7-bit ASCII ` +
        `(byte 0x${data[offset + bad].toString(16).toUpperCase().padStart(2, '0')}).`);
    }
  }

  // ── Version ─────────────────────────────────────────────────────────────
  if (isBdf) {
    if (data[0] !== 0xFF) {
      err('version', `BDF files must begin with byte 0xFF (got 0x${data[0].toString(16).toUpperCase()}).`);
    }
    const bad = firstBadAscii(data, 1, 7);
    if (bad >= 0) {
      err('version', `Character ${bad + 2} of version field is not valid 7-bit ASCII.`);
    } else {
      const v = Array.from(data.slice(1, 8)).map(b => String.fromCharCode(b)).join('');
      if (v !== 'BIOSEMI') {
        err('version', `BDF version string is "${v}", expected "BIOSEMI".`);
      }
    }
  } else {
    checkAscii(0, 8, 'version');
    const v = Array.from(data.slice(0, 8)).map(b => String.fromCharCode(b)).join('');
    if (v !== '0       ') {
      err('version', `EDF version field is "${v.trimEnd()}", expected "0" followed by 7 spaces.`);
    }
  }

  // ── Patient ID ───────────────────────────────────────────────────────────
  checkAscii(8, 80, 'patient ID');

  // ── Recording ID ─────────────────────────────────────────────────────────
  checkAscii(88, 80, 'recording ID');

  // ── Start date  "dd.mm.yy" ───────────────────────────────────────────────
  checkAscii(168, 8, 'start date');
  if (data.length > 173) {
    if (data[170] !== 0x2E || data[173] !== 0x2E) {
      err('start date',
        `Separators must be "." (got "${String.fromCharCode(data[170])}" and "${String.fromCharCode(data[173])}").`);
    } else {
      const dd = parseInt(header.startDate.slice(0, 2), 10);
      const mm = parseInt(header.startDate.slice(3, 5), 10);
      if (isNaN(dd) || dd < 1 || dd > 31) {
        err('start date', `Day "${header.startDate.slice(0, 2)}" is out of range (01–31).`);
      }
      if (isNaN(mm) || mm < 1 || mm > 12) {
        err('start date', `Month "${header.startDate.slice(3, 5)}" is out of range (01–12).`);
      }
    }
  }

  // ── Start time  "hh.mm.ss" ───────────────────────────────────────────────
  checkAscii(176, 8, 'start time');
  if (data.length > 183) {
    if (data[178] !== 0x2E || data[181] !== 0x2E) {
      err('start time',
        `Separators must be "." (got "${String.fromCharCode(data[178])}" and "${String.fromCharCode(data[181])}").`);
    } else {
      const hh = parseInt(header.startTime.slice(0, 2), 10);
      const mn = parseInt(header.startTime.slice(3, 5), 10);
      const ss = parseInt(header.startTime.slice(6, 8), 10);
      if (isNaN(hh) || hh > 23) { err('start time', `Hour "${header.startTime.slice(0, 2)}" is out of range (00–23).`); }
      if (isNaN(mn) || mn > 59) { err('start time', `Minute "${header.startTime.slice(3, 5)}" is out of range (00–59).`); }
      if (isNaN(ss) || ss > 59) { err('start time', `Second "${header.startTime.slice(6, 8)}" is out of range (00–59).`); }
    }
  }

  // ── Header byte count ─────────────────────────────────────────────────────
  checkAscii(184, 8, 'header byte count');
  const expectedHdr = (header.numSignals + 1) * 256;
  if (header.headerBytes !== expectedHdr) {
    err('header byte count',
      `Value is ${header.headerBytes}; expected ${expectedHdr} ((${header.numSignals} signals + 1) × 256).`);
  }

  // ── Reserved field ────────────────────────────────────────────────────────
  checkAscii(192, 44, 'reserved field');

  // ── Data record count ─────────────────────────────────────────────────────
  checkAscii(236, 8, 'data record count');
  const drRaw = Array.from(data.slice(236, 244)).map(b => String.fromCharCode(b)).join('').trim();
  if (!isInteger(drRaw)) {
    err('data record count', `"${drRaw}" is not a valid integer.`);
  } else if (header.numDataRecords !== -1 && header.numDataRecords < 1) {
    err('data record count', `Value is ${header.numDataRecords}; expected > 0 (or -1 for unknown/continuous).`);
  }

  // ── Record duration ───────────────────────────────────────────────────────
  checkAscii(244, 8, 'record duration');
  if (!isNumeric(header.recordDurationSec)) {
    err('record duration', `"${header.recordDurationSec}" is not a valid number.`);
  } else if (parseFloat(header.recordDurationSec) < 0) {
    err('record duration', `Value is ${header.recordDurationSec}; expected ≥ 0.`);
  }

  // ── Signal count ──────────────────────────────────────────────────────────
  checkAscii(252, 4, 'signal count');
  if (header.numSignals < 1) {
    err('signal count', `Value is ${header.numSignals}; expected > 0.`);
  }

  // ── Record size limit (EDF ≤ 10 MB, BDF ≤ 15 MB) ─────────────────────────
  const bps = isBdf ? 3 : 2;
  const recordBytes = header.signals.reduce((a, s) => a + s.samplesPerRecord * bps, 0);
  const maxRecordBytes = isBdf ? 15_728_640 : 10_485_760;
  if (recordBytes > maxRecordBytes) {
    err('record size',
      `Data record is ${recordBytes.toLocaleString()} bytes; ` +
      `exceeds the ${isBdf ? '15 MB (BDF)' : '10 MB (EDF)'} per-record limit.`);
  }

  // ── Per-signal checks ──────────────────────────────────────────────────────
  const digRangeMin = isBdf ? -8388608 : -32768;
  const digRangeMax = isBdf ?  8388607 :  32767;
  const annotLabel  = (isEdfPlus ? 'EDF' : 'BDF') + ' Annotations ';
  let hasAnnotSig   = false;
  const ns   = header.signals.length;
  const base = 256;

  // Returns byte offset within the signal header block for field (fieldStart, fieldStride).
  // Signal header layout: ns consecutive blocks of each field (not interleaved).
  const sigOff = (fieldStart: number, stride: number, si: number) =>
    base + fieldStart * ns + si * stride;

  header.signals.forEach((sig, i) => {
    const n     = i + 1;
    const lbl   = sig.label.trim() || `#${n}`;
    const isAnnot = isPlus && sig.label.padEnd(16, ' ').slice(0, 16) === annotLabel;
    if (isAnnot) { hasAnnotSig = true; }

    // 7-bit ASCII checks for every raw byte in each sub-field
    checkAscii(sigOff(0,   16, i), 16, `signal ${n} label`);
    checkAscii(sigOff(16,  80, i), 80, `signal ${n} transducer`);
    checkAscii(sigOff(96,   8, i),  8, `signal ${n} physical dimension`);
    checkAscii(sigOff(104,  8, i),  8, `signal ${n} physical min`);
    checkAscii(sigOff(112,  8, i),  8, `signal ${n} physical max`);
    checkAscii(sigOff(120,  8, i),  8, `signal ${n} digital min`);
    checkAscii(sigOff(128,  8, i),  8, `signal ${n} digital max`);
    checkAscii(sigOff(136, 80, i), 80, `signal ${n} prefiltering`);
    checkAscii(sigOff(216,  8, i),  8, `signal ${n} samples/record`);

    // Physical min / max
    const physMinOk = isNumeric(sig.physicalMin);
    const physMaxOk = isNumeric(sig.physicalMax);
    if (!physMinOk) { err(`signal ${n} physical min`, `"${sig.physicalMin}" is not a valid number (signal "${lbl}").`); }
    if (!physMaxOk) { err(`signal ${n} physical max`, `"${sig.physicalMax}" is not a valid number (signal "${lbl}").`); }
    if (physMinOk && physMaxOk && parseFloat(sig.physicalMin) === parseFloat(sig.physicalMax)) {
      err(`signal ${n} physical range`,
        `Physical min equals physical max (${sig.physicalMax.trim()}) for signal "${lbl}".`);
    }

    // Digital min
    const digMinOk = isInteger(sig.digitalMin);
    if (!digMinOk) {
      err(`signal ${n} digital min`, `"${sig.digitalMin}" is not a valid integer (signal "${lbl}").`);
    } else {
      const digMin = parseInt(sig.digitalMin.trim(), 10);
      if (digMin < digRangeMin || digMin > digRangeMax) {
        err(`signal ${n} digital min`,
          `Value ${digMin} is outside [${digRangeMin}, ${digRangeMax}] for ${isBdf ? 'BDF' : 'EDF'} (signal "${lbl}").`);
      }
      if (isAnnot && isEdfPlus && digMin !== -32768) {
        err(`signal ${n} digital min`, `EDF Annotations digital min must be -32768 (got ${digMin}).`);
      }
      if (isAnnot && isBdfPlus && digMin !== -8388608) {
        err(`signal ${n} digital min`, `BDF Annotations digital min must be -8388608 (got ${digMin}).`);
      }
    }

    // Digital max
    const digMaxOk = isInteger(sig.digitalMax);
    if (!digMaxOk) {
      err(`signal ${n} digital max`, `"${sig.digitalMax}" is not a valid integer (signal "${lbl}").`);
    } else {
      const digMin = digMinOk ? parseInt(sig.digitalMin.trim(), 10) : NaN;
      const digMax = parseInt(sig.digitalMax.trim(), 10);
      if (digMax < digRangeMin || digMax > digRangeMax) {
        err(`signal ${n} digital max`,
          `Value ${digMax} is outside [${digRangeMin}, ${digRangeMax}] for ${isBdf ? 'BDF' : 'EDF'} (signal "${lbl}").`);
      }
      if (!isNaN(digMin) && digMax <= digMin) {
        err(`signal ${n} digital range`,
          `Digital max (${digMax}) must be > digital min (${digMin}) for signal "${lbl}".`);
      }
      if (isAnnot && isEdfPlus && digMax !== 32767) {
        err(`signal ${n} digital max`, `EDF Annotations digital max must be 32767 (got ${digMax}).`);
      }
      if (isAnnot && isBdfPlus && digMax !== 8388607) {
        err(`signal ${n} digital max`, `BDF Annotations digital max must be 8388607 (got ${digMax}).`);
      }
    }

    // Samples per record
    if (isNaN(sig.samplesPerRecord) || sig.samplesPerRecord < 1) {
      err(`signal ${n} samples/record`,
        `Value is ${sig.samplesPerRecord} for signal "${lbl}"; expected > 0.`);
    }

    // EDF+/BDF+ annotation channel: transducer and prefiltering must be blank
    if (isAnnot) {
      if (sig.transducerType.trim() !== '') {
        err(`signal ${n} transducer`,
          `${isEdfPlus ? 'EDF' : 'BDF'} Annotations transducer must be empty (got "${sig.transducerType.trim()}").`);
      }
      if (sig.prefiltering.trim() !== '') {
        err(`signal ${n} prefiltering`,
          `${isEdfPlus ? 'EDF' : 'BDF'} Annotations prefiltering must be empty (got "${sig.prefiltering.trim()}").`);
      }
    }
  });

  // ── EDF+/BDF+: annotations signal required ────────────────────────────────
  if (isPlus && !hasAnnotSig) {
    err('annotations signal',
      `File is marked as ${header.format} but has no "${annotLabel.trim()}" signal (required by the standard).`);
  }

  // ── EDF+/BDF+: recording field must start with "Startdate " ──────────────
  if (isPlus && !header.recordingId.startsWith('Startdate ')) {
    err('recording ID',
      `EDF+/BDF+ recording field must start with "Startdate " ` +
      `(got "${header.recordingId.slice(0, 20).trimEnd()}…").`);
  }

  // ── EDF+/BDF+: patient ID gender sub-field (M / F / X) ───────────────────
  if (isPlus) {
    const parts = header.patientId.split(' ').filter(Boolean);
    if (parts.length < 2) {
      warn('patient ID',
        'EDF+/BDF+ patient identification should have at least four space-separated sub-fields: code sex birthdate name.');
    } else if (!['M', 'F', 'X'].includes(parts[1])) {
      err('patient ID',
        `EDF+/BDF+ gender sub-field must be M, F, or X (unknown); got "${parts[1]}".`);
    }
  }

  return issues;
}

/**
 * Validate only the fixed 256-byte header portion without a pre-parsed EdfHeader.
 * Used as a fallback when full parsing fails, so the error page can show specific
 * field-level issues rather than just the raw parse exception.
 */
export function validateRawHeader(data: Uint8Array): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  function err(field: string, message: string): void {
    issues.push({ severity: 'error', field, message });
  }

  function checkAscii(offset: number, length: number, field: string): void {
    const end = Math.min(offset + length, data.length);
    for (let i = offset; i < end; i++) {
      const b = data[i];
      if (b < 32 || b > 126) {
        err(field,
          `Character ${i - offset + 1} is not valid 7-bit ASCII ` +
          `(byte 0x${b.toString(16).toUpperCase().padStart(2, '0')}).`);
        return;
      }
    }
  }

  function ascii(offset: number, length: number): string {
    let s = '';
    const end = Math.min(offset + length, data.length);
    for (let i = offset; i < end; i++) { s += String.fromCharCode(data[i]); }
    return s.trimEnd();
  }

  if (data.length < 256) {
    err('file size', `File is only ${data.length} bytes — too small to contain a valid EDF/BDF header (need ≥ 256 bytes).`);
    return issues;
  }

  // Version
  const isBdf = data[0] === 0xFF;
  if (isBdf) {
    const v = ascii(1, 7);
    if (v !== 'BIOSEMI') { err('version', `BDF version string is "${v}", expected "BIOSEMI".`); }
  } else {
    checkAscii(0, 8, 'version');
    const v = ascii(0, 8);
    if (v !== '0       ' && v.trimEnd() !== '0') {
      err('version', `EDF version field is "${v.trimEnd()}", expected "0" followed by 7 spaces.`);
    }
  }

  checkAscii(8,   80, 'patient ID');
  checkAscii(88,  80, 'recording ID');
  checkAscii(168,  8, 'start date');
  checkAscii(176,  8, 'start time');
  checkAscii(184,  8, 'header byte count');
  checkAscii(192, 44, 'reserved field');
  checkAscii(236,  8, 'data record count');
  checkAscii(244,  8, 'record duration');
  checkAscii(252,  4, 'signal count');

  // Start date separators and ranges
  if (data[170] !== 0x2E || data[173] !== 0x2E) {
    err('start date', `Date separators must be "." (got "${String.fromCharCode(data[170])}" and "${String.fromCharCode(data[173])}").`);
  } else {
    const date = ascii(168, 8);
    const dd = parseInt(date.slice(0, 2), 10);
    const mm = parseInt(date.slice(3, 5), 10);
    if (isNaN(dd) || dd < 1 || dd > 31) { err('start date', `Day "${date.slice(0, 2)}" is out of range (01–31).`); }
    if (isNaN(mm) || mm < 1 || mm > 12) { err('start date', `Month "${date.slice(3, 5)}" is out of range (01–12).`); }
  }

  // Start time separators and ranges
  if (data[178] !== 0x2E || data[181] !== 0x2E) {
    err('start time', `Time separators must be "." (got "${String.fromCharCode(data[178])}" and "${String.fromCharCode(data[181])}").`);
  } else {
    const time = ascii(176, 8);
    const hh = parseInt(time.slice(0, 2), 10);
    const mn = parseInt(time.slice(3, 5), 10);
    const ss = parseInt(time.slice(6, 8), 10);
    if (isNaN(hh) || hh > 23) { err('start time', `Hour "${time.slice(0, 2)}" is out of range (00–23).`); }
    if (isNaN(mn) || mn > 59) { err('start time', `Minute "${time.slice(3, 5)}" is out of range (00–59).`); }
    if (isNaN(ss) || ss > 59) { err('start time', `Second "${time.slice(6, 8)}" is out of range (00–59).`); }
  }

  // Numeric field sanity
  const nsRaw = ascii(252, 4).trim();
  const ns    = parseInt(nsRaw, 10);
  if (isNaN(ns) || ns < 1) {
    err('signal count', `"${nsRaw}" is not a valid signal count (expected a positive integer).`);
  }

  const drRaw = ascii(236, 8).trim();
  if (!/^\s*[+-]?\d+\s*$/.test(drRaw)) {
    err('data record count', `"${drRaw}" is not a valid integer.`);
  } else if (parseInt(drRaw, 10) !== -1 && parseInt(drRaw, 10) < 1) {
    err('data record count', `Value is ${drRaw}; expected > 0 (or -1 for unknown/continuous).`);
  }

  const rdRaw = ascii(244, 8).trim();
  if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(rdRaw)) {
    err('record duration', `"${rdRaw}" is not a valid number.`);
  }

  return issues;
}
