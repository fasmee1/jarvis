# Handoff: ตัวตัดต่อคลิปสั้นใน JARVIS (หน้า EDIT)

สถานะ: ขั้น 1–7 เสร็จ (การ์ด EDITING หน้าหลัก + เครื่องมือแก้เมาส์/ปุ่ม/เสียงเสร็จ), ขั้น 8 และงานรอบใหม่ (ด้านล่าง) ยังไม่เริ่ม; ค้างทดสอบตัดตามแนวด้วย Claude จริง
ตรวจล่าสุด: `npm run check` 192/192, `npm test` 337/337 ผ่าน. ยังไม่ได้ commit อะไรเลย (ถามผู้ใช้ก่อน commit)

## แนวคิด
JARVIS ตัดต่อรอบแรกตาม "แนว" (style) ที่ผู้ใช้เลือก แล้วส่งมาให้ดูและแก้ต่อในหน้า EDIT
รายการตัด (edit list) เป็นชุดเดียวที่ทั้งเมาส์และเสียงแก้ร่วมกัน ไฟล์ต้นฉบับไม่ถูกแตะ ไฟล์จริงเกิดตอน export เท่านั้น
ตัดต่อทำเบื้องหลัง ผู้ใช้คุยกับ JARVIS ต่อได้ และเห็นขั้นตอนความคืบหน้า

## ทำเสร็จแล้ว
1. รากฐาน: `lib/video/edit-list.js` (clips {id,src,in,out,speed}, undo/redo), `auto-edit.js`, `ffmpeg-args.js` (มี `buildExportArgs` แล้ว), `media.js`, route `app://jarvis/media/<token>`
2. ffmpeg: `lib/video/ffmpeg.js` ดาวน์โหลดอัตโนมัติ (ตรึงเวอร์ชัน+เช็กซัม) หรือชี้ไปที่ที่ติดตั้งไว้ (setting `ffmpegPath`) แท็บตั้งค่า "วิดีโอ"
3. เข้าใจคลิป: `lib/video/analyze.js` (ช่วงเงียบ + ถอดเสียง whisper ภาษาไทย)
4. หน้า EDIT (เมนู 07, ปุ่ม 7): `renderer/ui/video-editor.js`, `video-timeline.js`, `video-editor.css` ดูคลิป/แถบเวลา/เล่น
5. แนว: `lib/video/presets.js` (4 แนวในตัว), `styles.js` (เพิ่ม/แก้/ลบเอง), `renderer/ui/video-styles.js`, ช่องสั่งเพิ่มเฉพาะคลิป
6. (ส่วนใหญ่) JARVIS ตัดตามแนว: `lib/video/planner.js` + `ask-claude.js` + `service.js` (`startCut`/`cancelCut`, เหตุการณ์ `video:cut`), ปุ่ม "ให้ JARVIS ตัดต่อตามแนวนี้", แถบความคืบหน้า, ย้อนกลับ/ทำซ้ำ (Ctrl+Z/Y) — เพิ่งต่อให้ปุ่ม undo/redo และสถานะตัดอัปเดตตาม snapshot + ใส่ CSS แล้ว
- ปุ่มปิด/เปิดเสียงพูดของ JARVIS ที่หน้าหลัก (`btn-voice-mute`) เสร็จแล้ว

## ที่เหลือ
### ขั้น 6 (ปิดให้จบ)
- [ ] การ์ด "กำลังตัดต่อ" ที่หน้าหลัก **แทนการ์ด ELAPSED** (เวลาแสดงที่แกนกลางอยู่แล้ว): แก้ `renderer/ui/cards.js` (`_body_elapsed`, `setElapsed`, `NAMES`, `OPEN`, `TIPS`), `layout.js` (entry `elapsed` col52 row36 w13 h7), `docking.js`, `home.js`, `handsfree/commands.js` (alias `elapsed`, Alt+8) — การ์ดฟัง `video:cut` / `video:progress` แสดงขั้นตอน+เปอร์เซ็นต์ กดแล้วเปิดหน้า EDIT
- [ ] ถ่ายภาพหน้าจอเช็ก UI (`scripts/ui-shot.js` ใช้ `JARVIS_USER_DATA`)
- [ ] ทดสอบจริงด้วย `claude` CLI กับคลิปจริง (กินโควต้าเล็กน้อย) ดูว่า Claude ตอบ JSON ที่ `parsePlan` รับได้
### ขั้น 7 เครื่องมือแก้
- [ ] ตัดแบ่ง (split) ที่หัวเล่น, ลากปรับต้น/ท้าย (trim), ลบแล้วชิดช่อง (ripple delete), ลากย้าย, ความเร็ว (0.5x–2x), ซูม — ฟังก์ชันอยู่ใน `edit-list.js` แล้ว (`splitAt/trim/remove/move/setSpeed`) ขาด IPC (`video:edit` ที่ validate) + UI เมาส์ + คำสั่งเสียง ("ตัดตรงนี้", "ลบช่วงนี้", "เร็วขึ้น", "ย้อนกลับ")
- [ ] ให้ JARVIS (Claude) แก้รายการตัดได้ด้วยเสียง เช่น "ตัดช่วงเงียบทิ้ง"
### ขั้น 8 export
- [ ] พรีเซ็ต TikTok/Reels/Shorts (`SIZES` ใน `ffmpeg-args.js`), รัน ffmpeg ด้วย `buildExportArgs`, แถบความคืบหน้าจาก `parseFfmpegTime`, เลือกที่เซฟ, ยกเลิกได้, ไม่เขียนทับไฟล์เดิม
### อื่น ๆ
- [ ] (ถามผู้ใช้) จำสถานะปิดเสียงข้ามการเปิดแอปใหม่ไหม — ยังไม่ได้ตอบ
- [ ] test ของ guard-hook ที่เคยพังมาก่อนไม่เกี่ยวกับงานนี้
- [ ] อัปเดต README/PROGRESS.md เมื่อจบ

## กติกาที่ผู้ใช้ย้ำ
ทำทีละขั้น เสร็จแล้วติ๊กแล้วไปต่อ ทำให้ละเอียดไม่ต้องรีบ · รัน `npm run check` และ `npm test` ทุกครั้งแล้วรายงานตามจริง · แอปที่รันอยู่ต้องรีสตาร์ตจึงเห็นการแก้ · อย่าเริ่มเขียนโค้ดตอนอยู่โหมดวางแผนจนกว่าจะสั่ง "เริ่ม"

## รอบใหม่ (ฟัซมีขอเพิ่ม 2026-10-27)
เป้าหมาย: 1) ถอดเสียงให้แม่นขึ้น 2) ซับ 3) เอฟเฟกต์เข้า/ออก/เสียง 4) อนิเมชั่น HTML — ผ่าน HyperFrames
หลักการที่ตกลง: JARVIS ตัด+ทำซับ → ตรวจ → HyperFrames ใส่เอฟเฟกต์/เสียง → ตรวจ → ส่งออก. เก็บ "โปรเจกต์" (HTML) ไม่ใช่แค่ MP4 เพื่อกลับมาแก้ซับ/จังหวะได้ ทุกจุดแก้ย้อนกลับได้
ผลลองจริง (โฟลเดอร์ทดลอง %TEMP%/hf-trial, ไม่แตะโปรเจกต์นี้):
- `npx hyperframes@latest doctor` ผ่านในเครื่องนี้ (Node 24, ffmpeg, Chrome headless มีแล้ว; whisper/Docker/TTS ไม่จำเป็น)
- `hyperframes init <ชื่อ> --video x.mp4 --skip-transcribe --skip-skills --non-interactive --resolution portrait` สร้างโปรเจกต์ index.html: แต่ละคลิป/ซับเป็น `<div class="clip" data-start data-duration data-track-index>` + GSAP timeline ใน `window.__timelines["main"]`
- `hyperframes check` ผ่าน, `hyperframes render --quiet -o out.mp4` คลิป 12 วิ 1080x1920 ใช้ 18 วิ, ซับไทย + fade/เด้งขึ้นถูกต้อง
- ต้องระวัง: HyperFrames ส่ง telemetry แบบนิรนาม (ปิดได้ด้วยคำสั่ง `hyperframes telemetry`); ต้องใช้อินเทอร์เน็ตโหลด gsap จาก CDN (ควรเก็บไฟล์ในเครื่อง); ยังไม่ทดสอบ data-media-start (เริ่มกลางไฟล์ต้นฉบับ) และเสียงเอฟเฟกต์
ถอดเสียง: ในเครื่องมีแค่โมเดล `small` (Thai fine-tuned `thonburian-medium` มีในโค้ดแล้วแต่ยังไม่ได้โหลด ~540MB); ยังไม่มีตัวอย่างเสียงพูดคนจริงไว้วัดความแม่น (ที่มีเป็นเสียง TTS)
งานถัดไป (ลำดับ): 1) ซับที่แก้คำ/เวลาได้ในหน้า EDIT + ให้ Claude แก้คำผิดตามบริบท + ตัวเลือกโมเดล 2) ตัวแปลงรายการตัดต่อ→โปรเจกต์ HyperFrames (+พรีวิวหน้า HTML เดียวกัน) 3) เอฟเฟกต์เข้า/ออก/เปลี่ยนฉาก 4) เสียงเอฟเฟกต์ (คลังเสียงที่ใช้ได้ฟรี) 5) อนิเมชั่น HTML 6) ส่งออก (ขั้น 8)

## ความคืบหน้า 2026-10-27 (บ่าย)
- เสร็จ: โมเดล thonburian-medium โหลดแล้ว (ใช้เองตอนถอดเสียงคลิป ดู `WhisperProvider.fileModel`); รายการคำพูดในหน้า EDIT กด ✎ แก้คำ / ↺ คืนค่าเดิม / Enter บันทึก / Esc ยกเลิก; ปุ่ม "ให้ JARVIS ตรวจคำ" (+ช่องบอกเรื่องของคลิป) ให้ Claude แก้คำอังกฤษที่ถอดเป็นไทยผิด (`lib/video/captions.js`, `VideoService.editCaption/restoreCaption/fixCaptions`, IPC `video:caption-edit|restore|fix`); ทดสอบกับบรรทัดจริงจากภาพผู้ใช้ แก้ถูก 4/4 ใน 6 วิ
- เสร็จ: เครื่องมือแก้คลิปขั้น 7 (แบ่ง/ตัดหัวท้าย/ลบ/ลาก/ความเร็ว/undo, เมาส์ ปุ่ม เสียง)
- **ปัญหาที่เจอ (ต้องแก้ก่อนทำซับ):** thonburian ให้ segment เดียว start 0 end 30 (ขนาดหน้าต่าง whisper ไม่ใช่ความยาวจริง) และ token เวลาเสีย (หลายตัวซ้อน 11.9) → ซับจะไม่มีจังหวะที่ถูกต้อง และ splitAtPauses ใช้ไม่ได้ ทางแก้ที่เสนอ: ตัดเสียงเป็นช่วงพูดตามช่วงเงียบที่หาไว้แล้ว (silencedetect) ถอดทีละช่วงด้วย thonburian → ได้เวลาเริ่ม/จบจากช่วงเงียบ ข้อความจากโมเดลแม่น; ช่วงพูดยาวเกิน ~8 วิ ค่อยแบ่งบรรทัดซับตามความยาวข้อความ
- ระวัง: เคยตัดไฟล์ video-editor.js ผิดตำแหน่งตอนแก้ด้วยสคริปต์ แล้วกู้คืนจากโค้ดที่อ่านไว้ (ไฟล์ยังไม่ commit ไม่มีสำเนา git) — ควร commit งานนี้เป็นระยะ (ถามผู้ใช้ก่อน)
