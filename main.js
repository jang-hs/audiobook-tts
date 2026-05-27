'use strict';

const obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
  apiUrl: 'http://127.0.0.1:8000/v1',
  model: 'omnivoice',
  language: 'ko',
  voice: 'Korean-Female-Eunji',
  chunkSize: 200,
  playbackRate: 1.0,
  skipCode: true,
  readTables: true,
  readParens: true,
  tableOrder: 'row', // 'row' | 'col'
  toolbarVisible: true,
  saveAudio: false,
  audioFolder: '', // empty = same folder as source note; otherwise vault-relative folder
  prefetchDepth: 2, // chunks to pre-synthesize beyond the current one
  selectionPlayButton: true, // show floating play button when text is selected
  paragraphPauseMs: 250, // silent gap inserted between chunks for natural breathing
  autoResume: true, // resume each note from the last position we stopped at
  resumePositions: {}, // map of vault path → next chunk index to play
  cacheAudio: false, // store synthesized WAV blobs to disk so re-reads skip the server
  cacheFolder: '.audiobook-tts-cache', // vault-relative folder for the audio cache
  preloadOnStartup: false, // warm the model on Obsidian start so first playback is instant
  showChunkTicker: false, // toolbar shows the currently-playing chunk text
};

class AudiobookTTSPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    this.audio = null;
    this.aborted = false;
    this.currentChunkIdx = 0;
    this.totalChunks = 0;
    this.currentFile = null;
    this.toolbar = null;
    this.chunks = [];
    this.pendingSkip = 0; // -1 prev, 0 normal, +1 next
    this.playResolve = null;
    this.sessionAborter = null;     // cancels all in-flight fetches when stop()/new speak()
    this.lastSessionEnd = 0;        // ms timestamp; used for short cooldown after abort
    this.blobs = new Map();         // idx → Promise<Blob>; prefetch cache
    this.blobAborters = new Map();  // idx → AbortController; per-prefetch cancel

    this.statusItem = this.addStatusBarItem();
    this.setStatus('idle');

    this.addRibbonIcon('headphones', 'Audiobook TTS toolbar', () => this.toggleToolbar());

    this.addCommand({
      id: 'read-current-note',
      name: 'Read current note aloud',
      callback: () => { this.readActiveNote().catch(() => { /* silenced */ }); },
    });

    this.addCommand({
      id: 'read-selection',
      name: 'Read selection aloud',
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (!sel) {
          new obsidian.Notice('Audiobook TTS: no selection');
          return;
        }
        this.speakSelection(sel);
      },
    });

    this.addCommand({
      id: 'stop',
      name: 'Stop playback',
      callback: () => this.stop(),
    });

    this.addCommand({
      id: 'pause-resume',
      name: 'Pause / resume',
      callback: () => this.togglePause(),
    });

    this.addCommand({
      id: 'toggle-toolbar',
      name: 'Toggle playback toolbar',
      callback: () => this.toggleToolbar(),
    });

    this.addCommand({
      id: 'generate-audio-no-playback',
      name: 'Generate audio file for current note (no playback)',
      callback: () => this.generateActiveNote(),
    });

    this.addCommand({
      id: 'skip-next',
      name: 'Skip to next paragraph',
      callback: () => this.skipNext(),
    });

    this.addCommand({
      id: 'skip-prev',
      name: 'Skip to previous paragraph',
      callback: () => this.skipPrev(),
    });

    this.addCommand({
      id: 'read-from-cursor',
      name: 'Read from cursor position',
      callback: () => { this.readFromCursor().catch(() => { /* silenced */ }); },
    });

    this.addCommand({
      id: 'restart-from-beginning',
      name: 'Restart current note from the beginning',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) this.clearResumePosition(file.path);
        this.readActiveNote().catch(() => { /* silenced */ });
      },
    });

    this.addCommand({
      id: 'jump-to-chunk',
      name: 'Jump to chunk…',
      callback: () => this.openChunkJumpModal(),
    });

    this.addCommand({
      id: 'queue-folder',
      name: 'Read this folder as a queue',
      callback: () => this.queueFolder(),
    });

    this.addCommand({
      id: 'queue-backlinks',
      name: 'Read backlinks as a queue',
      callback: () => this.queueBacklinks(),
    });

    this.addCommand({
      id: 'clear-queue',
      name: 'Clear reading queue',
      callback: () => this.clearQueue(),
    });

    for (const minutes of [15, 30, 60]) {
      this.addCommand({
        id: `sleep-timer-${minutes}`,
        name: `Sleep timer: ${minutes} min`,
        callback: () => this.setSleepTimer(minutes),
      });
    }
    this.addCommand({
      id: 'sleep-timer-cancel',
      name: 'Sleep timer: cancel',
      callback: () => {
        this.clearSleepTimer();
        new obsidian.Notice('Audiobook TTS: sleep timer cancelled.', 2500);
      },
    });

    this.addSettingTab(new AudiobookTTSSettingsTab(this.app, this));

    // Right-click context menu: "Read selection aloud"
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        const sel = editor.getSelection();
        if (!sel || !sel.trim()) return;
        menu.addItem((item) =>
          item.setTitle('Read selection aloud')
            .setIcon('headphones')
            .onClick(() => this.speakSelection(sel))
        );
      })
    );

    // Build toolbar + selection play button after layout is ready
    this.app.workspace.onLayoutReady(() => {
      this.toolbar = new PlaybackToolbar(this);
      if (this.settings.toolbarVisible) this.toolbar.show();
      this.selectionButton = new SelectionPlayButton(this);

      // Vault index is reliable now — safe to prune stale resume positions.
      this.cleanupResumePositions();

      // 250ms tick to refresh the time display. registerInterval makes
      // Obsidian clear it on plugin unload — no leak.
      this.registerInterval(window.setInterval(() => {
        if (this.toolbar) this.toolbar.updateTimeDisplay();
      }, 250));

      // Optional: warm the TTS model so the first playback starts instantly.
      // Runs detached from the load sequence — failures are silent (the user
      // will only learn the server is down when they try to play something).
      if (this.settings.preloadOnStartup) {
        this.loadModel(this.settings.model).catch(() => { /* best-effort */ });
      }
    });
  }

  onunload() {
    this.clearSleepTimer();
    this.stop();
    if (this.toolbar) this.toolbar.destroy();
    if (this.selectionButton) this.selectionButton.destroy();
  }

  speakSelection(text) {
    if (!text || !text.trim()) return;
    const clean = cleanMarkdown(text, this.settings);
    if (!clean.trim()) return;
    // Ad-hoc selection read — never anchor to a file (saveAudio off, no
    // resume tracking) so it can't accidentally overwrite the previous
    // note's WAV or pollute its saved resume position.
    this.currentFile = null;
    this.speak(clean, { play: true, save: false });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Resume cleanup waits for layout-ready — at load time vault.getMarkdownFiles()
    // can return an incomplete list and we'd wrongly prune entries for notes
    // that simply haven't been indexed yet.
  }

  // Prune entries for notes that no longer exist in the vault. Stale entries
  // accumulate forever otherwise (every renamed/deleted note leaves a key).
  cleanupResumePositions() {
    const map = this.settings.resumePositions;
    if (!map || typeof map !== 'object') return;
    const live = new Set(this.app.vault.getMarkdownFiles().map((f) => f.path));
    let pruned = 0;
    for (const path of Object.keys(map)) {
      if (!live.has(path)) { delete map[path]; pruned++; }
    }
    if (pruned > 0) this.saveData(this.settings).catch(() => {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.toolbar) this.toolbar.syncFromSettings();
  }

  setStatus(text) {
    const q = (this.queue && this.queue.length)
      ? ` · queue ${this.queueIdx + 1}/${this.queue.length}` : '';
    if (this.statusItem) {
      this.statusItem.setText(text ? `Audiobook TTS · ${text}${q}` : '');
    }
    if (this.toolbar) this.toolbar.setProgress(this.currentChunkIdx, this.totalChunks, text);
  }

  toggleToolbar() {
    if (!this.toolbar) return;
    if (this.toolbar.isVisible()) {
      this.toolbar.hide();
      this.settings.toolbarVisible = false;
    } else {
      this.toolbar.show();
      this.settings.toolbarVisible = true;
    }
    this.saveData(this.settings); // skip toolbar resync
  }

  isBusy() {
    return !!this.sessionAborter;
  }

  async readActiveNote() {
    if (this.isBusy()) {
      new obsidian.Notice('Audiobook TTS: already preparing — press Stop to cancel.', 2500);
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new obsidian.Notice('Audiobook TTS: no active markdown file');
      return;
    }
    this.currentFile = file;
    const raw = await this.app.vault.cachedRead(file);
    const text = cleanMarkdown(raw, this.settings);
    if (!text.trim()) {
      new obsidian.Notice('Audiobook TTS: nothing to read after cleanup');
      return;
    }
    await this.awaitCooldown();
    const startIdx = this.settings.autoResume ? this.getResumePosition(file.path) : 0;
    await this.speak(text, { play: true, save: this.settings.saveAudio, startIdx });
  }

  async readFromCursor() {
    if (this.isBusy()) {
      new obsidian.Notice('Audiobook TTS: already preparing — press Stop to cancel.', 2500);
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view || !view.editor) {
      new obsidian.Notice('Audiobook TTS: no active markdown file');
      return;
    }
    const editor = view.editor;
    const cursor = editor.getCursor();
    const offset = editor.posToOffset(cursor);
    const raw = editor.getValue().slice(offset);
    const text = cleanMarkdown(raw, this.settings);
    if (!text.trim()) {
      new obsidian.Notice('Audiobook TTS: nothing to read after cleanup');
      return;
    }
    // Reading from cursor is intentionally one-shot — don't taint the
    // saved resume position with this ad-hoc slice.
    this.currentFile = null;
    await this.awaitCooldown();
    await this.speak(text, { play: true, save: false });
  }

  // ---- Resume positions ----

  getResumePosition(path) {
    const map = this.settings.resumePositions || {};
    const v = map[path];
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  saveResumePosition(path, idx) {
    if (!path) return;
    if (!this.settings.resumePositions) this.settings.resumePositions = {};
    this.settings.resumePositions[path] = idx;
    // Best-effort persistence — don't await here so the playback loop
    // doesn't stall on disk I/O between chunks.
    this.saveData(this.settings).catch(() => { /* noop */ });
  }

  clearResumePosition(path) {
    if (!path || !this.settings.resumePositions) return;
    if (path in this.settings.resumePositions) {
      delete this.settings.resumePositions[path];
      this.saveData(this.settings).catch(() => { /* noop */ });
    }
  }

  // ---- Sleep timer ----

  setSleepTimer(minutes) {
    this.clearSleepTimer();
    if (!minutes || minutes <= 0) return;
    const ms = minutes * 60 * 1000;
    this.sleepTimerEndAt = Date.now() + ms;
    this.sleepTimerId = window.setTimeout(() => {
      this.sleepTimerId = null;
      this.sleepTimerEndAt = 0;
      this.stop();
      new obsidian.Notice(`Audiobook TTS: sleep timer fired — playback stopped.`, 4000);
    }, ms);
    new obsidian.Notice(`Audiobook TTS: sleep timer set for ${minutes} min.`, 3000);
  }

  clearSleepTimer() {
    if (this.sleepTimerId) {
      window.clearTimeout(this.sleepTimerId);
      this.sleepTimerId = null;
      this.sleepTimerEndAt = 0;
    }
  }

  // ---- Reading queue ----

  queueFolder() {
    const cur = this.app.workspace.getActiveFile();
    if (!cur || cur.extension !== 'md') {
      new obsidian.Notice('Audiobook TTS: no active markdown file');
      return;
    }
    const parent = cur.parent;
    if (!parent) {
      new obsidian.Notice('Audiobook TTS: active note has no folder');
      return;
    }
    const files = parent.children
      .filter((f) => f instanceof obsidian.TFile && f.extension === 'md')
      .sort((a, b) => a.basename.localeCompare(b.basename));
    const startIdx = files.findIndex((f) => f.path === cur.path);
    this.queue = files.slice(Math.max(0, startIdx));
    this.queueIdx = 0;
    new obsidian.Notice(`Audiobook TTS: queued ${this.queue.length} note(s) from ${parent.path || '/'}.`, 3500);
    if (!this.isBusy()) this.readActiveNote().catch(() => { /* silenced */ });
  }

  queueBacklinks() {
    const cur = this.app.workspace.getActiveFile();
    if (!cur || cur.extension !== 'md') {
      new obsidian.Notice('Audiobook TTS: no active markdown file');
      return;
    }
    const mc = this.app.metadataCache;
    // getBacklinksForFile returns a custom data structure; .data is a record
    // keyed by source path. Older Obsidian versions exposed resolvedLinks
    // instead, so fall back if needed.
    let paths = [];
    if (typeof mc.getBacklinksForFile === 'function') {
      const bl = mc.getBacklinksForFile(cur);
      if (bl && bl.data) paths = Object.keys(bl.data);
    }
    if (!paths.length && mc.resolvedLinks) {
      paths = Object.entries(mc.resolvedLinks)
        .filter(([_, targets]) => targets && targets[cur.path])
        .map(([source]) => source);
    }
    const files = paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f) => f instanceof obsidian.TFile && f.extension === 'md')
      .sort((a, b) => a.basename.localeCompare(b.basename));
    if (!files.length) {
      new obsidian.Notice('Audiobook TTS: no backlinks for this note.', 3000);
      return;
    }
    this.queue = files;
    this.queueIdx = 0;
    new obsidian.Notice(`Audiobook TTS: queued ${files.length} backlink note(s).`, 3500);
    this.playQueueHead().catch(() => { /* silenced */ });
  }

  clearQueue() {
    const n = (this.queue && this.queue.length) || 0;
    this.queue = [];
    this.queueIdx = 0;
    if (n) new obsidian.Notice(`Audiobook TTS: cleared queue (${n} note(s)).`, 2500);
  }

  async playQueueHead() {
    if (!this.queue || !this.queue.length) return;
    const file = this.queue[this.queueIdx];
    if (!file) return;
    // Open the file so currentFile / resume tracking lines up with the UI.
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    await this.readActiveNote();
  }

  playNextInQueue() {
    if (!this.queue || !this.queue.length) return;
    this.queueIdx += 1;
    if (this.queueIdx >= this.queue.length) {
      const total = this.queue.length;
      this.queue = [];
      this.queueIdx = 0;
      new obsidian.Notice(`Audiobook TTS: finished queue (${total} note(s)).`, 3500);
      return;
    }
    // Defer so the current speak() can finish its idle-state cleanup before
    // the next speak() calls stop() on it. Track the timer so stop() and
    // onunload can cancel it — otherwise an aborted handoff fires anyway.
    if (this._queueAdvanceTimer) window.clearTimeout(this._queueAdvanceTimer);
    this._queueAdvanceTimer = window.setTimeout(() => {
      this._queueAdvanceTimer = null;
      this.playQueueHead().catch(() => { /* silenced */ });
    }, 200);
  }

  async generateActiveNote() {
    if (this.isBusy()) {
      new obsidian.Notice('Audiobook TTS: already preparing — press Stop to cancel.', 2500);
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new obsidian.Notice('Audiobook TTS: no active markdown file');
      return;
    }
    this.currentFile = file;
    const raw = await this.app.vault.cachedRead(file);
    const text = cleanMarkdown(raw, this.settings);
    if (!text.trim()) {
      new obsidian.Notice('Audiobook TTS: nothing to generate after cleanup');
      return;
    }
    await this.awaitCooldown();
    await this.speak(text, { play: false, save: true });
  }

  // Brief wait after a stop/abort so the server has time to release the
  // single-job lock from the request it was processing — otherwise the new
  // request will eat a string of 429s while the previous one finishes.
  async awaitCooldown() {
    // The TTS server is single-job: an in-flight synthesis from the previous
    // session keeps the lock long after our client-side abort. Wait scales
    // with how long the previous session ran — short stops drain fast, long
    // stops (server mid-synthesis of a big chunk) need more headroom.
    // Capped at 4s so the user never waits an unreasonable amount.
    const minWait = 1500;
    const scaled = this._lastSessionDuration
      ? Math.min(4000, Math.max(minWait, Math.round(this._lastSessionDuration * 0.7)))
      : minWait;
    const elapsed = Date.now() - this.lastSessionEnd;
    if (this.lastSessionEnd > 0 && elapsed < scaled) {
      await sleep(scaled - elapsed);
    }
  }

  async speak(text, opts) {
    opts = opts || { play: true, save: this.settings.saveAudio };
    this.stop();
    this.aborted = false;
    this.pendingSkip = 0;
    this.sessionAborter = new AbortController();
    this.playedDurations = [];
    this.fullText = text;
    // Record when this session started so awaitCooldown can size the next
    // cooldown proportional to how long the server might still be locked.
    this._sessionStartedAt = Date.now();

    if (this.toolbar && this.settings.toolbarVisible !== false) this.toolbar.show();
    if (this.toolbar) this.toolbar.syncPlayButtonState(); // show loading spinner

    this.chunks = chunkText(text, this.settings.chunkSize);
    this.totalChunks = this.chunks.length;
    // Clamp startIdx so a stale resume position never lands past the new chunk count.
    const startIdx = Math.max(0, Math.min(this.chunks.length - 1, opts.startIdx | 0));
    this.currentChunkIdx = startIdx;
    this.setStatus(`preparing`);
    const minutes = estimateMinutes(text, this.settings.playbackRate);
    const eta = minutes ? ` · ≈ ${minutes} min` : '';
    const queueNote = opts.save
      ? `Audiobook TTS: ${this.chunks.length} chunk(s) queued (saving)`
      : `Audiobook TTS: ${this.chunks.length} chunk(s) queued`;
    new obsidian.Notice(queueNote + eta);

    // Use an index→blob map so skip-prev re-orders cleanly for saving.
    const blobsByIdx = opts.save ? new Map() : null;

    try {
      // No per-speak /load call: it competes with /audio/speech on the
      // single-job server and causes a 429 backoff spam in the console for
      // no benefit (the speech endpoint loads the model implicitly on
      // first use). Cold-start warm-up is opt-in via `preloadOnStartup`.

      // Multi-chunk prefetch: chain syntheses sequentially (OpenVox is
      // single-job — parallel requests just 429). startPrefetch(idx) queues
      // a synthesis after the previous prefetched one finishes.
      this.blobs.clear();
      this.blobAborters.clear();
      const depth = Math.max(1, Math.min(5, this.settings.prefetchDepth || 2));
      this._prefetchDepth = depth;

      const startPrefetch = (idx) => {
        if (idx < 0 || idx >= this.chunks.length) return;
        if (this.blobs.has(idx)) return;
        const aborter = new AbortController();
        this.blobAborters.set(idx, aborter);
        // Chain on the latest queued prefetch < idx (if any) so we don't
        // fire parallel requests at the server.
        let prev = Promise.resolve();
        let latest = -1;
        for (const i of this.blobs.keys()) if (i < idx && i > latest) latest = i;
        if (latest >= 0) prev = this.blobs.get(latest).catch(() => {});
        const promise = prev.then(() => {
          if (aborter.signal.aborted) throw makeAbortError();
          return this.synthesize(this.chunks[idx], { signal: aborter.signal });
        });
        // Attach a silent rejection handler so an aborted prefetch (which
        // happens whenever the user hits skip-prev/next) doesn't surface as
        // an "Uncaught (in promise)" warning when no consumer is awaiting it.
        // The original promise is still what we store and await elsewhere —
        // attaching .catch here just marks it as handled at the engine level.
        promise.catch(() => { /* noop — real consumers still see the rejection */ });
        this.blobs.set(idx, promise);
      };

      // Expose so jumpToChunk() can re-seed prefetches from outside the speak loop.
      this._startPrefetch = startPrefetch;

      const abortPrefetchesAhead = (fromIdx) => {
        for (const [idx, ab] of this.blobAborters) {
          if (idx >= fromIdx) {
            try { ab.abort(); } catch (_) { /* noop */ }
            this.blobAborters.delete(idx);
            this.blobs.delete(idx);
          }
        }
      };
      this._abortPrefetchesAhead = abortPrefetchesAhead;

      // Seed: queue the first chunk plus `depth` ahead from the start index.
      for (let i = 0; i <= depth; i++) startPrefetch(startIdx + i);

      while (this.currentChunkIdx < this.chunks.length && !this.aborted) {
        this.setStatus(opts.play ? 'fetching' : 'generating');

        // Ensure current is queued (e.g. after skip-prev to a deeper position).
        startPrefetch(this.currentChunkIdx);
        const blob = await this.blobs.get(this.currentChunkIdx);
        if (this.aborted) break;
        if (blobsByIdx) blobsByIdx.set(this.currentChunkIdx, blob);

        // Queue more prefetches up to depth chunks ahead.
        for (let i = 1; i <= depth; i++) {
          startPrefetch(this.currentChunkIdx + i);
        }

        if (opts.play) {
          this.setStatus('playing');
          if (this.toolbar) this.toolbar.setTickerText(this.chunks[this.currentChunkIdx]);
          await this.playBlob(blob);
        }
        if (this.aborted) break;

        if (this.pendingSkip === -1) {
          // Going back — invalidate everything ahead of new current so the
          // server is freed for the refetch.
          this.currentChunkIdx = Math.max(0, this.currentChunkIdx - 1);
          abortPrefetchesAhead(this.currentChunkIdx + 1);
        } else {
          this.currentChunkIdx += 1;
        }
        this.pendingSkip = 0;

        // Persist resume position so re-opening the same note picks up
        // where we left off. Skip when generating-only (no playback) or
        // when this is an ad-hoc selection read (no currentFile).
        if (opts.play && this.currentFile && this.settings.autoResume) {
          this.saveResumePosition(this.currentFile.path, this.currentChunkIdx);
        }

        // Drop blobs that are far behind to free memory (keep one back for
        // safety against re-entry).
        if (!opts.save) {
          for (const idx of Array.from(this.blobs.keys())) {
            if (idx < this.currentChunkIdx - 1) {
              this.blobs.delete(idx);
              this.blobAborters.delete(idx);
            }
          }
        }

        // Inter-chunk silent gap — gives the listener a beat between
        // paragraphs. Cancellable so Stop doesn't have to wait.
        if (
          opts.play &&
          this.currentChunkIdx < this.chunks.length &&
          this.settings.paragraphPauseMs > 0
        ) {
          try {
            await sleepCancelable(
              this.settings.paragraphPauseMs,
              this.sessionAborter && this.sessionAborter.signal,
            );
          } catch (_) { /* aborted — loop will exit on next check */ }
        }
      }

      // Save is only meaningful when we have a source note to anchor the
      // filename to. Selection / read-from-cursor reads have currentFile=null
      // and must skip this even if settings.saveAudio is on.
      if (!this.aborted && opts.save && this.currentFile && blobsByIdx && blobsByIdx.size) {
        this.setStatus('saving');
        const sorted = [];
        for (let i = 0; i < this.chunks.length; i++) {
          if (blobsByIdx.has(i)) sorted.push(blobsByIdx.get(i));
        }
        if (sorted.length) await this.saveAudioForNote(this.currentFile, sorted);
      }

      // Clean completion → forget the resume position so next open starts at the top.
      if (!this.aborted && opts.play && this.currentFile) {
        this.clearResumePosition(this.currentFile.path);
      }

      this.audio = null; // important: otherwise next play-pause click would resume the last (ended) chunk
      this.currentChunkIdx = 0;
      this.totalChunks = 0;
      this.sessionAborter = null;
      this.lastSessionEnd = Date.now();
      this.setStatus('idle');
      if (this.toolbar) this.toolbar.syncPlayButtonState();
      // Auto-advance to the next queued note on a clean completion.
      if (!this.aborted && opts.play) {
        this.playNextInQueue();
      }
    } catch (e) {
      if (isAbortError(e)) {
        // Expected when user pressed stop or started a new session.
        this.audio = null;
        this.sessionAborter = null;
        this.lastSessionEnd = Date.now();
        this.setStatus('idle');
        if (this.toolbar) this.toolbar.syncPlayButtonState();
        return;
      }
      // Some failure modes (Audio element torn down mid-play, generic
      // promise rejections during teardown) surface with no payload. Treat
      // those as silent — surfacing "undefined" to the user is noise, not
      // signal.
      if (e === undefined || e === null) {
        this.sessionAborter = null;
        this.lastSessionEnd = Date.now();
        this.setStatus('idle');
        if (this.toolbar) this.toolbar.syncPlayButtonState();
        return;
      }
      console.error('[Audiobook TTS] speak error', e);
      const msg = e && (e.message || (typeof e === 'string' ? e : '')) || 'unknown error';
      if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch failed/i.test(msg)) {
        new obsidian.Notice('Audiobook TTS: local server unavailable. Continuing in text mode.', 6000);
      } else {
        new obsidian.Notice(`Audiobook TTS error: ${msg}`, 6000);
      }
      this.sessionAborter = null;
      this.lastSessionEnd = Date.now();
      this.setStatus('error');
      if (this.toolbar) this.toolbar.syncPlayButtonState();
    }
  }

  async saveAudioForNote(file, blobs) {
    try {
      const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
      const combined = concatWavBuffers(buffers);

      const baseName = file.basename + '.wav';
      let folder = (this.settings.audioFolder || '').trim().replace(/^\/|\/$/g, '');
      if (!folder) {
        folder = file.parent && file.parent.path && file.parent.path !== '/'
          ? file.parent.path
          : '';
      }
      const path = folder ? `${folder}/${baseName}` : baseName;

      // Ensure folder exists
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        try { await this.app.vault.createFolder(folder); } catch (_) { /* race ok */ }
      }

      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) {
        await this.app.vault.modifyBinary(existing, combined.buffer);
      } else {
        await this.app.vault.createBinary(path, combined.buffer);
      }
      new obsidian.Notice(`Audiobook TTS: saved ${path}`, 5000);
    } catch (e) {
      console.error('[Audiobook TTS] save error', e);
      new obsidian.Notice(`Audiobook TTS: save failed — ${e.message}`, 6000);
    }
  }

  togglePause() {
    if (!this.audio) return;
    // The audio.onpause / onplay listeners attached in playBlob() already
    // call syncPlayButtonState — no need to sync again here.
    if (this.audio.paused) this.audio.play();
    else this.audio.pause();
  }

  stop() {
    const wasActive = this.aborted === false || this.sessionAborter || this.audio;
    this.aborted = true;
    this._startPrefetch = null;
    this._abortPrefetchesAhead = null;
    if (this.sessionAborter) {
      try { this.sessionAborter.abort(); } catch (_) { /* noop */ }
      this.sessionAborter = null;
    }
    // Abort every queued prefetch
    for (const ab of this.blobAborters.values()) {
      try { ab.abort(); } catch (_) { /* noop */ }
    }
    this.blobAborters.clear();
    this.blobs.clear();
    if (this.audio) {
      try { this.audio.pause(); } catch (_) { /* noop */ }
      // Detach handlers so the soon-to-be-GC'd Audio doesn't fire onerror
      // after we've already moved on.
      try { this.audio.onpause = null; this.audio.onplay = null; this.audio.onended = null; this.audio.onerror = null; } catch (_) {}
      this.audio = null;
    }
    // Revoke any object URL still attached to the aborted chunk so it can
    // be GC'd. Without this, every stop-during-playback leaks a blob URL.
    if (this._currentAudioUrl) {
      try { URL.revokeObjectURL(this._currentAudioUrl); } catch (_) {}
      this._currentAudioUrl = null;
    }
    if (this.playResolve) {
      const r = this.playResolve;
      this.playResolve = null;
      try { r(); } catch (_) { /* noop */ }
    }
    // Cancel any pending queue auto-advance — without this, stopping mid-
    // queue-handoff still fires playQueueHead 200ms later.
    if (this._queueAdvanceTimer) {
      window.clearTimeout(this._queueAdvanceTimer);
      this._queueAdvanceTimer = null;
    }
    // Drop large per-session state so memory can be reclaimed.
    this.chunks = [];
    this.playedDurations = [];
    this.fullText = null;
    this.currentChunkIdx = 0;
    this.totalChunks = 0;
    if (wasActive) {
      this.lastSessionEnd = Date.now();
      // Capture how long the just-ended session ran so the next awaitCooldown
      // can scale itself — a 10s session needs more headroom than a 1s one.
      this._lastSessionDuration = this._sessionStartedAt
        ? this.lastSessionEnd - this._sessionStartedAt : 0;
    }
    this._sessionStartedAt = 0;
    this.setStatus('idle');
    if (this.toolbar) {
      this.toolbar.syncPlayButtonState();
      this.toolbar.setTickerText('');
    }
  }

  skipNext() {
    if (!this.audio) return;
    this.pendingSkip = +1;
    try { this.audio.pause(); } catch (_) { /* noop */ }
    if (this.playResolve) {
      const r = this.playResolve;
      this.playResolve = null;
      r();
    }
  }

  skipPrev() {
    if (!this.audio) return;
    this.pendingSkip = -1;
    try { this.audio.pause(); } catch (_) { /* noop */ }
    if (this.playResolve) {
      const r = this.playResolve;
      this.playResolve = null;
      r();
    }
  }

  // Direct jump to an arbitrary chunk index. Only valid while a speak() loop
  // is running — the prefetch helpers are session-local closures attached
  // by speak() to `this`. Aborts everything past the new position, re-seeds
  // prefetches from there, and interrupts the current chunk playback so the
  // speak loop picks up immediately.
  jumpToChunk(idx) {
    if (!this._startPrefetch || !this._abortPrefetchesAhead) return;
    if (!Number.isFinite(idx) || idx < 0 || idx >= this.chunks.length) return;
    this.pendingSkip = 0;
    this.currentChunkIdx = idx;
    this._abortPrefetchesAhead(0);
    this.blobs.clear();
    this.blobAborters.clear();
    const depth = this._prefetchDepth || 2;
    for (let i = 0; i <= depth; i++) this._startPrefetch(idx + i);
    if (this.audio) {
      try { this.audio.pause(); } catch (_) { /* noop */ }
    }
    if (this.playResolve) {
      const r = this.playResolve;
      this.playResolve = null;
      r();
    }
  }

  openChunkJumpModal() {
    if (!this.chunks || !this.chunks.length) {
      new obsidian.Notice('Audiobook TTS: nothing is playing.', 2500);
      return;
    }
    new ChunkJumpModal(this.app, this).open();
  }

  // ---- OpenVox HTTP client ----

  // Cache key = `${apiUrl}|${model}`. Once a model has been loaded against
  // a given server, subsequent /load calls are skipped — the server keeps
  // the model in memory, so a second warm-up just produces 429 spam while
  // it's busy synthesizing. Invalidated when API URL or model id changes.
  isModelLoaded(model) {
    return this._loadedKey === `${this.settings.apiUrl}|${model}`;
  }

  invalidateLoadedModel() {
    this._loadedKey = null;
  }

  async loadModel(model) {
    if (this.isModelLoaded(model)) return; // already warm — skip the POST entirely
    const signal = this.sessionAborter ? this.sessionAborter.signal : undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (signal && signal.aborted) return;
      try {
        const r = await fetch(
          `${this.settings.apiUrl}/models/${encodeURIComponent(model)}/load`,
          { method: 'POST', signal },
        );
        if (r.status === 429) {
          await sleepCancelable(Math.min(8000, 600 * Math.pow(1.5, attempt)), signal);
          continue;
        }
        // Treat any non-429 response (200 OK, but also 4xx/5xx) as "we've
        // done our best to warm this model on this server" so we don't keep
        // hammering /load on every playback.
        this._loadedKey = `${this.settings.apiUrl}|${model}`;
        return;
      } catch (e) {
        if (e && (e.name === 'AbortError' || e.message === 'aborted')) return;
        // best-effort warm-up; speak() surfaces real errors
        return;
      }
    }
  }

  async fetchModels() {
    const r = await fetch(`${this.settings.apiUrl}/models`);
    if (!r.ok) throw new Error(`GET /models -> ${r.status}`);
    const j = await r.json();
    return (j.data || j.models || []).map((m) => m.id || m.name || m);
  }

  async fetchLanguages(model) {
    const r = await fetch(`${this.settings.apiUrl}/models/${encodeURIComponent(model)}/languages`);
    if (!r.ok) throw new Error(`GET /languages -> ${r.status}`);
    const j = await r.json();
    return (j.data || j.languages || []).map((l) => ({
      id: l.id || l.code || l,
      name: l.name || l.id || l,
    }));
  }

  async fetchVoices(model, language) {
    const r = await fetch(
      `${this.settings.apiUrl}/models/${encodeURIComponent(model)}/voices?language=${encodeURIComponent(language)}`
    );
    if (!r.ok) throw new Error(`GET /voices -> ${r.status}`);
    const j = await r.json();
    return (j.data || j.voices || []).map((v) => ({
      id: v.id || v.name,
      name: v.name || v.id,
      gender: v.gender,
      tags: v.tags,
    }));
  }

  // Synthesize text → WAV blob. Pass { signal } to support per-request abort
  // (used by skip-prev to cancel the prefetch). sessionAborter aborts everything.
  async synthesize(text, opts = {}) {
    const sessionSignal = this.sessionAborter ? this.sessionAborter.signal : undefined;
    const localSignal = opts.signal;
    const combined = combineSignals(sessionSignal, localSignal);

    // Disk cache lookup first — if the same (model, language, voice, text)
    // has been synthesized before, the WAV is already on disk. Saves a full
    // round-trip to the TTS server when re-reading a note.
    if (this.settings.cacheAudio) {
      const cached = await this.readCache(text).catch(() => null);
      if (cached) return cached;
    }

    const body = {
      model: this.settings.model,
      input: text,
      language: this.settings.language,
      voice: this.settings.voice,
      response_format: 'wav',
    };

    const MAX_ATTEMPTS = 20;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (combined.aborted) throw makeAbortError();
      let r;
      try {
        r = await fetch(`${this.settings.apiUrl}/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (e) {
        if (isAbortError(e)) throw e;
        throw e;
      }

      if (r.status === 429) {
        // Exponential backoff: 1200ms → 2160 → 3888 → 6998 → cap 8000.
        // Wider initial gap = fewer redundant POSTs reaching the server
        // while it's still locked on the previous synthesis, which means
        // fewer 429s show up in the devtools network panel.
        const wait = Math.min(8000, 1200 * Math.pow(1.8, attempt));
        await sleepCancelable(wait, combined);
        continue;
      }

      if ((r.status === 404 || r.status === 400) && this.settings.voice && attempt === 0) {
        const errText = await r.text().catch(() => '');
        if (/voice/i.test(errText)) {
          try {
            const voices = await this.fetchVoices(this.settings.model, this.settings.language);
            if (voices.length) {
              const replacement = voices[0].id;
              new obsidian.Notice(`Audiobook TTS: voice "${this.settings.voice}" not available, switched to "${replacement}".`, 5000);
              this.settings.voice = replacement;
              await this.saveSettings();
              body.voice = replacement;
              continue;
            }
          } catch (_) { /* fall through */ }
        }
        throw new Error(`HTTP ${r.status}: ${errText}`);
      }

      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${errText.slice(0, 200)}`);
      }

      const blob = await r.blob();
      if (this.settings.cacheAudio) {
        // Detached write — playback proceeds immediately, cache writes in the background.
        this.writeCache(text, blob).catch(() => { /* best-effort */ });
      }
      return blob;
    }
    throw new Error('429 retry exhausted (local TTS server is overloaded)');
  }

  // ---- Audio cache (disk) ----

  async cacheKey(text) {
    const payload = JSON.stringify({
      m: this.settings.model,
      l: this.settings.language,
      v: this.settings.voice,
      t: text,
    });
    const enc = new TextEncoder().encode(payload);
    const buf = await crypto.subtle.digest('SHA-1', enc);
    const arr = new Uint8Array(buf);
    let hex = '';
    for (const b of arr) hex += b.toString(16).padStart(2, '0');
    return hex;
  }

  cachePath(hash) {
    const folder = (this.settings.cacheFolder || '.audiobook-tts-cache').replace(/^\/|\/$/g, '');
    return `${folder}/${hash}.wav`;
  }

  async readCache(text) {
    const adapter = this.app.vault.adapter;
    const path = this.cachePath(await this.cacheKey(text));
    if (!(await adapter.exists(path))) return null;
    const buf = await adapter.readBinary(path);
    return new Blob([buf], { type: 'audio/wav' });
  }

  async writeCache(text, blob) {
    const adapter = this.app.vault.adapter;
    const folder = (this.settings.cacheFolder || '.audiobook-tts-cache').replace(/^\/|\/$/g, '');
    if (!(await adapter.exists(folder))) {
      await adapter.mkdir(folder);
    }
    const path = this.cachePath(await this.cacheKey(text));
    const buf = await blob.arrayBuffer();
    await adapter.writeBinary(path, buf);
  }

  async clearAudioCache() {
    const adapter = this.app.vault.adapter;
    const folder = (this.settings.cacheFolder || '.audiobook-tts-cache').replace(/^\/|\/$/g, '');
    if (!(await adapter.exists(folder))) return 0;
    const listing = await adapter.list(folder);
    let removed = 0;
    for (const f of listing.files || []) {
      try { await adapter.remove(f); removed++; } catch (_) { /* noop */ }
    }
    return removed;
  }

  async playBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = this.settings.playbackRate || 1.0;
      this.audio = audio;
      // Stash the object URL on the plugin so stop() can revoke it when the
      // user interrupts playback before onended / onerror fire — otherwise
      // every aborted chunk leaks a blob URL into the browser cache.
      this._currentAudioUrl = url;
      this.playResolve = resolve;
      const syncBtn = () => {
        if (this.toolbar) this.toolbar.syncPlayButtonState();
      };
      // Keep the play/pause icon in sync with actual audio state — covers
      // browser-initiated pauses (e.g. system media keys) too.
      audio.onpause = syncBtn;
      audio.onplay = syncBtn;
      syncBtn();
      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (this._currentAudioUrl === url) this._currentAudioUrl = null;
      };
      audio.onended = () => {
        // Accumulate the actual played duration for the time display so
        // estimated total converges to ground truth as the user listens.
        const d = Number(audio.duration);
        if (Number.isFinite(d) && d > 0) {
          if (!this.playedDurations) this.playedDurations = [];
          this.playedDurations.push(d);
        }
        cleanup();
        if (this.playResolve) { const r = this.playResolve; this.playResolve = null; r(); }
      };
      audio.onerror = () => {
        cleanup();
        this.playResolve = null;
        reject(new Error('audio playback error'));
      };
      audio.play().catch((e) => { cleanup(); this.playResolve = null; reject(e); });
    });
  }
}

// ---------- Playback toolbar ----------
class PlaybackToolbar {
  constructor(plugin) {
    this.plugin = plugin;

    this.el = document.createElement('div');
    this.el.className = 'audiobook-tts-toolbar is-hidden';

    // Transport: prev / play-pause / stop / next
    this.el.appendChild(this.makeIconBtn('skip-back', 'Previous paragraph', 'prev'));
    this.playBtn = this.makeIconBtn('play', 'Play', 'play-pause');
    this.el.appendChild(this.playBtn);
    this.el.appendChild(this.makeIconBtn('square', 'Stop', 'stop'));
    this.el.appendChild(this.makeIconBtn('skip-forward', 'Next paragraph', 'next'));

    // Progress — clickable to open the chunk-jump modal.
    this.progressEl = document.createElement('span');
    this.progressEl.className = 'audiobook-tts-progress';
    this.progressEl.dataset.action = 'jump';
    this.progressEl.title = 'Jump to chunk…';
    this.progressEl.textContent = '—';
    this.el.appendChild(this.progressEl);

    // Time display (mm:ss / mm:ss) — feature B, populated by updateTimeDisplay.
    this.timeEl = document.createElement('span');
    this.timeEl.className = 'audiobook-tts-time';
    this.timeEl.textContent = '';
    this.el.appendChild(this.timeEl);

    this.el.appendChild(this.makeSep());

    // Playback-speed cycler — click to advance through preset rates,
    // right-click to reset to 1.0x. Text updates live.
    this.speedBtn = document.createElement('button');
    this.speedBtn.type = 'button';
    this.speedBtn.className = 'audiobook-tts-speed';
    this.speedBtn.dataset.action = 'speed';
    this.speedBtn.title = 'Click: cycle speed · Right-click: reset to 1.0x';
    this.el.appendChild(this.speedBtn);
    this.syncSpeedLabel();

    // Chunk-text ticker toggle (feature F).
    this.tickerBtn = this.makeIconBtn('eye', 'Show / hide current chunk text', 'toggle-ticker');
    this.el.appendChild(this.tickerBtn);

    // Close
    this.el.appendChild(this.makeIconBtn('x', 'Close', 'close'));

    // Ticker text — sits on its own row below the controls when visible.
    this.tickerEl = document.createElement('div');
    this.tickerEl.className = 'audiobook-tts-ticker is-hidden';
    this.tickerEl.textContent = '';
    this.el.appendChild(this.tickerEl);
    if (this.plugin.settings.showChunkTicker) this.tickerEl.classList.remove('is-hidden');

    document.body.appendChild(this.el);
    this.makeDraggable();
    this.bindEvents();
    this.syncFromSettings();
  }

  makeIconBtn(icon, title, action) {
    const btn = document.createElement('button');
    btn.className = 'audiobook-tts-icon-btn';
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.dataset.action = action;
    try { obsidian.setIcon(btn, icon); } catch (_) { btn.textContent = title; }
    return btn;
  }

  makeSep() {
    const s = document.createElement('span');
    s.className = 'audiobook-tts-sep';
    return s;
  }

  isVisible() { return !this.el.classList.contains('is-hidden'); }
  show() { this.el.classList.remove('is-hidden'); }
  hide() { this.el.classList.add('is-hidden'); }

  destroy() {
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  bindEvents() {
    this.el.addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'play-pause') {
        // Three states:
        //   - audio playing/paused → toggle pause
        //   - session in progress but no audio yet (loading) → notice + no-op
        //   - idle → start a new playback
        if (this.plugin.audio) {
          this.plugin.togglePause();
        } else if (this.plugin.isBusy()) {
          new obsidian.Notice('Audiobook TTS: already preparing — press Stop to cancel.', 2500);
        } else {
          // Explicit catch — readActiveNote is async but we fire-and-forget
          // here, and an unhandled rejection (even a silent undefined one
          // during a stop-then-replay race) prints as "Uncaught (in promise)"
          // in the devtools console for no actionable reason.
          this.plugin.readActiveNote().catch(() => { /* silenced */ });
        }
      } else if (action === 'stop') {
        this.plugin.stop();
      } else if (action === 'prev') {
        this.plugin.skipPrev();
      } else if (action === 'next') {
        this.plugin.skipNext();
      } else if (action === 'close') {
        this.hide();
        this.plugin.settings.toolbarVisible = false;
        this.plugin.saveData(this.plugin.settings);
      } else if (action === 'jump') {
        this.plugin.openChunkJumpModal();
      } else if (action === 'speed') {
        this.cyclePlaybackSpeed();
      } else if (action === 'toggle-ticker') {
        this.toggleTicker();
      }
    });

    // Right-click on the speed button resets to 1.0x.
    this.plugin.registerDomEvent(this.speedBtn, 'contextmenu', (e) => {
      e.preventDefault();
      this.setPlaybackSpeed(1.0);
    });
  }

  cyclePlaybackSpeed() {
    const presets = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    const cur = this.plugin.settings.playbackRate || 1.0;
    // Find the next preset strictly greater than the current value; wrap.
    let next = presets.find((p) => p > cur + 0.001);
    if (next == null) next = presets[0];
    this.setPlaybackSpeed(next);
  }

  setPlaybackSpeed(rate) {
    this.plugin.settings.playbackRate = rate;
    this.plugin.saveData(this.plugin.settings).catch(() => {});
    if (this.plugin.audio) this.plugin.audio.playbackRate = rate;
    this.syncSpeedLabel();
  }

  syncSpeedLabel() {
    if (!this.speedBtn) return;
    const rate = this.plugin.settings.playbackRate || 1.0;
    this.speedBtn.textContent = `${rate.toFixed(2).replace(/\.?0+$/, '')}x`;
  }

  toggleTicker() {
    const next = !this.plugin.settings.showChunkTicker;
    this.plugin.settings.showChunkTicker = next;
    this.plugin.saveData(this.plugin.settings).catch(() => {});
    this.tickerEl.classList.toggle('is-hidden', !next);
    if (next) this.setTickerText(this.plugin.chunks?.[this.plugin.currentChunkIdx]);
  }

  setTickerText(text) {
    if (!this.tickerEl) return;
    if (this.tickerEl.classList.contains('is-hidden')) return;
    this.tickerEl.textContent = (text || '').replace(/\s+/g, ' ').trim() || '—';
  }

  syncFromSettings() {
    // Settings page may have changed playbackRate / showChunkTicker — refresh.
    this.syncSpeedLabel();
    if (this.tickerEl) {
      this.tickerEl.classList.toggle('is-hidden', !this.plugin.settings.showChunkTicker);
    }
  }

  // Pick the right icon based on plugin state:
  //   - busy + no audio  → loader (spinning)
  //   - audio playing    → pause
  //   - audio paused     → play
  //   - idle             → play
  syncPlayButtonState() {
    if (!this.playBtn) return;
    const p = this.plugin;
    let icon, title, loading = false;
    if (p.isBusy() && !p.audio) {
      icon = 'loader-2';
      title = 'Preparing…';
      loading = true;
    } else if (p.audio && !p.audio.paused) {
      icon = 'pause';
      title = 'Pause';
    } else {
      icon = 'play';
      title = 'Play';
    }
    try { obsidian.setIcon(this.playBtn, icon); }
    catch (_) { this.playBtn.textContent = title; }
    this.playBtn.title = title;
    this.playBtn.setAttribute('aria-label', title);
    if (loading) this.playBtn.setAttribute('data-loading', 'true');
    else this.playBtn.removeAttribute('data-loading');
  }

  // Backward-compat wrapper (older callsites).
  syncPlayButton(_paused) { this.syncPlayButtonState(); }

  setProgress(cur, total, label) {
    if (!this.progressEl) return;
    if (!total) {
      this.progressEl.textContent = label && label !== 'idle' ? label : '—';
    } else {
      this.progressEl.textContent = `${cur + 1}/${total} · ${label || ''}`.trim();
    }
  }

  // Refresh `mm:ss / mm:ss`. Elapsed = sum of completed-chunk durations plus
  // current audio.currentTime; total = elapsed + estimateSeconds of every
  // chunk that hasn't been played yet. Estimate converges to the true total
  // as the listener gets deeper into the note.
  updateTimeDisplay() {
    if (!this.timeEl) return;
    const p = this.plugin;
    if (!p.chunks || !p.chunks.length || !p.audio) {
      this.timeEl.textContent = '';
      return;
    }
    const played = (p.playedDurations || []).reduce((a, b) => a + b, 0);
    const cur = Number(p.audio.currentTime) || 0;
    const elapsed = played + cur;
    let remaining = 0;
    for (let i = p.currentChunkIdx + 1; i < p.chunks.length; i++) {
      remaining += estimateSeconds(p.chunks[i], p.settings.playbackRate);
    }
    // Include the current chunk's remaining audio if duration is known.
    const curDur = Number(p.audio.duration);
    if (Number.isFinite(curDur) && curDur > 0) {
      remaining += Math.max(0, curDur - cur);
    } else if (p.chunks[p.currentChunkIdx]) {
      remaining += Math.max(0, estimateSeconds(p.chunks[p.currentChunkIdx], p.settings.playbackRate) - cur);
    }
    const total = elapsed + remaining;
    this.timeEl.textContent = `${formatTime(elapsed)} / ${formatTime(total)}`;
  }

  makeDraggable() {
    const el = this.el;
    let dragging = false;
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;
    this.plugin.registerDomEvent(el, 'mousedown', (e) => {
      if (e.target.closest('button,input,select,label')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const r = el.getBoundingClientRect();
      origLeft = r.left; origTop = r.top;
      el.classList.add('is-dragging');
      e.preventDefault();
    });
    this.plugin.registerDomEvent(document, 'mousemove', (e) => {
      if (!dragging) return;
      el.classList.add('is-dragged');
      el.style.left = (origLeft + e.clientX - startX) + 'px';
      el.style.top = (origTop + e.clientY - startY) + 'px';
    });
    this.plugin.registerDomEvent(document, 'mouseup', () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('is-dragging');
    });
  }
}

// ---------- Selection play button ----------
// A small floating button that appears next to the user's text selection
// inside a markdown editor. Clicking it sends the selection to TTS without
// requiring the user to remember a hotkey or open the command palette.
class SelectionPlayButton {
  constructor(plugin) {
    this.plugin = plugin;
    this.el = document.createElement('button');
    this.el.className = 'audiobook-tts-selection-play is-hidden';
    this.el.type = 'button';
    const label = 'Read selection aloud';
    this.el.title = label;
    this.el.setAttribute('aria-label', label);
    try { obsidian.setIcon(this.el, 'play'); } catch (_) { this.el.textContent = '▶'; }
    document.body.appendChild(this.el);

    // preventDefault on mousedown keeps the selection alive when the button
    // is clicked — otherwise focus would move to the button and the
    // selection would collapse before we could read it.
    this.plugin.registerDomEvent(this.el, 'mousedown', (e) => e.preventDefault());
    this.plugin.registerDomEvent(this.el, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.playSelection();
    });

    // Debounce selectionchange — Chromium fires it on every drag pixel.
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        this.update();
      });
    };
    this.plugin.registerDomEvent(document, 'selectionchange', schedule);
    // Hide on scroll — the cached position would be stale.
    this.plugin.registerDomEvent(document, 'scroll', () => this.hide(), { capture: true });
  }

  update() {
    if (!this.plugin.settings.selectionPlayButton) { this.hide(); return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { this.hide(); return; }
    const text = sel.toString();
    if (!text || !text.trim()) { this.hide(); return; }

    const range = sel.getRangeAt(0);
    const view = this.plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view || !view.containerEl.contains(range.commonAncestorContainer)) {
      this.hide();
      return;
    }

    // Position at the end of the selection. getClientRects() returns one rect
    // per visual line; use the last one so multi-line selections anchor at
    // the bottom-right corner.
    const rects = range.getClientRects();
    const last = (rects && rects.length) ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!last || (!last.width && !last.height)) { this.hide(); return; }

    this.el.style.left = `${Math.round(last.right + 4)}px`;
    this.el.style.top = `${Math.round(last.top - 2)}px`;
    this.el.classList.remove('is-hidden');
  }

  hide() { this.el.classList.add('is-hidden'); }

  playSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text.trim()) return;
    this.hide();
    this.plugin.speakSelection(text);
  }

  destroy() {
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// ---------- Chunk jump modal ----------
// FuzzySuggestModal listing every chunk of the currently-playing note. Each
// item shows `idx. preview` so the user can recognize where they want to go.
class ChunkJumpModal extends obsidian.FuzzySuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder('Jump to chunk…');
  }
  getItems() {
    return this.plugin.chunks.map((text, idx) => ({ idx, text }));
  }
  getItemText(item) {
    const preview = (item.text || '').replace(/\s+/g, ' ').slice(0, 80);
    const marker = item.idx === this.plugin.currentChunkIdx ? '▶' : ' ';
    return `${marker} ${String(item.idx + 1).padStart(3, ' ')}. ${preview}`;
  }
  onChooseItem(item) {
    this.plugin.jumpToChunk(item.idx);
  }
}

// ---------- Markdown sanitizer ----------
function cleanMarkdown(raw, opts) {
  let s = raw;

  // YAML frontmatter
  s = s.replace(/^---\n[\s\S]*?\n---\n?/, '');

  // HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // Raw HTML tags (keep inner text)
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // Fenced code blocks — covers mermaid/diagrams too
  if (opts.skipCode) {
    s = s.replace(/```[\s\S]*?```/g, '\n');
    s = s.replace(/~~~[\s\S]*?~~~/g, '\n');
  }

  // Tables (apply order option)
  s = transformTables(
    s,
    opts.readTables !== false,
    opts.tableOrder || 'row',
  );

  // Image embeds and links
  s = s.replace(/!\[\[[^\]]+\]\]/g, '');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

  // Wikilinks
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');

  // Markdown links [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Bare URLs — strip so they don't get spelled out character-by-character.
  // Done AFTER markdown-link processing so [text](url) keeps its text.
  s = s.replace(/https?:\/\/\S+/gi, '');
  s = s.replace(/\bwww\.\S+/gi, '');

  // Inline code
  if (opts.skipCode) {
    s = s.replace(/`[^`\n]+`/g, '');
  }

  // Parentheses content removal (after link/image patterns, before formatting)
  if (opts.readParens === false) {
    // ASCII () — non-greedy, single-line
    s = s.replace(/\([^()\n]*\)/g, '');
    // Korean full-width （）
    s = s.replace(/（[^（）\n]*）/g, '');
  }

  // Emphasis / strikethrough markers
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/~~(.*?)~~/g, '$1');

  // Headings — strip leading #s AND wrap with blank lines so the chunker
  // makes each heading its own paragraph. The trailing period gives the TTS
  // engine an intonation drop; combined with the inter-chunk paragraph
  // pause, this sounds like a natural section transition.
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)[.!?。…]?\s*$/gm, '\n\n$1.\n\n');

  // Blockquote/callout markers
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*\[![^\]]+\][+-]?\s*/gm, '');

  // List markers
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');

  // Footnotes
  s = s.replace(/\[\^[^\]]+\]/g, '');

  // Horizontal rules
  s = s.replace(/^\s*([-*_])\s*\1\s*\1[\s\1]*$/gm, '');

  // Collapse whitespace
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

function transformTables(text, readTables, order) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);
    const next = lines[i + 1] || '';
    const isSeparator = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(next);

    if (isTableRow && isSeparator) {
      const headerCells = parseRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        bodyRows.push(parseRow(lines[i]));
        i++;
      }
      if (readTables) {
        out.push(...renderTable(headerCells, bodyRows, order));
        out.push('');
      }
      continue;
    }

    out.push(line);
    i++;
  }
  return out.join('\n');
}

// Render a markdown table into TTS-friendly sentences.
//   row mode (default): first column is the subject, remaining columns are
//     comma-joined predicates. e.g. "CPU: 연산, 두뇌."
//   col mode: each column read as one sentence with its header as the label.
//     e.g. "부품: CPU, 메모리, 보조기억장치."
// Both modes drop empty cells. Single-column tables just read each cell.
function renderTable(headers, rows, order) {
  const lines = [];
  if (order === 'col') {
    for (let c = 0; c < headers.length; c++) {
      const h = (headers[c] || '').trim();
      const values = rows.map((r) => (r[c] || '').trim()).filter(Boolean);
      if (!values.length) continue;
      lines.push(h ? `${h}: ${values.join(', ')}.` : `${values.join(', ')}.`);
    }
  } else {
    for (const row of rows) {
      const cells = row.map((c) => (c || '').trim()).filter(Boolean);
      if (!cells.length) continue;
      if (cells.length === 1) {
        lines.push(cells[0] + '.');
      } else {
        const [subject, ...rest] = cells;
        lines.push(`${subject}: ${rest.join(', ')}.`);
      }
    }
  }
  return lines;
}

function parseRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function chunkText(text, maxLen) {
  const sentences = text.split(/(?<=[\.!?。…])\s+|\n{2,}/);
  const chunks = [];
  let buf = '';
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > maxLen) {
      if (buf) { chunks.push(buf); buf = ''; }
      // Sentence longer than maxLen — split at the nearest word boundary
      // before maxLen instead of slicing mid-word, which mangles Korean
      // and produces unnatural mid-syllable cuts in the audio.
      let i = 0;
      while (i < s.length) {
        const remaining = s.length - i;
        if (remaining <= maxLen) { chunks.push(s.slice(i)); break; }
        const window = s.slice(i, i + maxLen);
        // Prefer punctuation, then whitespace, then fall through to a hard
        // cut. Korean clauses are often separated by `,` or `;` so those
        // win over plain spaces.
        let cut = Math.max(
          window.lastIndexOf(', '),
          window.lastIndexOf('; '),
          window.lastIndexOf(': '),
          window.lastIndexOf(' '),
          window.lastIndexOf('\t'),
        );
        if (cut < maxLen * 0.5) cut = maxLen; // fallback: avoid pathologically short slices
        else cut = cut + 1;
        chunks.push(s.slice(i, i + cut).trim());
        i += cut;
      }
      continue;
    }
    if ((buf + ' ' + s).trim().length > maxLen && buf) {
      chunks.push(buf);
      buf = s;
    } else {
      buf = buf ? buf + ' ' + s : s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Rough wall-clock estimate for spoken playback. Calibrated against
// Korean OmniVoice voices (~350 chars/min at 1.0x); English is closer to
// 900 chars/min, so we bias by counting non-ASCII as one Korean syllable
// (~one beat) and ASCII as ~third of a beat — same constant works for both.
function estimateSeconds(text, rate) {
  if (!text) return 0;
  const r = Number(rate) > 0 ? Number(rate) : 1.0;
  let beats = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) beats += 0.33; else beats += 1;
  }
  const charsPerSecond = 350 / 60; // ~5.8 Korean syllable-beats per second
  return beats / (charsPerSecond * r);
}
function estimateMinutes(text, rate) {
  const m = estimateSeconds(text, rate) / 60;
  return m < 1 ? Math.max(1, Math.round(m)) : Math.round(m);
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.message === 'aborted');
}
function makeAbortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
function combineSignals(a, b) {
  const ctrl = new AbortController();
  const onAbort = () => { try { ctrl.abort(); } catch (_) { /* noop */ } };
  if (a) { if (a.aborted) onAbort(); else a.addEventListener('abort', onAbort); }
  if (b) { if (b.aborted) onAbort(); else b.addEventListener('abort', onAbort); }
  return ctrl.signal;
}
function sleepCancelable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(makeAbortError());
    const id = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(id);
      reject(makeAbortError());
    });
  });
}

// ---------- WAV concatenation ----------
// Assumes all input WAV buffers share identical format (sample rate, channels,
// bit depth). OpenVox returns 16-bit 24kHz mono PCM consistently per voice.
function concatWavBuffers(buffers) {
  if (!buffers.length) throw new Error('no buffers');
  if (buffers.length === 1) return new Uint8Array(buffers[0]);

  const fourcc = (view, off) =>
    String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));

  function findChunk(buf, id) {
    const view = new DataView(buf);
    // RIFF header: 'RIFF' (4) + size (4) + 'WAVE' (4); subchunks start at 12
    let off = 12;
    while (off + 8 <= view.byteLength) {
      const cid = fourcc(view, off);
      const size = view.getUint32(off + 4, true);
      if (cid === id) return { offset: off + 8, size };
      off += 8 + size + (size % 2);
    }
    return null;
  }

  const v0 = new DataView(buffers[0]);
  if (fourcc(v0, 0) !== 'RIFF' || fourcc(v0, 8) !== 'WAVE') {
    throw new Error('not a WAV');
  }
  const fmt0 = findChunk(buffers[0], 'fmt ');
  if (!fmt0) throw new Error('no fmt chunk');
  const fmtBytes = new Uint8Array(buffers[0], fmt0.offset, fmt0.size);

  const datas = buffers.map((buf) => {
    const d = findChunk(buf, 'data');
    if (!d) throw new Error('no data chunk');
    return new Uint8Array(buf, d.offset, d.size);
  });

  const totalData = datas.reduce((a, d) => a + d.byteLength, 0);
  const fmtChunkLen = 8 + fmtBytes.byteLength + (fmtBytes.byteLength % 2);
  const dataChunkLen = 8 + totalData + (totalData % 2);
  const totalLen = 12 + fmtChunkLen + dataChunkLen;

  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  let p = 0;

  // RIFF + size + WAVE
  out.set([0x52, 0x49, 0x46, 0x46], p); p += 4;
  dv.setUint32(p, totalLen - 8, true); p += 4;
  out.set([0x57, 0x41, 0x56, 0x45], p); p += 4;

  // fmt chunk
  out.set([0x66, 0x6d, 0x74, 0x20], p); p += 4;
  dv.setUint32(p, fmtBytes.byteLength, true); p += 4;
  out.set(fmtBytes, p); p += fmtBytes.byteLength;
  if (fmtBytes.byteLength % 2) p += 1;

  // data chunk
  out.set([0x64, 0x61, 0x74, 0x61], p); p += 4;
  dv.setUint32(p, totalData, true); p += 4;
  for (const d of datas) { out.set(d, p); p += d.byteLength; }

  return out;
}

// ---------- Settings UI ----------
class AudiobookTTSSettingsTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Audiobook TTS' });
    containerEl.createEl('p', {
      text: 'Reads markdown notes aloud via a local OpenAI-compatible TTS server (e.g. the OpenVox app, or local-tts-server). Make sure the server is running before playback.',
      cls: 'setting-item-description',
    });

    new obsidian.Setting(containerEl)
      .setName('API URL')
      .setDesc('Base URL of your local TTS server. Must follow the OpenAI/OpenVox /v1 contract.')
      .addText((t) =>
        t.setPlaceholder('http://127.0.0.1:8000/v1')
          .setValue(this.plugin.settings.apiUrl)
          .onChange(async (v) => {
            this.plugin.settings.apiUrl = v.trim();
            this.plugin.invalidateLoadedModel();
            await this.plugin.saveSettings();
          })
      )
      .addButton((b) =>
        b.setButtonText('Test connection').onClick(async () => {
          try {
            const models = await this.plugin.fetchModels();
            new obsidian.Notice(
              `Audiobook TTS: connected — ${models.length} model(s) available.`,
              4000,
            );
          } catch (e) {
            new obsidian.Notice(`Audiobook TTS: connection failed — ${e.message}`, 6000);
          }
        })
      );

    // Build Model / Language / Voice with a shared pattern:
    //   text input (free entry) + dropdown (fetched values) + Fetch button.
    // Selecting from the dropdown fills the text input. Typing freely is always
    // allowed — the text input is the source of truth that gets saved.
    const buildPickerSetting = ({ name, settingKey, fetcher, formatOption }) => {
      let textComp;
      let dropdownComp;

      const setting = new obsidian.Setting(containerEl).setName(name);

      setting.addDropdown((d) => {
        dropdownComp = d;
        const cur = this.plugin.settings[settingKey];
        if (cur) d.addOption(cur, cur);
        d.setValue(cur || '');
        d.onChange(async (v) => {
          if (!v) return;
          if (textComp) textComp.setValue(v);
          if (settingKey === 'model' && this.plugin.settings.model !== v) {
            this.plugin.invalidateLoadedModel();
          }
          this.plugin.settings[settingKey] = v;
          await this.plugin.saveSettings();
        });
      });

      setting.addText((t) => {
        textComp = t;
        t.setValue(this.plugin.settings[settingKey] || '');
        t.onChange(async (v) => {
          const trimmed = v.trim();
          if (settingKey === 'model' && this.plugin.settings.model !== trimmed) {
            this.plugin.invalidateLoadedModel();
          }
          this.plugin.settings[settingKey] = trimmed;
          await this.plugin.saveSettings();
          // Keep dropdown selection consistent if the typed value matches an option.
          if (dropdownComp && dropdownComp.selectEl) {
            const has = Array.from(dropdownComp.selectEl.options).some((o) => o.value === trimmed);
            if (has) dropdownComp.setValue(trimmed);
          }
        });
      });

      setting.addButton((b) =>
        b.setButtonText('Fetch').onClick(async () => {
          try {
            const items = await fetcher();
            const options = items.map(formatOption); // [{ value, label }]
            const cur = this.plugin.settings[settingKey];
            const sel = dropdownComp.selectEl;
            while (sel.firstChild) sel.removeChild(sel.firstChild);
            // Preserve current value at the top if it isn't in the fetched list.
            if (cur && !options.find((o) => o.value === cur)) {
              const opt = document.createElement('option');
              opt.value = cur;
              opt.textContent = `${cur} (current)`;
              sel.appendChild(opt);
            }
            for (const o of options) {
              const opt = document.createElement('option');
              opt.value = o.value;
              opt.textContent = o.label;
              sel.appendChild(opt);
            }
            if (cur) dropdownComp.setValue(cur);
            new obsidian.Notice(`Audiobook TTS: fetched ${options.length} ${name.toLowerCase()}(s).`, 3000);
          } catch (e) {
            new obsidian.Notice('Failed: ' + e.message, 6000);
          }
        })
      );

      return setting;
    };

    buildPickerSetting({
      name: 'Model',
      settingKey: 'model',
      fetcher: () => this.plugin.fetchModels(),
      formatOption: (m) => ({ value: m, label: m }),
    });

    buildPickerSetting({
      name: 'Language',
      settingKey: 'language',
      fetcher: () => this.plugin.fetchLanguages(this.plugin.settings.model),
      formatOption: (l) => ({ value: l.id, label: l.name && l.name !== l.id ? `${l.id} — ${l.name}` : l.id }),
    });

    buildPickerSetting({
      name: 'Voice',
      settingKey: 'voice',
      fetcher: () => this.plugin.fetchVoices(this.plugin.settings.model, this.plugin.settings.language),
      formatOption: (v) => ({ value: v.id, label: v.gender ? `${v.id} (${v.gender})` : v.id }),
    });

    new obsidian.Setting(containerEl)
      .setName('Prefetch depth')
      .setDesc('How many chunks ahead to pre-synthesize while one plays. Higher = smoother under slow servers, more memory. Default 2.')
      .addSlider((s) =>
        s.setLimits(1, 5, 1).setDynamicTooltip()
          .setValue(this.plugin.settings.prefetchDepth)
          .onChange(async (v) => {
            this.plugin.settings.prefetchDepth = v;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Chunk size (characters)')
      .setDesc('Smaller = faster first audio, more server requests. Default 200. Going below ~200 increases the chance of mid-sentence cuts for long Korean prose.')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.chunkSize)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.chunkSize = Number.isFinite(n) && n > 50 ? n : 200;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Playback speed')
      .setDesc('Audio playback rate multiplier. 1.0 = normal speed. Takes effect on the next chunk.')
      .addSlider((s) =>
        s.setLimits(0.5, 2.0, 0.1).setDynamicTooltip()
          .setValue(this.plugin.settings.playbackRate)
          .onChange(async (v) => { this.plugin.settings.playbackRate = v; await this.plugin.saveSettings(); })
      );

    containerEl.createEl('h3', { text: 'Content filters' });

    new obsidian.Setting(containerEl)
      .setName('Skip code blocks')
      .setDesc('Skip fenced code blocks and inline `code`.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.skipCode).onChange(async (v) => {
          this.plugin.settings.skipCode = v; await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Read tables')
      .setDesc('Convert markdown tables into readable sentences. Off = skip tables.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readTables).onChange(async (v) => {
          this.plugin.settings.readTables = v; await this.plugin.saveSettings();
        })
      );

    // Visual example for the table read order setting — the verbal description
    // alone is hard to picture, so render a real table next to both outputs.
    const tableExample = containerEl.createDiv({ cls: 'audiobook-tts-table-example' });
    tableExample.createEl('div', {
      text: 'Table read order — example',
      cls: 'audiobook-tts-example-title',
    });
    const exampleTable = tableExample.createEl('table', { cls: 'audiobook-tts-example-table' });
    const thead = exampleTable.createEl('thead').createEl('tr');
    ['Part', 'Role', 'Price'].forEach((h) => thead.createEl('th', { text: h }));
    const tbody = exampleTable.createEl('tbody');
    [['CPU', 'compute', 'high'], ['RAM', 'storage', 'mid']].forEach((row) => {
      const tr = tbody.createEl('tr');
      row.forEach((c) => tr.createEl('td', { text: c }));
    });
    const outputs = tableExample.createEl('div', { cls: 'audiobook-tts-example-outputs' });
    const rowOut = outputs.createEl('div');
    rowOut.createEl('strong', { text: 'Row: ' });
    rowOut.createEl('span', { text: '“CPU: compute, high. RAM: storage, mid.”' });
    const colOut = outputs.createEl('div');
    colOut.createEl('strong', { text: 'Column: ' });
    colOut.createEl('span', { text: '“Part: CPU, RAM. Role: compute, storage. Price: high, mid.”' });

    new obsidian.Setting(containerEl)
      .setName('Table read order')
      .setDesc('Row reads each row as a subject + its other cells. Column reads each column with its header as the label. See the example above.')
      .addDropdown((d) =>
        d.addOption('row', 'Row (subject-based)').addOption('col', 'Column (categorical)')
          .setValue(this.plugin.settings.tableOrder)
          .onChange(async (v) => { this.plugin.settings.tableOrder = v; await this.plugin.saveSettings(); })
      );

    new obsidian.Setting(containerEl)
      .setName('Read parentheses')
      .setDesc('Off = strip "(...)" and "（...）" before reading (useful for skipping inline definitions).')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readParens).onChange(async (v) => {
          this.plugin.settings.readParens = v; await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: 'Audio file output' });

    new obsidian.Setting(containerEl)
      .setName('Save audio file after playback')
      .setDesc('Combines all chunks into a single WAV next to the source note (or in the folder below).')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.saveAudio).onChange(async (v) => {
          this.plugin.settings.saveAudio = v;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Audio folder (vault-relative)')
      .setDesc('Where to save the rendered WAV file. Leave empty to save next to the source note. Otherwise vault-relative, e.g. "audiobooks".')
      .addText((t) =>
        t.setPlaceholder('(empty: same folder as note)')
          .setValue(this.plugin.settings.audioFolder)
          .onChange(async (v) => {
            this.plugin.settings.audioFolder = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Show playback toolbar')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.toolbarVisible).onChange(async (v) => {
          this.plugin.settings.toolbarVisible = v;
          await this.plugin.saveSettings();
          if (this.plugin.toolbar) (v ? this.plugin.toolbar.show() : this.plugin.toolbar.hide());
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Show floating play button on selection')
      .setDesc('When text is selected in a markdown editor, a small play button appears next to the selection. Click it to read just the selection aloud.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.selectionPlayButton).onChange(async (v) => {
          this.plugin.settings.selectionPlayButton = v;
          await this.plugin.saveSettings();
          if (!v && this.plugin.selectionButton) this.plugin.selectionButton.hide();
        })
      );

    containerEl.createEl('h3', { text: 'Playback behavior' });

    new obsidian.Setting(containerEl)
      .setName('Remember last position per note')
      .setDesc('Resume each note from where you stopped last time. Clears automatically when you finish reading the note to the end.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoResume).onChange(async (v) => {
          this.plugin.settings.autoResume = v;
          await this.plugin.saveSettings();
        })
      )
      .addButton((b) =>
        b.setButtonText('Clear all').onClick(async () => {
          this.plugin.settings.resumePositions = {};
          await this.plugin.saveSettings();
          new obsidian.Notice('Audiobook TTS: cleared all saved positions.', 3000);
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Paragraph pause (ms)')
      .setDesc('Silent gap inserted between chunks for a natural breathing pace. 0 = continuous playback.')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.paragraphPauseMs)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.paragraphPauseMs = Number.isFinite(n) && n >= 0 ? Math.min(5000, n) : 250;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Preload model on Obsidian startup')
      .setDesc('Sends a warm-up request to the TTS server when Obsidian opens so the first playback starts instantly. Off by default — only enable if you use TTS frequently in this vault.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.preloadOnStartup).onChange(async (v) => {
          this.plugin.settings.preloadOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: 'Audio cache' });

    new obsidian.Setting(containerEl)
      .setName('Cache synthesized audio to disk')
      .setDesc('Stores each synthesized chunk under the cache folder so re-reading the same note skips the server entirely. Cache key includes model + language + voice + text.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.cacheAudio).onChange(async (v) => {
          this.plugin.settings.cacheAudio = v;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Cache folder (vault-relative)')
      .setDesc('Where cached WAV files live. Default is hidden by the leading dot.')
      .addText((t) =>
        t.setPlaceholder('.audiobook-tts-cache')
          .setValue(this.plugin.settings.cacheFolder)
          .onChange(async (v) => {
            this.plugin.settings.cacheFolder = v.trim() || '.audiobook-tts-cache';
            await this.plugin.saveSettings();
          })
      )
      .addButton((b) =>
        b.setButtonText('Clear cache').onClick(async () => {
          try {
            const n = await this.plugin.clearAudioCache();
            new obsidian.Notice(`Audiobook TTS: removed ${n} cached file(s).`, 3000);
          } catch (e) {
            new obsidian.Notice(`Audiobook TTS: cache clear failed — ${e.message}`, 5000);
          }
        })
      );
  }
}

module.exports = AudiobookTTSPlugin;
module.exports._internal = { cleanMarkdown, chunkText, transformTables, renderTable, concatWavBuffers };
