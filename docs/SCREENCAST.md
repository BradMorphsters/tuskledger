# Screencast recording plan (60 seconds, README hero)

The single most leveraged demo asset right now: a 60-second clip of
the Ask panel doing real work. Embeds in the README hero (replacing or
sitting alongside the current SVG mockup) and in the marketing site's
hero or the AI Insights / Ask section.

This document is the recording script. Open it on your phone or a
second monitor while you record on the laptop, and follow the beat
clock. The whole session — record, trim, encode, embed — should take
about an hour the first time, less on retries.

---

## What to record

The story in one sentence: *"Click the Ask button, type a question
about your money, watch a local LLM stream the answer."*

Why this story: it's the single feature that puts Tusk Ledger in a
different category from Mint / Empower / Quicken / Actual / Firefly.
None of them do this. The 60-second clip needs to make that obvious in
the first 8 seconds.

---

## Pre-flight checklist

Before you hit record:

- [ ] Run on demo data, not real data. `cd ~/Documents/Claude/Projects/Personal\ finance\ tracking/tuskledger && ./start.sh`, then click the Demo Mode toggle. Real net-worth figures should not appear in a public clip.
- [ ] Verify Ollama is running: `ollama list` should show `llama3.1:8b`. If not: `ollama pull llama3.1:8b && ollama serve &`.
- [ ] Verify `LLM_ENABLED=true` in `backend/.env`. Restart the backend if you flipped it.
- [ ] Hit the Ask button once before recording so the first-call latency (model warm-up) doesn't show up in the clip.
- [ ] Maximize the browser window. Hide the bookmarks bar (`Cmd+Shift+B`). Close other tabs so the tab strip is clean. Zoom level 100%.
- [ ] System Notifications off (Do Not Disturb). Mute Slack / Mail / Messages. Plug in power so the battery indicator doesn't draw the eye.
- [ ] Browser at the Dashboard, scrolled to top. AI Insights tile visible.

---

## The 60-second script

Beats below assume CleanShot X or QuickTime Player on macOS. Total run
time targets 55–60s; aim for the bottom of the range, an extra second
of buffer never hurts.

| t      | Beat                                                       | Caption (overlay)                                  |
|--------|------------------------------------------------------------|----------------------------------------------------|
| 0–3s   | Dashboard, no movement. Holds while the eye lands.         | **Tusk Ledger — local-first personal finance**     |
| 3–6s   | Cursor moves to the bottom-right Ask pill (no click yet).  | **Local LLM. No cloud. No API bills.**             |
| 6–9s   | Click Ask pill. Slide-in panel opens with curated prompts. | (nothing — let the UI breathe)                     |
| 9–13s  | Click "What's my savings rate this quarter?"               | **Curated prompts. No prompt-engineering.**        |
| 13–22s | Streaming begins. Tokens appear left-to-right.             | **Numbers from Python. Prose from local Ollama.**  |
| 22–28s | Streaming finishes. Answer is on screen.                   | **No hallucinations: every $ pre-computed.**       |
| 28–35s | Pan / scroll subtly to show the bundle preview if visible. | **Same JSON returned to you for inspection.**      |
| 35–43s | Click a different prompt — "Top merchants this month".     | (nothing)                                          |
| 43–53s | Streaming begins, finishes.                                | **Nine curated prompts. Nothing leaves the box.**  |
| 53–60s | Hold on the answer. Cursor moves away.                     | **github.com/BradMorphsters/tuskledger**           |

The captions are the entire payload. Most viewers watch muted; the
captions carry the meaning.

---

## Recording tools (macOS)

In order of how I'd reach for them:

1. **CleanShot X** — best for screencast-with-captions. Built-in cursor
   highlighting, easy region select, exports to MP4 or GIF in one
   click. Paid (one-time) but worth it if you'll do this more than once.
2. **QuickTime Player** — free, ships with macOS. File → New Screen
   Recording → record region → trim in QuickTime → export. No
   captions; you'd add them in iMovie or Descript afterward.
3. **OBS** — overkill for a 60-second clip. Skip unless you already
   have a configured profile.

For captions and trimming, **Descript** is the easiest path — drop in
the MP4, type captions on the timeline, export. The free tier covers
this size of clip.

---

## Encoding targets

Two formats; pick one based on where it embeds:

| Use                 | Format | Target size | Resolution        | Frame rate |
|---------------------|--------|-------------|-------------------|------------|
| README hero (GIF)   | GIF    | < 8 MB      | 1280×720, 12 fps  | low        |
| Marketing site (MP4)| MP4    | < 5 MB      | 1920×1080, 30 fps | high       |

GIFs are the safe default for GitHub READMEs (auto-play, no
controls, no autoplay-restriction issues). MP4 is much smaller for the
same visual quality but needs `<video autoplay muted loop>` markup, and
GitHub's README markdown does not render `<video>` — it only embeds
GIFs. So: **GIF for the README, MP4 for the marketing site.**

For the GIF: use [Gifski](https://gif.ski/) or `ffmpeg`:

```
ffmpeg -i screencast.mp4 -vf "fps=12,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 docs/screencast.gif
```

If the result is over 8 MB, drop fps to 10 or scale to 1024.

For the MP4: standard `ffmpeg` h.264:

```
ffmpeg -i screencast.mp4 -vcodec libx264 -crf 26 -preset slow -an docs/screencast.mp4
```

`-an` strips audio (we're not recording any), saves a few hundred KB.

---

## README embed wiring

When the GIF is ready and committed at `docs/screencast.gif`, swap the
hero block in `README.md`:

```markdown
<p align="center">
  <img src="docs/screencast.gif"
       alt="Tusk Ledger Ask panel — local-LLM-streamed answer to a question about savings rate"
       width="100%" />
</p>
```

The current SVG hero (`docs/hero.svg`) becomes a fallback or moves
further down the README. Don't delete it — the SVG renders cleanly
when GitHub disables image proxying for any reason.

---

## Marketing-site embed wiring

When the MP4 is ready, drop it at `tuskledger-site/public/screencast.mp4`
and add a `<video>` block to the Hero in `App.jsx` near the existing
`<MockDashboard />` component:

```jsx
<video
  src="/screencast.mp4"
  autoPlay
  muted
  loop
  playsInline
  preload="metadata"
  style={{ width: '100%', borderRadius: 12, marginTop: 32 }}
  aria-label="Tusk Ledger Ask panel demo"
/>
```

`autoPlay muted loop playsInline` is the magic combination that
satisfies modern browser autoplay restrictions. `preload="metadata"`
loads just enough to size the player without pulling the whole file
upfront.

---

## What NOT to record

Don't include:

- Any real account number, balance, or merchant from your real
  household data. Demo mode only.
- Any browser extension toolbar (1Password, AdBlock, etc.) — distracts
  from the app. Either incognito window or temporarily disable.
- Any system notification banner. Do Not Disturb is your friend.
- The dock or menu bar if avoidable. Region-record the browser window
  instead of the whole screen.
- Cursor flailing. Plan the path before pressing record. If you
  fumble, stop and re-record from scratch — easier than splicing.

---

## After it's recorded

1. Commit `docs/screencast.gif` (and optionally `docs/screencast.mp4`)
   to the main repo.
2. Edit README.md hero block per the embed wiring above.
3. Edit `tuskledger-site/src/App.jsx` Hero per the marketing-site
   embed wiring.
4. Push both repos.
5. Optional: post the MP4 directly to Bluesky / X / LinkedIn with a
   short caption — same payload as the captions in the clip itself.

---

## Why GIF in the README and not just an embedded YouTube

Two reasons. First, GitHub strips `<iframe>` so a YouTube embed in
README.md doesn't render — it'd be a plain link, which has zero
preview affordance. A GIF auto-plays inline so the visitor sees the
demo before they decide whether to click anything. Second, GIFs cache
permanently in GitHub's image proxy; YouTube depends on a third party
that could pull the video, change the URL, or wrap it in ads. A
self-hosted GIF in the repo is invariant.
