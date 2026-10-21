# Mee JARVIS - ไอเดียฟีเจอร์ที่ควรเพิ่ม (2026-10-21)

อ่านจาก CLAUDE.md, README.md, PROGRESS.md และโครงสร้าง lib/ renderer/ แล้ว

## ที่มีอยู่แล้ว (ไม่ต้องทำซ้ำ)
- wake word "จาร์วิส" / "Hey Jarvis" และ barge-in (พูดแทรกแล้ว TTS หยุด)
- STT หลายตัว (whisper, Azure, Typhoon), TTS หลายตัว (winrt, edge)
- กล้อง + MediaPipe, ดูนี่ -> screenshot, Floating Orb
- Result Viewer (search/news/YouTube/web/map 3D), Web Viewer + สรุป AI
- โหมดโค้ดด้วยเสียง: test/check/diff/undo, หลายโปรเจกต์พร้อมกัน, worktree
- permission broker + guard, audit log, usage

## ข้อเสนอ เรียงตามความคุ้มค่า

1. ความจำข้ามบทสนทนา (Voice memory)
   - ตอนนี้ไม่มีโมดูลความจำของ JARVIS เอง (lib/history.js เก็บประวัติแชท)
   - เพิ่มคำสั่ง "จำไว้ว่า..." / "ลืมเรื่อง..." เก็บใน <โปรเจกต์>/.jarvis/memory.json
     แล้วแนบเป็น prefix ตอนเริ่ม session (วิธีเดียวกับ mode prompt ใน lib/prompt.js)
   - ทำเป็นโมดูล pure ทดสอบด้วย node --test ได้

2. เตือนความจำ / ตั้งเวลา / งานตามกำหนด
   - ไม่พบ scheduler ในโค้ด เพิ่ม lib/reminders.js + คำสั่งเสียง "เตือนฉันอีก 10 นาที"
   - เมื่อถึงเวลา: Notification ของ Electron + พูดผ่าน TTS + เสียง sfx
   - ต่อยอด: งานประจำ เช่น สรุปข่าวตอนเช้า, เช็กสถานะ build

3. Serial Monitor / กราฟข้อมูลบอร์ด (Arduino/ESP32)
   - JARVIS มี jarvis-arduino และ upload ผ่าน Claude แต่ยังไม่มีการอ่านค่าจากบอร์ดสด
   - เพิ่มแท็บ Serial: เลือกพอร์ต อ่านค่า แสดงเป็น chart (ใช้บล็อก jarvis-result type chart เดิม)
   - ถามได้ว่า "ค่าเซนเซอร์ตอนนี้เท่าไหร่" และให้ Claude วิเคราะห์ log ได้

4. Push-to-talk กดค้างแบบแท้
   - ค้างอยู่ใน PROGRESS.md (globalShortcut ไม่มี key-up) ใช้ native hook เช่น uiohook
   - ช่วยในที่ที่มีเสียงรบกวนหรือไม่อยากใช้ wake word

5. อ่านหน้าจอเป็นบริบท (Screen context)
   - ตอนนี้มี "ดูนี่" เมื่อกล้องปิดจะถ่าย screenshot เป็นครั้ง ๆ
   - เพิ่มโหมด "ดูหน้าจอต่อเนื่อง" หรือเลือกหน้าต่าง (desktopCapturer) เช่น
     "ช่วยดู error ในหน้าต่าง terminal นี้" พร้อมกันไม่ให้ทำตามคำสั่งในภาพ

6. ควบคุมอุปกรณ์/บ้าน (MQTT หรือ Home Assistant)
   - ผ่าน MCP server แล้วใช้ permission broker เดิมขอยืนยันการกระทำที่เสี่ยง

7. ปฏิทิน/อีเมล ผ่าน MCP (อ่านอย่างเดียวก่อน)
   - "วันนี้มีนัดอะไร" สรุปขึ้น Result Viewer

8. คุณภาพชีวิตของผู้พัฒนา
   - แสดงต้นทุน/โควตาต่อโปรเจกต์ใน HUD (มี lib/usage แล้ว ต่อ UI)
   - ส่งออกบทสนทนา/รายงานการทำงานเป็นไฟล์ Markdown
   - เทสต์ end-to-end ของ renderer (ตอนนี้ครอบคลุมเฉพาะโมดูล pure)

## ลำดับที่แนะนำ
ข้อ 1 -> 2 -> 3 (เล็ก ใช้โครงเดิมได้เกือบทั้งหมด) แล้วค่อย 4 และ 5

หมายเหตุ: ข้อสรุปจากการอ่านเอกสารและค้นคำสำคัญ ยังไม่ได้อ่านโค้ดทุกไฟล์
