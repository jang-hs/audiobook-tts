# Narrate for Obsidian

Audiobook-style TTS for your notes.

Read any markdown note aloud through a local OpenAI-compatible TTS server. Gapless chunked playback, per-note resume, and a draggable mini-player — listen to your notes on a walk, while cooking, or just to rest your eyes.

## Requirements

A local OpenAI-compatible TTS server on `http://127.0.0.1:8000` (configurable).

- **OpenVox (recommended, macOS)** — [openvoxai.com](https://openvoxai.com/). Free app that exposes the `/v1` endpoints this plugin uses. Install, launch, done.
- **[ttsd](https://github.com/jang-hs/ttsd)** — my own self-hosted TTS server speaking the same `/v1` contract, with **no daily character limit**. Runs open-source backends (Kokoro, Chatterbox / Chatterbox Multilingual, Qwen3-TTS) with zero-shot voice cloning and up to 25 languages. Cross-platform (macOS MPS / Linux · Windows CUDA / CPU).
- Any other server speaking the same `/v1` contract works too.

## Quick start

1. Start OpenVox (or your compatible server).
2. Install the plugin (see [Install](#install)) and enable it under Settings → Community plugins.
3. In the plugin settings, click *Fetch* next to **Model / Language / Voice** and pick what you want.
4. Open a note and run `Read current note aloud`. The mini-toolbar appears at the bottom — that's your player.

Tip: select a sentence to get a one-click ▶ button next to it.

## Features

**Reading**
- Read current note, resume per note, or read from cursor
- Select text → inline ▶ button, right-click *Read selection aloud*, or command palette
- Reading queue: `Read this folder as a queue` / `Read backlinks as a queue`
- Jump to chunk via fuzzy modal (click `5/23` in the toolbar)
- Sleep timer (15 / 30 / 60 min)
- Estimated time shown when playback starts (e.g. `8 chunks · ≈ 12 min`)

**Playback**
- Draggable mini-toolbar: prev / play-pause / stop / next, live `mm:ss`, click-to-cycle speed, optional now-playing ticker
- Chunked synthesis with prefetch for gapless playback
- Configurable inter-chunk pause for natural breathing
- Pause / resume / stop / skip from the command palette

**Performance**
- Optional disk cache — chunks reused on re-read, server hit only once
- Optional warm-up on Obsidian start — first playback is instant

**Content filters**
- Always stripped: YAML frontmatter, images, HTML, wikilinks, markdown links, bare URLs
- Toggle: fenced code blocks, inline code, markdown tables (row/column order), parentheses `(...)` / `（...）`
- Headings read as their own paragraphs with a section pause

**Export**
- Save the spoken note as a single WAV file in the vault

## Commands

- Read current note aloud / Restart from beginning / Read from cursor
- Read selection aloud
- Stop · Pause/resume · Skip next/previous paragraph
- Jump to chunk…
- Read this folder as a queue / Read backlinks as a queue / Clear queue
- Toggle playback toolbar
- Generate audio file (no playback)
- Sleep timer: 15 / 30 / 60 min / cancel

Assign hotkeys under Settings → Hotkeys.

## Defaults

- API URL: `http://127.0.0.1:8000/v1`
- Model: `omnivoice`
- Language: `ko`
- Voice: `Korean-Female-Eunji`

Other Korean voices on OmniVoice: `Korean-Female-Jiwoo`, `Korean-Male-Hyunwoo`, `Korean-Male-Jihoon`, `Korean-Male-Junseo`.

## Install

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/jang-hs/obsidian-narrate/releases).
2. Copy them into `<vault>/.obsidian/plugins/narrate/` (create the folder if needed).
3. Settings → Community plugins → reload and enable **Narrate**.

### BRAT (pre-release)

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add `jang-hs/obsidian-narrate` as a beta plugin.

### Community plugin store

Pending submission.

## Audio file output

With **Save audio file** on (or via the generate command), all chunk WAVs are concatenated into one file written into the vault as `<noteName>.wav`.

- Empty `Audio folder` → saved next to the source note.
- Set `Audio folder` (e.g. `audiobooks`) → saved there using the source note's basename.
- Existing files are overwritten.

## Troubleshooting

- **"Local server unavailable"** — make sure OpenVox is running and the API URL in settings matches. Your notes are never modified.
- **No voices appear** — *Fetch* Language first, pick one, then *Fetch* Voice.
- **Choppy on long notes** — increase *Prefetch depth*, or enable the disk cache so re-reads skip the server.

## API contract

<details>
<summary>OpenAI/OpenVox <code>/v1</code> endpoints the plugin talks to</summary>

All requests go to the configured base URL (default `http://127.0.0.1:8000/v1`).

| Method | Path | Used for |
| --- | --- | --- |
| `GET` | `/health` | Reachability check before any speech request. |
| `GET` | `/models` | Populate the **Model** dropdown (the *Fetch* button). |
| `POST` | `/models/{model}/load` | Optional warm-up before the first speech request. |
| `GET` | `/models/{model}/languages` | Populate the **Language** dropdown. |
| `GET` | `/models/{model}/voices?language={code}` | Populate the **Voice** dropdown for the chosen language. |
| `POST` | `/audio/speech` | Synthesize one chunk; body `{ model, input, language, voice, response_format: "wav" }` returns a raw WAV. |
| `POST` | `/audio/speech` with `stream: true` | (Not used by default — plugin requests full WAV per chunk and prefetches the next ones.) Server-sent events `response.created` → `audio.chunk` (base64 WAV) → `response.completed`. |

Behavior:

- **429** → exponential backoff (600 ms → cap 8 s, up to 20 attempts). One job runs at a time on OpenVox, so the plugin serializes prefetches and cancels in-flight requests when you skip or stop.
- **Missing voice** → refetch voices for the same language and pick the first valid one instead of failing.
- **Server unreachable** → single "local server unavailable" notice; notes are never touched and Obsidian stays responsive.
- **Stop / new session** → all in-flight requests are cancelled via `AbortController` so the server doesn't keep working in the background.

</details>

## License

MIT — see [LICENSE](LICENSE).

## Support

If this plugin makes your reading life a little better, you can buy me a coffee — it's genuinely appreciated and helps keep the project maintained.

<a href="https://buymeacoffee.com/jadez" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="40"></a>
