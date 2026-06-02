export type EdfFormat = 'EDF' | 'EDF+C' | 'EDF+D' | 'BDF' | 'BDF+C' | 'BDF+D';

export interface SignalHeader {
  label: string;
  transducerType: string;
  physicalDimension: string;
  physicalMin: string;
  physicalMax: string;
  digitalMin: string;
  digitalMax: string;
  prefiltering: string;
  samplesPerRecord: number;
  reserved: string;
}

export interface EdfHeader {
  format: EdfFormat;
  version: string;
  patientId: string;
  recordingId: string;
  startDate: string;
  startTime: string;
  headerBytes: number;
  reserved: string;
  numDataRecords: number;
  recordDurationSec: string;
  numSignals: number;
  signals: SignalHeader[];
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

// Read ASCII bytes from a fixed-width field and strip trailing spaces.
function readAscii(buf: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(buf[offset + i]);
  }
  return s.trimEnd();
}

export function parseEdfHeader(data: Uint8Array): EdfHeader {
  if (data.length < 256) {
    throw new ParseError(
      `File is too small to contain a valid EDF/BDF header (got ${data.length} bytes, need ≥ 256)`
    );
  }

  // BDF files begin with byte 0xFF followed by "BIOSEMI" instead of "0       "
  const isBdf = data[0] === 0xff;
  const version = isBdf ? 'BDF' : readAscii(data, 0, 8).trim();

  const patientId = readAscii(data, 8, 80);
  const recordingId = readAscii(data, 88, 80);
  const startDate = readAscii(data, 168, 8).trim();
  const startTime = readAscii(data, 176, 8).trim();
  const headerBytes = parseInt(readAscii(data, 184, 8).trim(), 10);
  const reserved = readAscii(data, 192, 44).trim();
  const numDataRecords = parseInt(readAscii(data, 236, 8).trim(), 10);
  const recordDurationSec = readAscii(data, 244, 8).trim();
  const numSignals = parseInt(readAscii(data, 252, 4).trim(), 10);

  if (isNaN(numSignals) || numSignals < 0) {
    throw new ParseError(`Invalid signal count in header: "${readAscii(data, 252, 4)}"`);
  }

  const safeNs = Math.min(numSignals, 512);
  const requiredBytes = (safeNs + 1) * 256;

  if (data.length < requiredBytes) {
    throw new ParseError(
      `Header is truncated: need ${requiredBytes} bytes for ${safeNs} signals, got ${data.length}`
    );
  }

  let format: EdfFormat;
  if (isBdf) {
    format = reserved.startsWith('BDF+D') ? 'BDF+D'
           : reserved.startsWith('BDF+C') ? 'BDF+C'
           : 'BDF';
  } else {
    format = reserved.startsWith('EDF+D') ? 'EDF+D'
           : reserved.startsWith('EDF+C') ? 'EDF+C'
           : 'EDF';
  }

  // Per-signal fields are stored as ns consecutive blocks of the same field,
  // not interleaved per signal. Cumulative offsets from byte 256:
  //   labels         : ns × 16
  //   transducers    : ns × 80  (starts at ns*16)
  //   physDimensions : ns ×  8  (starts at ns*96)
  //   physMins       : ns ×  8  (starts at ns*104)
  //   physMaxs       : ns ×  8  (starts at ns*112)
  //   digMins        : ns ×  8  (starts at ns*120)
  //   digMaxs        : ns ×  8  (starts at ns*128)
  //   prefilters     : ns × 80  (starts at ns*136)
  //   samplesPerRec  : ns ×  8  (starts at ns*216)
  //   reserved       : ns × 32  (starts at ns*224)
  //   total          : ns * 256

  const base = 256;
  const ns = safeNs;

  const signals: SignalHeader[] = Array.from({ length: ns }, (_, i) => ({
    label:             readAscii(data, base + i * 16,                   16),
    transducerType:    readAscii(data, base + ns * 16  + i * 80,        80),
    physicalDimension: readAscii(data, base + ns * 96  + i * 8,          8),
    physicalMin:       readAscii(data, base + ns * 104 + i * 8,          8),
    physicalMax:       readAscii(data, base + ns * 112 + i * 8,          8),
    digitalMin:        readAscii(data, base + ns * 120 + i * 8,          8),
    digitalMax:        readAscii(data, base + ns * 128 + i * 8,          8),
    prefiltering:      readAscii(data, base + ns * 136 + i * 80,        80),
    samplesPerRecord:  parseInt(readAscii(data, base + ns * 216 + i * 8, 8).trim(), 10),
    reserved:          readAscii(data, base + ns * 224 + i * 32,        32),
  }));

  return {
    format,
    version,
    patientId,
    recordingId,
    startDate,
    startTime,
    headerBytes,
    reserved,
    numDataRecords,
    recordDurationSec,
    numSignals,
    signals,
  };
}

// ── Signal data reading ─────────────────────────────────────────────────────

export interface SignalChunk {
  label: string;
  unit: string;
  sampleRate: number;
  physMin: number;
  physMax: number;
  durationSec: number;
  /** Min-max envelope for display. Interleaved [min0, max0, min1, max1, …].
   *  Length = displayPoints × 2. */
  envelope: number[];
}

/**
 * Read sample data from the raw data records portion of an EDF/BDF file and
 * return a min-max display envelope for each signal.
 *
 * @param dataBuf    Bytes starting at header.headerBytes (data records only).
 * @param header     Parsed file header.
 * @param maxSeconds Maximum seconds of data to read.
 * @param displayPoints Number of horizontal display columns (canvas pixel width).
 */
export function readSignalData(
  dataBuf: Uint8Array,
  header: EdfHeader,
  maxSeconds: number,
  displayPoints: number,
): SignalChunk[] {
  const recDur = parseFloat(header.recordDurationSec);
  if (!isFinite(recDur) || recDur <= 0 || header.numDataRecords <= 0) {
    return [];
  }

  const numRecords = Math.min(
    header.numDataRecords,
    Math.ceil(maxSeconds / recDur),
  );

  const isBdf = header.format.startsWith('BDF');
  const bps = isBdf ? 3 : 2; // bytes per sample

  // Pre-compute the byte offset of each signal within a single record.
  const sigByteOffsets: number[] = [];
  let cursor = 0;
  for (const sig of header.signals) {
    sigByteOffsets.push(cursor);
    cursor += sig.samplesPerRecord * bps;
  }
  const recordSize = cursor;

  return header.signals.map((sig, si) => {
    const digMin = parseFloat(sig.digitalMin);
    const digMax = parseFloat(sig.digitalMax);
    const physMin = parseFloat(sig.physicalMin);
    const physMax = parseFloat(sig.physicalMax);
    const gain = digMax !== digMin ? (physMax - physMin) / (digMax - digMin) : 0;

    const totalSamples = numRecords * sig.samplesPerRecord;
    const samples = new Float32Array(totalSamples);
    let count = 0;

    for (let ri = 0; ri < numRecords; ri++) {
      const recBase = ri * recordSize + sigByteOffsets[si];
      for (let k = 0; k < sig.samplesPerRecord; k++) {
        const pos = recBase + k * bps;
        if (pos + bps > dataBuf.length) { break; }

        let dig: number;
        if (isBdf) {
          // 24-bit little-endian signed
          dig = dataBuf[pos] | (dataBuf[pos + 1] << 8) | (dataBuf[pos + 2] << 16);
          if (dig >= 0x800000) { dig -= 0x1000000; }
        } else {
          // 16-bit little-endian signed
          dig = dataBuf[pos] | (dataBuf[pos + 1] << 8);
          if (dig >= 0x8000) { dig -= 0x10000; }
        }

        samples[count++] = physMin + gain * (dig - digMin);
      }
    }

    // Build min-max envelope: for each display column find min and max of all
    // samples in that time window.  This preserves transients regardless of the
    // downsampling ratio.
    const envelope: number[] = new Array(displayPoints * 2);
    const spCol = count / displayPoints;

    for (let col = 0; col < displayPoints; col++) {
      const start = Math.floor(col * spCol);
      const end   = Math.min(Math.floor((col + 1) * spCol), count);
      let lo = Infinity, hi = -Infinity;
      for (let s = start; s < end; s++) {
        if (samples[s] < lo) { lo = samples[s]; }
        if (samples[s] > hi) { hi = samples[s]; }
      }
      envelope[col * 2]     = isFinite(lo) ? lo : physMin;
      envelope[col * 2 + 1] = isFinite(hi) ? hi : physMax;
    }

    return {
      label:      sig.label,
      unit:       sig.physicalDimension,
      sampleRate: sig.samplesPerRecord / recDur,
      physMin,
      physMax,
      durationSec: numRecords * recDur,
      envelope,
    };
  });
}
