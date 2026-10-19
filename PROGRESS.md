# Mee JARVIS — ความคืบหน้า

อัปเดตล่าสุด: 2026-10-16 · Claude Code 2.1.301 · Node 24.13.0 · Electron 44.8.0

> โปรเจกต์อยู่ที่ `C:\Users\Acer\mee-jarvis` (ไม่ได้สร้างตรง `C:\Users\Acer` เพราะเป็น home folder ที่มี package.json อื่นอยู่แล้ว)

## สถานะ

| ระยะ | สถานะ | ตรวจแล้ว |
|---|---|---|
| 0 ตรวจสอบก่อนเขียนโค้ด | ✅ | ทดลองกับ CLI จริง (ดูด้านล่าง) |
| 1 ระบบหลัก + streaming + พูดตอบ | ✅ | `npm run check`, `npm test` (34 ผ่าน), `scripts/integration-real.js` กับ CLI จริง, เปิดแอปจริง + screenshot |
| 2 รับเสียงภาษาไทย | ✅ | whisper.cpp b5454 + ggml-small ติดตั้งแล้ว, ถอดเสียงทดสอบ 5.9 วิ ใช้ 4.0 วิ, ไฟล์เสียงชั่วคราวถูกลบ |
| 3 กล้อง + โหมดสอนประดิษฐ์ | ✅ (เท่าที่ต้นฉบับระบุ) | MediaPipe face+hand โหลดในแอปจริง 471 ms (GPU), พบกล้อง 2 ตัว |
| 4–7 | ⏸ **ยังไม่ได้รับรายละเอียด** | ข้อความต้นฉบับถูกตัดกลางระยะที่ 3 — วางส่วนที่เหลือของระยะที่ 3 และระยะ 4–7 เพื่อทำต่อ |

## ขั้นที่ 0 — ผลตรวจจริง

- `claude.exe` (native) ที่ `C:\Users\Acer\.local\bin\claude.exe` → spawn ตรงได้ (`resolveClaudeCommand` รองรับ `.cmd` ด้วยการรัน `cli.js` ผ่าน node จาก PATH)
- flags ที่มีจริง: `-p`, `--input-format/--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--append-system-prompt`, `--resume`, `--permission-mode`, `--mcp-config`, `--setting-sources`, `--add-dir`, `--model`, `--allowedTools`, `--disallowedTools`, `--settings`
- `--permission-prompt-tool` **ไม่อยู่ใน --help แต่ใช้ได้จริง** (ทดสอบแล้ว) — help มี `--permission-prompts host` ที่อ้างถึงมัน
- `--permission-mode` ใน help มี `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` — ค่า `default` ยังรับได้ (init รายงาน `default`)
- รูปแบบ permission tool (ยืนยันจากการทดลอง):
  - input: `{ tool_name, input, tool_use_id }`
  - output (text JSON): `{"behavior":"allow","updatedInput":{...}}` หรือ `{"behavior":"deny","message":"..."}`
  - คำสั่งอ่านอย่างเดียว (เช่น `echo`) CLI อนุญาตเองโดยไม่เรียก tool
  - การปฏิเสธปรากฏใน `result.permission_denials`
- process ค้างไว้ + ส่งหลายรอบทาง stdin ใช้ได้, image content block (base64) ใช้ได้, slash command (`/cost`) ส่งทาง stdin ได้
- ผู้ใช้: ไม่มี MCP/hooks ของตัวเอง, มี plugin hyperframes (skills), superpowers SessionStart hook, allow rules ใน settings.local.json

## การตัดสินใจ / จุดที่ต่างจากต้นฉบับ (พร้อมเหตุผล)

1. **TTS ภาษาไทย**: เครื่องนี้ไม่มีเสียง th-TH และ Chromium `speechSynthesis` เห็นเฉพาะเสียง SAPI → เพิ่ม provider `winrt` (Windows OneCore ผ่าน PowerShell worker ค้างไว้ ~100 ms/ประโยค) ซึ่งเข้าถึงเสียง "Microsoft Pattara" ได้เมื่อติดตั้งแล้ว; ปุ่มติดตั้งจะรัน `Add-WindowsCapability Language.TextToSpeech~~~th-TH` (ต้องกด UAC) — **ติดตั้งแล้ว (2026-10-18): Pattara ลงทะเบียนใน Speech_OneCore และ WinRtTts สังเคราะห์เสียงไทยได้จริง**
2. **คีย์ลัด Ctrl+Space**: Electron `globalShortcut` ไม่มี event ปล่อยปุ่ม → กดครั้งแรกเริ่มฟัง, VAD หยุดเองเมื่อเงียบ, กดซ้ำเพื่อหยุดทันที (กดค้างแบบแท้ต้องใช้ native hook เช่น uiohook — ยังไม่ทำ)
3. **โหมดสอนประดิษฐ์**: CLI บันทึก system prompt ต่อ conversation (`--system-prompt-snapshot on`) การ restart ด้วย `--append-system-prompt` ใหม่จึงไม่มีผลกับ session ที่ resume → ส่งคำสั่งโหมดเป็นข้อความกำกับพร้อมข้อความถัดไปแทน (มีผลทันที ไม่เสีย context)
4. **ตัวกันพลาดแบบ "ถามบนจอ"** (อัปโหลดลงบอร์ด/admin): hook เชื่อมต่อ pipe ของแอปเองแล้วรอผู้ใช้คลิก → ทำงานได้ทุกโหมดรวม bypassPermissions (ทดสอบกับ CLI จริงแล้ว) hook ติดตั้งผ่าน `--settings` จึงไม่แก้ไฟล์ settings ของผู้ใช้
5. **Pre-warm**: เปิด CLI ล่วงหน้าเมื่อเลือกโฟลเดอร์/เริ่ม session/สลับโหมด → t2−t0 รอบแรกลดจาก **5.5 วิ → 1.8 วิ** (วัดจริงด้วย haiku)
6. **Azure**: ใช้ REST short-audio (ไม่ใช่ WebSocket streaming) เพราะไม่ต้องพึ่ง SDK; key เก็บด้วย `safeStorage`
7. **MediaPipe**: รันใน main thread ของ renderer จำกัด ~15 fps (ต้นฉบับอนุญาต) ไฟล์ wasm จาก node_modules, โมเดลดาวน์โหลดครั้งเดียวไป userData และส่งเป็น `modelAssetBuffer`
8. **โปรโตคอลหน้าเว็บ**: เสิร์ฟผ่าน `app://jarvis/` (secure, จำกัดเฉพาะ `renderer/` และ `@mediapipe/tasks-vision/`) แทน `file://` เพื่อให้ fetch wasm/getUserMedia ทำงานใต้ CSP
9. **Electron binary**: postinstall ของ electron ไม่ทำงาน/ค้าง → ดาวน์โหลดด้วย curl, ตรวจ SHA-256 ตรงกับ checksums.json แล้วแตกไฟล์เอง; เพิ่ม `postinstall` ใน package.json

## Latency (วัดจริง)

- t2−t0 รอบแรก (cold, เปิด CLI ใหม่): 5.5–11 วิ → ส่วนใหญ่คือ startup ของ CLI (plugins + MCP 16 ตัว)
- หลัง pre-warm: 1.8 วิ, รอบถัดไป 1.9 วิ
- t1−t0 (เขียน stdin): ~20 ms
- STT whisper small (CPU): ~0.67× เวลาเสียง
- ส่วนที่ช้าที่สุดตอนนี้: เวลาโมเดลถึง token แรก และ STT; ลดไปแล้ว: startup CLI (pre-warm), IPC ต่อตัวอักษร (รวมเป็นก้อนต่อ chunk)

## วิธีตรวจ

```
npm run check                          # node --check ทุกไฟล์
npm test                               # unit + integration กับ fake CLI
node scripts/integration-real.js       # end-to-end กับ Claude Code จริง (ใช้โควตาเล็กน้อย, model haiku)
node scripts/integration-real.js bom   # เฉพาะขั้น: write | deny | bom | upload | bypass | latency
jarvis [โฟลเดอร์]                      # เปิดแอป (ลงทะเบียนด้วย npm link แล้ว)
```

Dev: `JARVIS_SCREENSHOT=<file.png>` (+ `JARVIS_SCREENSHOT_QUIT=1`, `JARVIS_SCREENSHOT_DELAY`, `JARVIS_SCREENSHOT_SCRIPT`) จับภาพหน้าจอและ console log

## งานค้าง / สิ่งที่ผู้ใช้ต้องทำ

- [ ] กด "ติดตั้งเสียงภาษาไทย" ในแอป (UAC) แล้วทดสอบเสียงพูดจริง
- [ ] ทดสอบพูดภาษาไทยจริงผ่านไมค์ + กล้องสดหน้าจอ
- [ ] วางรายละเอียดระยะที่ 3 (ส่วนที่ถูกตัด) และระยะ 4–7
- [ ] (ทางเลือก) กดค้างแบบแท้สำหรับ push-to-talk ต้องใช้ native keyboard hook

## UI redesign — HUD/FUI (2026-10-16)

หน้า Home เป็นเครื่องมือเต็มจอชิ้นเดียวตามภาพอ้างอิง: grid เทคนิค + Energy Core + การ์ด 7 ใบ + leader lines + framing marks + ปุ่ม hamburger
ส่วนอื่นอยู่หลังเมนู: TALK · MAKER · ACTIVITY · DIAGNOSTICS · SETTINGS (เต็มจอทีละหน้า, Esc = กลับ, เลข 1–5 ในเมนู)

ไฟล์ใหม่: `renderer/ui/{layout,grid,core,cards,home,sections}.js`, `renderer/ui/fonts.css` + `fonts/` (Rajdhani, Share Tech Mono, IBM Plex Sans Thai — OFL, โหลดในเครื่อง)
ลบ: `renderer/hud.js` · `renderer.js` ในสเปก = `renderer/app.js` ของโปรเจกต์นี้

### การแก้ main/preload (เฉพาะที่อนุญาต)
- BrowserWindow: `frame:false`, `backgroundColor:'#020A0C'`, `fullscreen:true`; F11 สลับเต็มจอ (before-input-event); Esc ไม่ปิดแอป
- IPC ใหม่ 1 คู่: `window:control` (invoke: toggle-fullscreen | minimize | close | query — ตรวจค่าใน main) และ event `window:state`

### ข้อมูลจริงเท่านั้น
- MIC dBFS จาก RMS จริง + FFT จาก AnalyserNode · TTS % จาก envelope เสียงที่เล่นจริง (WinRT); speechSynthesis ไม่มีสัญญาณ → แสดง "—"
- LATENCY: t3−t0 (เสียงแรก) 8 รอบล่าสุด; รอบที่ไม่มีเสียงใช้ t2−t0 เป็นแท่งจางพร้อมคำอธิบาย · ไม่นับเวลารออนุญาต
- STEP จากบล็อก jarvis-steps ล่าสุด · TOKENS รวมทั้ง session · ELAPSED เวลาในสถานะปัจจุบัน
- ลบค่าระดับเสียงสุ่ม (fake) ใน tts.js ทิ้ง

### จุดที่ตัดสินใจเอง / ต่างจากสเปก
- สเปกถูกตัดที่หัวข้อ "## Interact" → ออกแบบการโต้ตอบเอง: คลิกแกนกลาง = เริ่ม/หยุดฟัง, คลิกการ์ด = เปิดหน้าที่เกี่ยวข้อง
- ขนาด core และตำแหน่งการ์ดยึดตามภาพอ้างอิง (core ≈ 54% ของความสูง, MIC/TTS/LAST REPLY แนวบนใกล้กัน) แทน 70% / ห้ามขอบบนตรงกันในสเปกข้อความ
- Bloom ใช้ Canvas 2D (blurred copies, additive) แทน WebGL — ผลใกล้เคียง เบากว่า
- ยังไม่ทำ parallax ตามตำแหน่งศีรษะจากกล้อง (สเปกระบุว่าเป็นทางเลือก)
- แถบแดง bypassPermissions และป้าย "กล้องเปิดอยู่" ยังแสดงทับ Home เพราะเป็นข้อกำหนดความปลอดภัยเดิม
- พบว่า `node --check` ของ Node 24 ไม่จับ syntax error ในไฟล์ ESM → `scripts/check-all.js` ตรวจไฟล์ ESM เป็น .mjs แทน
- Dev: `node scripts/ui-shot.js <out.png> [delayMs] [pageScript] [cwd]` จับภาพหน้าจอแอป

## UI restyle #2 — electric cyan (2026-10-16)
- Palette: cyan #00E5FF / #3FF5FF, orange #FF8A1F, navy-black bg #01060D (also BrowserWindow backgroundColor), fainter grid, diagonal light beam from top-right
- Panels: 2px glowing chamfered borders, dark gradient fill + inner glow, values ~2.7× title size with small units, bright/dim segmented bars
- MIC value + meter orange whenever there is a real reading · LATENCY 13-bar chart (13 latest turns) + "n / 8 TURNS" · ELAPSED thick glowing ring
- Core: 40 larger blocks lit as a level from ~200° clockwise (bright left/top → dim right), thick orange inner arcs, dashed orange arcs (top / bottom-left / bottom-right), extra tick rings, faint crosshair, glowing filled nodes, diamond emblem with W cutout, cyan glowing status, third line removed
- Removed "TAB พิมพ์คำสั่ง" from the footer (Tab still opens the prompt)
- Every value is still real data; the reference image's sample numbers are not hard-coded

## Protractor ticks (2026-10-16)
- `renderer/ui/ticks.js`: SVG tick layers generated in loops — outer 1°/5°/15°/45° ticks (4/8/13/22px), labels past cardinal ticks, inward ticks every 6° (10px at 30°), 16 seeded accent dashes (3 orange) with flicker + 72s drift, axis lines at 0/90/180/270, faint crosshair with ticks every 20px
- Ticks within ±20° of an active bright arc +30%, others fade (core exposes `activeArcs`)
- Edge rulers (top/left/right): minor every 10px, major every 50px with A/B/C labels; canvas versions of ticks/labels/crosshair removed from core.js

## Boot sequence (2026-10-17)
- `renderer/ui/boot.js`: one GSAP timeline (≈4.8 s) — CRT power-on, grid radial reveal, corner brackets + flicker, rulers tick-by-tick with scrambled labels, reactor assembly (rings cw/ccw, tick wave from 0°, label flicker, block sweep with overshoot, orange arcs, emblem 0.6→1.08→1 + flash + shockwave, rotate −15°→0), status decode INITIALIZING… → CALIBRATING SENSORS… → SYSTEMS ONLINE, boot log, node blink + connector lines + pulses + sparks, panels deploy in order (border trace, scaleY, glitch, scanline, icon pop, title scramble, tag, segment fill, count-up, chart bars, waveform, ring), Ready glow pulse + menu dot blinks twice
- Skip on click/any key → final state + 0.2 s fade · reduced motion → 0.4 s fade · Settings › การแสดงผล: play every launch / first launch only, synthetic boot sounds (off by default)
- Emits `app:ready`; panels take no input until their own animation ends
- GSAP 3.15.0 bundled locally (renderer/ui/vendor, standard no-charge license); canvas parts driven by tweened parameter objects (core.beginBoot / grid.drawRulers)

## CAMERA panel (2026-10-17)
- `renderer/ui/camera-panel.js` + `renderer/ui/camera.css`: home panel B5 at x360–672 (below STEP, connector from the 225° node), states OFF / REQUESTING / ON / ERROR (+RETRY), 120×40 chamfered toggle with hover scanline + press flash, Ctrl+Shift+C, aria-pressed/aria-label, cyan focus ring
- ON: panel grows 144→288px (power3.out) to a 16:9 mirrored live preview in a HUD frame (brackets, 10% screen tint, scanlines, crosshair, LIVE ● timer, real track resolution); open = border draw + flicker + sweep, close = CRT collapse; ⟳ switches camera when >1; ⤢ enlarges to a 960×540 window over the reactor (Esc returns)
- Reactor: 225° node stays lit, pulse along the connector, "● CAM" in the core; tracks stopped on OFF; never auto-starts
- `window.jarvisCamera` = { state, error, captureFrame() → Blob, onChange(fn) }; vision.js gained CAM_BUSY (NotReadableError), trackInfo(), captureFrame()
- Boot deploys CAMERA after STEP (always OFF); footer moved 24px lower
- Notes: preview label says LIVE (nothing is recorded); the camera video moved from the core centre into this panel

## Card frames · docking · camera mode (2026-10-17)
- Card border (`drawFrame` in `ui/cards.js`, also used by the camera viewer): one SVG overlay per card — 1px base outline at 25% (40% on hover) + 2.5px glowing L-brackets on the top-left / bottom-right corners only, following the chamfer; arms = min(34px, 12% of the side), extend 30% on hover via stroke-dashoffset. Old hot segment and top-right / bottom-left marks removed
- × on every card (left of the ID tag, 32px hit, orange glow + 90° turn on hover, `aria-label="ปิดการ์ด …"`) docks the card: glitch → collapse to a line at the connector anchor → dot travels along the connector (which retracts) → node turns orange-centre/cyan-ring with a hover label, segmented ring ripples. Reopen = the same timeline reversed. Click the docked node, Alt+1…8, or the "N DOCKED" tray under the status text
- `ui/docking.js`: one paused GSAP timeline per card (forward = dock, reverse = reopen, so rapid toggles just flip it). Closed cards persist in localStorage `jarvis.dockedCards`; boot deploys only open cards. Closing a card only hides UI
- Camera mode (`ui/camera-panel.js` rewritten): camera ON → one ≈1 s timeline: open cards auto-dock (farthest first, 0.05 s stagger), an 80vw × 90vh viewer grows out of the reactor, and the whole reactor group FLIPs to the viewer's bottom-left corner at 0.35 scale (rotation 0 → −20° → 0). Docked nodes still reopen cards, as floating cards stacked above the reactor. OFF (× / CAM OFF / Esc / Ctrl+Shift+C) stops tracks at once, then reverses; only auto-docked cards redeploy
- Transitions are queued (camera) or reversed (cards); card actions during a camera transition run after it. Reduced motion → fades/scales only. Permission denied → no camera mode; error shows in the CAMERA card, or as a notice when that card is docked
- Choices: the reactor badge is clamped to stay on screen, so at 16:9 it sits ~60px above the exact corner point; the header timer has a red dot but no "REC" word (nothing is recorded); the old small in-card preview and ⤢ float window were removed (the big viewer replaces them); card layout rebuilds now re-attach the CAMERA controls (they were lost before)

## JARVIS sound design (2026-10-18)
- `renderer/sfx.js` is now the single audio module (replaces `audio/hud-sound.js` + `audio/hud-cues.js`, and the old blip-only `sfx.js`). Everything is synthesized live with Web Audio — oscillators, noise, filters, envelopes; no audio files or samples
- Chain: sound → StereoPanner → sfxBus → compressor (-18 dB, 4:1) → masterGain (volume, default 0.6) → limiter (peaks ≈ -6 dBFS). Reverb send ≈25 % into a convolver with a generated 2.5 s stereo IR. One AudioContext for the app (TTS shares it); every sound is a voice whose nodes are stopped + disconnected when it ends. `env(param, attack, decay, sustain, release, { at, peak, hold })` helper, exponential decays
- Boot (all `tl.call()` on the boot timeline): powerOn (sub 120→40 Hz + CRT zap) · systemHum (55/55.4 Hz saws, lowpass 300 Hz + 0.2 Hz LFO, -24 dB → idle -36 dB or off) · bracketClick per corner (panned) · tickRattle with the rulers · ringSpin · segmentChirp (40 pentatonic triangle blips, panned clockwise) · coreSwell → coreIgnite (A4/E5/A5 + 7 Hz FM + 60 Hz boom) · dataScramble until SYSTEMS ONLINE · confirmOK per boot-log line · laserShoot per connector (panned) · panelOpen per panel (whoosh, rising-scale blip, glitch crackle) · counterTick with count-ups · ready (E5→B5→E6 + saw pad). Skip → boot sounds fade 0.2 s, then only the chime
- Interaction: hover tick / click blip on buttons + cards (global, `sfx.bindUi()`), card dock = suck-in whoosh → thunk + ripple shimmer (sounds live on each card's dock timeline, direction-aware), reopen = rising whoosh + blip, mic on/off two-tones, camera transform (+ lens-focus chirp) both ways, redeploying cards play panelOpen, error = low double buzz
- Voice greeting ("ระบบพร้อมใช้งานครับ" first launch / "สวัสดีครับ ยินดีต้อนรับกลับมา" after) gets a light robotic color: highpass 150 Hz, 30 Hz ring mod at 15 %, reverb send (WinRT voices only; speechSynthesis gives no audio to process)
- Controls: SOUND ON/OFF + volume in the menu (and 🔊 button); Settings › การแสดงผล adds "mute boot sound only" and idle hum. All in localStorage (try/catch). prefers-reduced-motion → quieter, shorter, no whooshes. Browser-only splash: dim reactor outline + "แตะเพื่อเริ่มระบบ · CLICK TO INITIALIZE"; Electron autoplays and skips it
- Verified: every sound rendered offline through the real chain (no NaN; boot peak -5.6 dBFS, hover ≈ -30 dBFS) and a live run (all boot cues fire in order, dock/reopen sounds, voices cleaned up to just the hum)

## Visual refinement — calm, minimal, premium (2026-10-18)
- Same features and behavior (cards, docking, camera mode, boot, sounds); only the visual language changed
- Color: neutral near-black (#07090C → #0B0F14 radial lift behind the reactor), text #E6EDF3 / #8B98A5 / #7A8590 (all ≥ 4.6:1, WCAG AA), lines rgba(230,237,243,0.12). One accent #5BE1F0 for active / live / corner accents / reactor; orange only for mic live, camera live and warnings
- Glow only on the reactor logo (soft, 16px, 30%) and live indicators. Removed: text glow, connector glow, bloom, scanlines, light beam, glitch flicker, floating accent dashes, crosshairs, edge rulers + coordinate labels, radar sweep, state shockwaves, film grain, mouse parallax
- Type: IBM Plex Sans Thai (UI + Thai, line-height ≥ 1.5) + IBM Plex Mono (numbers, tabular figures); Rajdhani / Share Tech Mono removed. Card titles 11px / 500 / 0.14em secondary; values 32–40px mono light; units 40% secondary
- Cards: one 6px chamfer (top-left + bottom-right), 1px border at 8% (16% + 1px lift on hover), 1.5px accent corner arms, glass fill (2.5% white + 12px blur), 20/24px padding, Lucide-style 16px icons, × only on hover. Data visuals: 2px progress line, 4px dots, 2px latency bars (latest in accent), 1.5px waveform line, 2px elapsed ring. IDs removed. Same height per row (LAST REPLY / LATENCY at row 5 h9; CAMERA / ELAPSED at row 37 h5)
- Reactor (`ui/core.js`, `ui/ticks.js`): 3 hairline rings, one slowly rotating accent arc (length = progress when known), 60 thin radial lines lit by real level / activity, one tick ring (5° minor, 45° major), 0/90/180/270° labels only, 6px nodes (accent when active, ring when docked, one soft pulse), smaller flat logo with 4 s breathing, thin orange arc around the logo while listening. Mini (camera mode) hides ticks and lines
- Frame: faint dot grid (40px, 6%), four 1px corner brackets in window space, 40px ghost menu + sound buttons (SVG icons, no emoji)
- Motion: one ease, cubic-bezier(0.22, 1, 0.36, 1) (`ui/ease.js`, registered in GSAP as 'calm'). Boot ≈ 2.8 s (was 4.8): fade + 8px + scale 0.98, cards on a 60 ms stagger, lines draw in, numbers count up softly — no CRT line, flash, scramble, boot log. Docking: card fades/scales 0.96 → 0 toward its anchor, a small dot travels the line, the node pulses once. Camera viewer: fade from 0.98, no reactor twist, no CRT collapse
- Camera mode: viewer with the card chamfer and accents, LIVE pill + mono timer + icon-only buttons; tint, scanlines, crosshair, sweep removed
- Sound (`sfx.js`): minimal palette — soft sine blips, one gentle ready chime, subtle whooshes for docking + camera; hum, glitch crackle, laser zaps, data chatter and square/saw tones removed; output −30 %. "Idle hum" setting removed
- Verified: layouts collision-free; screenshots at 1366×768, 1920×1080, 2560×1440, menu, settings, boot frames, camera mode (synthetic stream), reactor states; all sounds rendered offline (no NaN, boot peak −12.5 dBFS); live dock / reopen

## Reactor brought back to life + card polish (2026-10-18)
- Reactor: dim full track (1px, 8% white) with one live 2px cyan arc (round caps) — standby 40° orbiting every 12 s, listening/speaking length follows the real level, processing = indeterminate sweep. 72 segments (2×10px, 8% white) fade in cyan with the audio (FFT when available); standby wave every 6 s. Inner disc 5% cyan → transparent. Logo 1.6× with a breathing halo (20%, 4 s), drawn from a cached sprite. Thin amber arcs (1.5px) only while listening / speaking, 300 ms fades. Tick ring turns once per 120 s (CSS), 0/90/180/270 ticks 12px, labels fixed on-axis at one offset with a background outline where connectors pass
- Cards: gradient glass fill + 1px top highlight, border 9%; border and corner accents share one centreline inset 0.75px (nothing outside the edge). Three sizes (small 11×5, medium 13×7, large 18×9) mirrored around the reactor, mirrored node angles (310/50, 334/26, 270/90, 225/135) and straight 45° bottom connectors. One value size (32px); units 45%, secondary, baseline
- Empty states: "— dB" + "ไมค์ปิดอยู่ · Ctrl+Space", "— %" + "ยังไม่ได้พูด", "00/00" + "ยังไม่มีโปรเจกต์", "— s"; bars show only their dim track
- Latency: 8 slots, 3px rounded bars (4px placeholders), past 30% grey / latest cyan, heights relative to the visible max, dashed average line
- Connectors 14% white. Nodes: 7px dot + 1px ring; hover (node or card) → cyan ring + card-name tooltip on every node; docked → filled cyan; a data update sends one cyan pulse along the connector (rate-limited; live levels and stream deltas don't pulse)

## Hands-free mode — wake word "จาร์วิส" / "Hey Jarvis" (2026-10-18)
- Toggle: third 40px ghost button top-left (waveform icon), Ctrl+Shift+H, tooltip "Hands-free · พูด 'จาร์วิส' เพื่อเรียก". OFF grey; ON cyan + tiny pulsing dot. OFF at every launch (optional auto-start in Settings › Hands-free, only after consent). First enable shows a Thai consent dialog (real click only)
- Engine (`renderer/handsfree/`): openWakeWord on onnxruntime-web 1.29.0 (wasm, 1 thread) in a module Web Worker; AudioWorklet resamples to 16 kHz and posts 80 ms frames straight to the worker (the UI thread never sees audio). getUserMedia with echoCancellation / noiseSuppression / autoGainControl. Models: openWakeWord v0.5.1 melspectrogram + embedding + hey_jarvis + Silero VAD v4, downloaded once (~5.5 MB) to userData/handsfree (`lib/installer/wake-assets.js`). No audio is streamed anywhere while waiting for the wake word
- Thai variant: the stock model only knows "hey jarvis" (bare "Jarvis" ≈ 0.2–0.4, "จาร์วิส" ≈ 0). Trained an extra head (`models/jarvis-th.json`, MLP 1536→32→1 on the same embeddings) for "จาร์วิส / จาวิส / เฮ้ จาร์วิส / Jarvis": Edge neural voices (Thai, 24 English accents, Lao/Khmer/Burmese/other Asian accents) × speed × pitch, augmented with noise / babble / far-field / reverb; negatives = everyday Thai/English speech, typical JARVIS replies, and ~800 confusable words (Java, Jasmine, Avis, ทาวิส, ชาววิสาหกิจ, จ่าวิชัย…). Tools: `scripts/wake-training/{extract,train,eval}.mjs`
- Detection = stock ≥ threshold OR custom head ≥ threshold. Sensitivity Low/Medium/High (stock 0.7/0.5/0.3, head 0.95/0.85/0.7), 1.5 s cooldown; while TTS plays only ≥ 0.85 / 0.97 counts (lower scores are logged as filtered false triggers)
- State machine (`controller.js`, unit-tested with fakes): IDLE → WAKE_LISTENING → WAKE_DETECTED (chime, ~300 ms; recording already runs with 240 ms pre-roll) → COMMAND_LISTENING (Silero VAD: end after 1.2 s silence, max 15 s, cancel if no speech within 4 s) → PROCESSING (STT → local command or Claude) → SPEAKING → FOLLOW_UP (6 s, speech starts a command without the wake word) → WAKE_LISTENING. PAUSED when minimized (or tray mode keeps listening), on sleep / screen lock, or mic unplugged (auto-resume on devicechange). Worker owns audio timing; page commands carry an epoch so a stale command can't cancel a recording the worker already started
- Barge-in: wake word (or ≥ 560 ms of clear speech that is ≥ 2× the echo floor; can be turned off) while speaking → TTS fades out over 150 ms (`Speaker.stop(fadeMs)`), the turn is stopped (running tools are never killed by voice: they finish silently) → command listening. TTS from typed messages / greeting also uses the strict threshold, and a reply starting during the follow-up window closes the window
- STT: existing provider (whisper.cpp local / Azure). Live transcript = whisper partials every 1.5 s while speaking (`stt:transcribe {partial:true}`; skipped while a final runs, killed when the final starts — temp WAV still deleted after exit). Web Speech is the fallback only when chosen as provider. Wake word stripped from transcripts with Thai tone-insensitive folding ("จ้าวบิส", "ชาร์วิส", "จาวิด"); a transcript that is only the wake word re-arms listening
- Local commands (`commands.js`, fuzzy for whisper spellings, e.g. "ปิดกัดมาย" = ปิดการ์ดไมค์): หยุด/stop · พอแล้ว/that's all/ขอบคุณ · เปิด/ปิดกล้อง · เปิด/ปิดการ์ด <name> · ปิดโหมดแฮนด์ฟรี. acceptEdits / bypassPermissions still require on-screen confirmation of voice text
- UI: reactor states — WAKE_LISTENING slow dim breathing arc + "SAY ‘JARVIS’" (tertiary); WAKE_DETECTED logo 1→1.08→1, one cyan ripple, one bright segment sweep (400 ms); COMMAND_LISTENING segments follow the mic + amber inner arcs + "LISTENING"; PROCESSING sweep + "THINKING"; SPEAKING segments follow TTS; FOLLOW_UP thin arc (r 58) shrinking over 6 s. One-line transcript (≤ 60 chars, ellipsized from the left, secondary → primary when final, fades when the answer starts). Amber "● REC" only while a command records. MIC card: HANDS-FREE label, dB only while recording. Works in camera mode (mini reactor); the camera viewer now keeps ≥ 192 px from the left so it never covers the new button. Reactor segments now get real FFT bands (bandsProvider was never wired before)
- Sounds: wake chime E5→B5 sine 120 ms (plays even with HUD sound off unless disabled in Settings), capture blip, falling cancel blip, rising/falling on/off tones
- Privacy: nothing recorded before the wake word; raw audio never kept unless Settings › "บันทึกประวัติเสียง" (off by default → userData/voice-history). Tray mode: minimize hides to a code-drawn tray icon and keeps listening
- Events for other modules: `window.jarvisHandsFree.on('wake:detected' | 'command:start' | 'command:end' | 'assistant:speaking' | 'followup:timeout', fn)`; stats (false triggers: no speech after wake, empty transcript, filtered during TTS) in Settings › Hands-free + localStorage
- Dev: `JARVIS_USER_DATA=<dir>` (separate profile next to a running JARVIS), `JARVIS_FAKE_AUDIO=<wav>` (fake mic), `JARVIS_METRICS=<file>` (per-process CPU), localStorage `jarvis.hfDebug=1` (score log)
- Second stage: detections by the Thai head alone are confirmed by local whisper on the 1.6 s around the wake word (must contain a "จาร์วิส" spelling); with Azure / Web Speech this is skipped so pre-wake audio never leaves the device. The head must also hold for 2 consecutive frames
- Measured (held-out voices/words, synthetic speech): Thai head recall ≈ 97–99%; on its own it still fires on near-homophones (Java, ดาวิส, Jarred, จารวี) — the whisper check rejects those (e2e: "Java… Travis… Davis…" fired and was rejected; whisper turned all 17 confusables into their own words and all 13 real wake words into Jarvis spellings). Stock "hey jarvis": ≤ 1.8 false fires/h on the same speech
- e2e in the real app (fake mic = scripted WAV, `JARVIS_FAKE_AUDIO`): Hey Jarvis + command, จาร์วิส + local command, follow-up timeout, false fire rejected, wake + silence → cancel after 4 s. CPU (Electron metrics, 1 core = 100%): renderer 1.9% → 3.0% with wake listening on (Ryzen 7 5800H) ≈ 0.1% of the machine
- Not verified with a real voice yet (no human mic test in this session); real rooms / accents may need Sensitivity tuning — the false-trigger counter in Settings › Hands-free is there for that
- License note: openWakeWord's pre-trained models are CC BY-NC-SA 4.0 (non-commercial); Porcupine was not used because it needs a Picovoice AccessKey (the engine interface in `engine.js` is swappable)

## เลือกโมเดลจากหน้าหลัก (2026-10-18)

- เมนู **MODEL** มุมซ้ายบน (ถัดจากปุ่ม Hands-free): DEFAULT / OPUS / SONNET / HAIKU → บันทึกลง `settings.model` (ค่าเดียวกับช่อง `--model` ในหน้า Settings) แล้ว restart CLI ด้วย `--resume` จึงไม่เสีย context; ชื่อโมเดลเต็มที่พิมพ์ใน Settings แสดงเป็นตัวเลือกสีส้ม
- สั่งด้วยเสียง/พิมพ์: `/model haiku`, "เปลี่ยนโมเดลเป็นซอนเน็ต", "ใช้โมเดลโอปุส", "ใช้โมเดลค่าเริ่มต้น" (`parseModelCommand` ใน `lib/jarvis-core.js`) — จัดการในแอปเอง ไม่ส่งไปที่ Claude; ต้องเป็นประโยคคำสั่งทั้งประโยค ประโยคที่แค่กล่าวถึงจะไม่ถูกดัก
- เปลี่ยนระหว่างกำลังตอบ: ตั้ง `restartPending` แล้ว restart เมื่อ turn จบ (เดิมการเปลี่ยน `model`/MCP ระหว่าง turn ถูกเก็บลง settings แต่ไม่มีผลจนกว่าจะ restart เอง)
- ตรวจแล้ว: `npm test` 51/51, เปิดแอปจริงด้วย `JARVIS_USER_DATA` แยกโปรไฟล์ + `scripts/ui-shot.js` เลือก SONNET → settings.json ได้ `"model": "sonnet"` และขึ้นแจ้งเตือน

## Result Viewer — search / news / YouTube / web on the big screen (2026-10-18)
- Protocol: new block `jarvis-result` (`lib/blocks/schemas.js`, validator gained `enum` / `maximum`): `{ type: search|news|youtube|images|web|weather|table|chart|text|map, title, spokenSummary, … }`. The system prompt asks for it whenever there is something to look at, and to speak only the 1–3 sentence summary (the app also caps speech at ~320 characters once a payload is on screen). New types = one renderer in `renderer/ui/results.js`
- One shared viewer (`renderer/ui/stage-viewer.js`) for Camera mode and results: tabs (max 6, oldest dropped; the camera is one tab), header 48 px (type icon + title, count / time, tab strip, ⤢ open externally, ×), scrollable body (32 px padding), optional footer with the spoken summary + SOURCES, kept clear of the reactor badge. The transition moved here from camera-panel.js and is the same for both: cards dock (staggered, remembered), the viewer grows out of the reactor centre (scale 0.1 → 1, 0.45 s), the reactor FLIPs to the bottom-left corner at 0.35 and stays live / clickable; reverse on close; requests during a transition are queued (rapid open/close converges); resize recalculates; reduced motion = fades. Content is counter-scaled so text keeps real pixel sizes at any window size
- Camera: `camera-panel.js` now only owns the card, the camera state and the live feed; turning the camera on opens/selects the "camera" tab, closing that tab turns the camera off. Never two large viewers
- Flow (`renderer/ui/result-viewer.js`): a WebSearch tool call opens the viewer at once with a shimmer skeleton ("กำลังค้นหา…", reactor THINKING) → the result block replaces it → no block: skeleton removed, or a long reply (≥ 700 chars) opens as a text tab. Links from results open as new tabs (YouTube links become video tabs). Closing returns the cards; LAST REPLY gets "ดูผลลัพธ์อีกครั้ง"
- Renderers: search (AI summary with [n] chips, cards with favicon / site / 17 px title / 2-line snippet / URL, cyan corner on hover), news (2–3 column grid, featured top story, 16:9 thumbnails with fallback, source + relative Thai time always shown), youtube (youtube-nocookie embed driven over postMessage — the CSP allows no YouTube script; Up next list; owner-blocked → thumbnail + "เปิดใน YouTube"), web (main checks X-Frame-Options / CSP frame-ancestors: sandboxed iframe when allowed, else a plain-text reader view; toggle + "เปิดในเบราว์เซอร์"), images (masonry + lightbox with source), weather (big now + hourly strip), table (sticky header, tabular numbers), chart (SVG, cyan main series, grey others), text (small safe markdown → DOM, 70ch), map (OpenStreetMap embed). Skeleton / empty / error states with retry. Numbered items for voice
- Video: playing → TTS ×0.6 and HUD sounds ×0.5, "▶ PLAYING" on the reactor; while JARVIS listens / talks the video drops to 20 % and comes back after. Inactive tabs pause; closed tabs unload (iframes blanked, players stopped)
- Voice (hands-free and push-to-talk, only while the viewer is open): ปิด / ปิดหน้าจอ · ถัดไป / ก่อนหน้า (tabs, or the highlighted item) · เปิดอันที่ N / อ่านข่าวแรก (Thai / Arabic / Thai digits / English numbers) · เลื่อนลง / เลื่อนขึ้น · เล่น / หยุด / ข้าม N วิ / ถอยหลัง N วิ / เสียงดังขึ้น / เบาลง · เปิดในเบราว์เซอร์. Keys: Esc closes (a lightbox first), Ctrl+Tab / Ctrl+Shift+Tab switch tabs. Viewer = role dialog with aria-label; focus moves in on open and back on close
- Safety: model / web text only via textContent; links and images http(s) only; YouTube ids validated; `web:inspect` (main, `lib/web/reader.js`) fetches http(s) only, refuses localhost / LAN / link-local (every redirect hop re-checked), 10 s / 3 MB caps, returns plain-text blocks; `web:open-external` http(s) only. CSP: img-src + frame-src allow https (scripts still 'self' only); iframes are sandboxed without top-navigation; media permission checks now require our own origin (embedded pages share the webContents). YouTube embeds get a Referer header (they refuse to play without one — verified: the video plays in the app)
- Verified: 59 tests (schema, extractor, URL / id safety, reader extraction, private-address blocking, framing headers, voice commands); real app screenshots of every type, tabs, close + reopen link, camera + results in one viewer, skeleton → result, Esc, rapid toggles, malicious payload rendered as text. Not yet run with a real Claude turn (WebSearch needs an on-screen approval click)
- Dev: `window.__resultViewer` / `window.__cameraPanel` exposed only with localStorage `jarvis.hfDebug=1`; `window.jarvisViewer.show(payload)` / `.close()` for other modules

## Web Viewer — live pages + AI summary (2026-10-18)
- Pages are real top-level pages in `WebContentsView`s (`lib/web/browser.js`), attached to the main window, so X-Frame-Options / frame-ancestors don't matter and no headers are stripped. Replaces the old iframe / reader `web` tab (`web:inspect` removed; `reader.js` keeps only its URL checks). Session `persist:jarvis-web` (separate from the app, logins persist; Settings › เว็บ › "ล้างข้อมูลเว็บ"), desktop Chrome UA without "Electron", no preload, sandbox + contextIsolation + webSecurity, Chromium PDF viewer on
- Same transition as the Result Viewer (one tab per page in `stage-viewer.js`). Native views can't animate or sit under HTML: the renderer measures `.wb-page` and sends its rect (`web:bounds`) on resize / divider / layout; the view hides behind a `capturePage()` screenshot for open / close, the menu, dialogs, floating cards and prompts. Reactor badge is smaller over web pages (0.2) and the page stops above a footer band sized to clear it
- Layout: page ~64 % / summary ~36 % (divider 50–75 %, saved), browser bar 40 px (back / forward / reload-stop, address with lock + domain + dimmed path, 2 px cyan progress, JARVIS chip, panel toggle, "เปิดในเบราว์เซอร์จริง", ×). Tabs = viewer tabs (max 6 live; popups / window.open become tabs). Keys inside a page or the HUD: Ctrl+L, Alt+←/→, Ctrl+R / F5, Ctrl+W, Ctrl+F (find in page), Ctrl+Tab
- Asked on screen (click only, bottom right): camera / mic / location / notifications / clipboard read (per site, "จำไว้" → userData/web-permissions.json), mailto: / zoom: … Downloads go through the save dialog. Crash → "หน้าเว็บหยุดทำงาน" + reload; hung → status line
- Reading (`lib/web/page-reader.js`): did-stop-loading (once per navigation; SPA route changes too) → `page-agent.js` + Readability + `page-text.js` injected into isolated world 1001 → DOM settle (800 ms quiet, ≤ 8 s) → extract (article via Readability, else visible text by section; meta / OG / JSON-LD, author, date, canonical, headings, tables, prices / dates / %, images) → captcha / bot check / login wall → calm notice, re-read after the next navigation
- Summary (`lib/web/summarize.js`): one-shot `claude -p --model haiku --effort low --tools "" --strict-mcp-config --setting-sources local --no-session-persistence --json-schema …` in an empty temp folder — the page never reaches the main session or any tool. Page text fenced in `<untrusted_page>` (the page can't close the tag); the prompt says to ignore instructions in it; injection attempts are flagged in the panel. Output re-validated (refs must be real passages). Pages > 60k chars: chunk notes in parallel + merge (cap 120k, rest via "อ่านต่อ"). PDFs: pdf.js text in main (`lib/web/pdf.js`, fetched with the page's session); key points jump to `#page=N`
- Panel: source (favicon, site, title, date / author, reading time) · สำหรับคุณ (answer to the question from the `jarvis-result` `question` field) · TL;DR (+ "แปลจาก …") · ประเด็นสำคัญ (click → scroll + highlight the passage) · ข้อมูลสำคัญ (label / value rows, tables with copy) · ถามหน้านี้ (typed or mic, answers cite passages). States: loading (reactor THINKING) / blocked / failed + retry. Only the TL;DR is spoken. Closing → LAST REPLY keeps the TL;DR + "เปิดหน้าเว็บอีกครั้ง"
- Voice: เปิดเว็บ pantip / ไปที่ github.com (known names resolve locally, others go to Claude) · สรุปหน้านี้ · อ่านต่อ · เลื่อนลง / เลื่อนขึ้น / ไปบนสุด · ย้อนกลับ / ไปข้างหน้า / รีโหลด · คลิกลิงก์ <text> (links only; a button asks first) · แท็บถัดไป / ปิดแท็บ · ขยายเว็บ · เปิดในเบราว์เซอร์ · ปิดหน้าจอ. Jarvis-opened URLs must be public (no localhost / LAN); typed addresses may be local
- Measured: short page ≈ 10 s to summary, Wikipedia article ≈ 18 s, 15-page PDF ≈ 12 s per summary call (`--effort low` cut 6.1 → 3.7 s API time; one call beats chunk + merge 12 s vs 32 s)
- Verified: 76 tests (UA, address / site names, bounds, schemes, permissions memory, web voice commands, facts, captcha / login detection, chunking, untrusted fencing, output checks, PDF split); real app: github.com (frame-blocked before), popups → tabs, permission + external-app prompts, local-address refusal, crash notice, injection page (instructions ignored + flagged), English → Thai summary, highlight, ask with refs, button-needs-confirmation, link by voice, login wall, PDF + page jump, read-on, find, menu over a page, expand, close → reopen link
- Not done: Electron 44.9.0 upgrade (the running app locks `node_modules/electron`; close JARVIS and run `npm install --save-dev --save-exact electron@44.9.0`), download flow only checked by reading the code (the save dialog is native), Jarvis-driven multi-page browsing (by design: Claude only opens pages)
- Dev: `window.jarvisViewer.openWeb(url, opts)`; `window.__webViewer` with `jarvis.hfDebug=1`; `JARVIS_WEB_DEBUG=1` + `JARVIS_SCREENSHOT` logs bounds / find; page script `console.log('[shot] name')` writes a frame with the live page composited in, `'[crash-web]'` crashes the shown page

## Typhoon ASR — free Thai STT API (2026-10-19)
- `lib/stt/typhoon.js`: `typhoon-asr-realtime` via `https://api.opentyphoon.ai/v1/audio/transcriptions` (OpenAI-compatible, free, 100 req/min). Key in Settings › เสียง (safeStorage, `typhoon.key`) or `TYPHOON_API_KEY`. Key storage in `lib/stt/index.js` is shared with Azure (`azure.key` unchanged)
- Same rules as Azure: only the command audio is sent; the wake check and live previews stay on local whisper. English words come back transliterated and numbers as words (model limitation)
- Verified: 3 tests with a mocked endpoint; not yet run against the real API (no key here)

## Floating Orb (2026-10-19)
- `lib/orb/orb-window.js` + `renderer/orb/` + `orb-preload.js`: a frameless, transparent, always-on-top window (layer `floating`, or `screen-saver` with "อยู่บนสุดเสมอ"), skipTaskbar, `focusable: false` (focusable only while the bubble's text box is open), click-through outside the circle / bubble (`setIgnoreMouseEvents(true, { forward: true })`, toggled by a hit test in the page). Shown on minimize (and in tray mode), hidden on restore / show / focus. Created hidden after the main page loads so it appears instantly
- The voice pipeline stays in the main window: `backgroundThrottling: false` on it; main sends `window:bg` so the page pauses the reactor drawing and decides hands-free (keeps listening while the orb is up or in tray mode, pauses otherwise as before). `renderer/orb-bridge.js` sends only changed state (`orb:sync`, coalesced 50 ms) and the level (`orb:level`, 30 fps timer — the minimized page gets no animation frames; `Speaker.level()` reads the analyser on demand)
- Position (`lib/orb/geometry.js`, DIP): default bottom-right of the primary work area, 24 px margin; drag = pointer events in the page + `orb:drag` start/move/end, main moves the window from `screen.getCursorScreenPoint()` (works across monitors / mixed DPI, one move per frame, 5 px threshold, scale 1.08 + shadow + grabbing cursor); release within 40 px of an edge snaps to 24 px (250 ms ease-out); always clamped to the nearest display's work area; saved as `orbPos {x, y, displayId}`; unplugged display → default; re-clamped on display-added / removed / metrics-changed
- Bubble: the window grows beside the orb toward the screen centre (left on the right half, downward on the top half), reserving the max size so streaming text never moves the orb. Transcript (secondary) · reply (4 lines) · "มีผลลัพธ์ · เปิดดู" chip · ดูเพิ่ม · ⌨ text box. Auto-hides 6 s after JARVIS is idle again, hover keeps it. Tips / errors use a one-line card level with the orb
- Click = push-to-talk toggle (waits 240 ms for a double click), double-click = open JARVIS, right-click = native menu (เปิด JARVIS · ปิด/เปิดไมค์ · Hands-free · ปิดเสียง · ซ่อนไอคอน · รีเซ็ตตำแหน่งไอคอน · ออกจากโปรแกรม). Global key `orbShortcut` (Control+Shift+Space) next to push-to-talk. No new sounds (mic blips / wake chime come from the main page as before)
- Crash: main page gone → orb error state; double-click reloads it. Main window closed → orb destroyed → app quits
- Settings › การแสดงผล: show when minimized (on) · always on top of fullscreen / taskbar (off) · size S/M/L · auto-fade (off; animations pause while faded) · auto-open window on results (off) · shortcut · reset position
- Verified: 6 tests (default / clamp / snap / unplugged display / bubble direction / settings); real app on a test profile: minimize → orb (not focused), listening / thinking / speaking / muted / error, bubble opens left + up from bottom-right and auto-hides, crash → error → relaunch. CPU while minimized and idle: main page ≈ 0.5 %, orb ≈ 0–0.2 %
- Not yet checked by hand: real mouse drag across monitors, hover tooltip, click-through feel, the `screen-saver` layer over the Windows taskbar
- Dev: page script `console.log('[orb-shot] name')` → `<shot>-orb-name.png` + bounds in the log; `'[crash-main]'` crashes the main page, captures the orb and relaunches

## "ดูนี่" with the camera off → screenshot (2026-10-19)
- Camera off + "ดูนี่" / "ดูอันนี้" / "ดูหน้าจอ" (also STT spellings "โดนี่", "ดูนี้"; `wantsScreenLook()` in `renderer/handsfree/commands.js`, on tone-folded text) → `screen:capture` in main: the display under the mouse via `desktopCapturer`, 1600 px wide JPEG (≈ 125 KB). JARVIS's own windows (main + orb) are excluded with content protection during the capture (WDA_EXCLUDEFROMCAPTURE — verified: a fullscreen JARVIS is left out, not a black box)
- Sent like a camera frame, labelled for Claude as a screenshot of the user's screen; chat shows "🖥 แนบภาพหน้าจอ" + shutter sound. Camera on → unchanged (camera frame, all trigger words). A message queued while Claude is busy now keeps the picture taken when it was said
- Measured: 2.0 s first capture, ≈ 1.5 s after (Electron's Windows capture API)
