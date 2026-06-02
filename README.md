# EDF / BDF Viewer

A VS Code extension that previews the header of **EDF**, **BDF**, **EDF+** and **BDF+** biosignal files (EEG, ECG, polysomnography, and other physiological recordings).

Opening any `.edf` or `.bdf` file shows a structured, readable summary of the file header — without loading the full recording into memory.

---

## Features

- **Auto-preview** — double-clicking an EDF or BDF file opens the header view directly, no command needed.
- **All four variants** — detects EDF, EDF+C, EDF+D, BDF, BDF+C and BDF+D from the file header automatically.
- **Fast** — reads only the header bytes, not the full recording. Works on multi-GB files instantly.
- **Full signal table** — label, transducer type, physical unit, physical/digital min–max, prefiltering, and computed sample rate for every channel.
- **VS Code theme aware** — adapts to light, dark, and high-contrast themes.
- **Remote-friendly** — works with VS Code Remote (SSH, WSL, Dev Containers) via the VS Code file system API.

## Supported formats

| Format | Bit depth | Notes                  |
| ------ | --------- | ---------------------- |
| EDF    | 16-bit    | European Data Format   |
| EDF+C  | 16-bit    | EDF+ continuous        |
| EDF+D  | 16-bit    | EDF+ discontinuous     |
| BDF    | 24-bit    | BioSemi Data Format    |
| BDF+C  | 24-bit    | BDF+ continuous        |
| BDF+D  | 24-bit    | BDF+ discontinuous     |

See the full specification at [edfplus.info](https://www.edfplus.info/specs).

## What the preview shows

**General** — format variant, bit depth, start date/time, number of data records, record duration, total recording length, number of signals, header size.

**Patient identification** — raw patient field (EDF+: `patientcode sex birthdate name`).

**Recording identification** — raw recording field (EDF+: `Startdate date admincode technician equipment`).

**Signals table** — one row per channel:

| Column         | Description                                |
| -------------- | ------------------------------------------ |
| Label          | Channel name (e.g. `EEG Fp1`)             |
| Transducer     | Sensor type (e.g. `AgAgCl electrode`)     |
| Unit           | Physical dimension (e.g. `uV`)            |
| Phys min / max | Physical signal range                      |
| Dig min / max  | Digital signal range                       |
| Prefiltering   | Filter settings (e.g. `HP:0.1Hz LP:75Hz`) |
| Sample rate    | Samples per second (computed from header)  |

## Usage

Install the extension, then open any `.edf` or `.bdf` file. The header preview opens automatically.

To open a file as plain text instead, right-click it → **Open With… → Text Editor**.

## Development

### Prerequisites

- Node.js ≥ 18
- VS Code

### Run locally

```bash
npm install
```

Press **F5** in VS Code to launch the Extension Development Host with the extension active.

### Build

```bash
npm run compile   # single build
npm run watch     # watch mode
```

### Package

```bash
npx vsce package  # produces edf-bdf-viewer-x.x.x.vsix
```

Install the `.vsix` via **Extensions panel → ⋯ → Install from VSIX…** or:

```bash
code --install-extension edf-bdf-viewer-0.1.0.vsix
```

## Acknowledgements

This extension is not affiliated with or endorsed by the creators of the EDF/EDF+ standard. However, we highly support and appreciate the work of **Bob Kemp** and colleagues who created and maintain the European Data Format — an open, well-documented standard that has enabled decades of biosignal research and clinical practice. Learn more at [edfplus.info](https://www.edfplus.info).

## Disclaimer

This extension is provided as-is, without warranty of any kind. Always double-check the displayed header values against a trusted reference tool or the original file specification. The authors accept no responsibility for errors, omissions, or decisions made based on the output of this extension. AI (Claude) was used during creation of this convenience tool.

## License

[MIT](LICENSE)
