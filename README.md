# Audiobook TTS — Obsidian plugin

Read markdown notes aloud as an audiobook using a local OpenAI-compatible TTS server. Works with:

- the **OpenVox** Mac app (https://openvoxai.com/), or
- any OpenVox-compatible server speaking the same `/v1` contract.

## Features

- Read the current note aloud
- **Resume per note** — stop midway, come back later, and playback picks up where you left off
- **Read from cursor** — jump into a long note at a specific point without selecting text
- **Select any sentence → a small play button appears next to it.** Click to hear just that sentence. Also available via right-click → "Read selection aloud", or the command palette
- Estimated reading time shown in the opening notice (e.g. `8 chunks queued · ≈ 12 min`)
- **Reading queue** — `Read this folder as a queue` or `Read backlinks as a queue` plays multiple notes back-to-back
- **Jump to chunk** — fuzzy modal lists every chunk in the current note; click `5/23` in the toolbar to open it
- **Sleep timer** — auto-stop after 15 / 30 / 60 min via command palette
- Draggable playback toolbar with prev / play-pause / stop / next, live `mm:ss / mm:ss` progress, click-to-cycle playback speed, and an optional ticker that shows the currently-spoken chunk
- Skip-prev cancels the in-flight prefetch (single-job server stays clean — no 429 cascade)
- Pause / resume / stop from the command palette
- Splits long notes into chunks and **prefetches the next chunks while playing** — gapless playback, with configurable inter-chunk pause for natural breathing
- **Optional disk cache** — synthesized chunks are saved under the vault and re-used on re-read, so the server is only hit once per chunk
- **Optional warm-up on Obsidian start** — first playback starts instantly
- Content filters:
  - YAML frontmatter — always stripped
  - Fenced code blocks (` ``` `, `~~~`, mermaid/diagrams) — toggle
  - Inline code — toggle
  - Markdown tables — toggle, with row/column read order
  - Parentheses `(...)` and `（...）` — toggle (useful for skipping inline definitions)
  - Images, HTML comments, raw HTML, wikilinks, markdown links, bare URLs — auto-stripped
  - Headings are read as their own paragraphs with a natural section pause
- Save the spoken audio as a single WAV file alongside the note

## Defaults

- API URL: `http://127.0.0.1:8000/v1`
- Model: `omnivoice`
- Language: `ko`
- Voice: `Korean-Female-Eunji`

Other Korean voices on OmniVoice: `Korean-Female-Jiwoo`, `Korean-Male-Hyunwoo`, `Korean-Male-Jihoon`, `Korean-Male-Junseo`.

## Commands

- **Read current note aloud** — resumes from the last position if you stopped midway
- **Restart current note from the beginning** — same as above but ignores the saved position
- **Read from cursor position** — reads from the cursor to the end (one-shot, not bookmarked)
- **Read selection aloud**
- **Stop playback** / **Pause / resume**
- **Skip to next / previous paragraph**
- **Jump to chunk…** — fuzzy modal listing every chunk of the playing note
- **Read this folder as a queue** — auto-plays sibling notes after the current one
- **Read backlinks as a queue** — auto-plays every note that links to this one
- **Clear reading queue**
- **Toggle playback toolbar**
- **Generate audio file for current note (no playback)**
- **Sleep timer: 15 min / 30 min / 60 min / cancel**

Assign hotkeys via Obsidian → Settings → Hotkeys.

## Audio file output

When **Save audio file** is on (or you run the generate command), the plugin concatenates all chunk WAVs into a single file and writes it inside the vault as `<noteName>.wav`.

- `Audio folder` empty → saved in the same folder as the source note.
- `Audio folder` set (e.g. `audiobooks`) → saved under that vault-relative folder using the source note's basename.
- Existing files are overwritten.
- Skip-prev / skip-next during playback don't break the save — chunks are deduplicated by index and saved in source order.

## API contract (OpenAI/OpenVox `/v1`)

1. `GET /models` (via the "Fetch" button next to Model in settings)
2. `POST /models/{model}/load` before the first request (optional preload)
3. `GET /models/{model}/languages` and `GET /models/{model}/voices?language=…` (via the "Fetch" buttons)
4. `POST /audio/speech` with `{ model, input, language, voice, response_format: "wav" }` per chunk
5. On HTTP 429 → exponential backoff (600ms → cap 8s), up to 20 attempts. Cancellable via `AbortController`.
6. On missing voice → refetch voices for the same language and pick the first valid one
7. `stop()` and new playback sessions abort all in-flight requests via the session abort signal — no leftover load on the server.

## Install

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/jang-hs/audiobook-tts/releases).
2. Copy them into `<vault>/.obsidian/plugins/audiobook-tts/` (create the folder if needed).
3. In Obsidian → Settings → Community plugins, reload the plugin list and enable **Audiobook TTS**.

### BRAT (for pre-release testing)

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add `jang-hs/audiobook-tts` as a beta plugin.

### Community plugin store

Pending submission.

## Behavior when the server is offline

If the local TTS server isn't reachable, the plugin shows a single notice ("local server unavailable") and does nothing else — your notes are never touched and Obsidian remains responsive.

## License

Released under the MIT License — see [LICENSE](LICENSE).
