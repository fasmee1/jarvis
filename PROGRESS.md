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
