# Mee JARVIS

แอป Desktop (Windows) หน้าตาแบบ JARVIS HUD สำหรับคุยกับ **Claude Code CLI** ด้วยเสียงภาษาไทย มีสิทธิ์และเครื่องมือเท่ากับการรัน `claude` ใน terminal (Bash, Read/Write/Edit, WebSearch, MCP, subagents, skills, hooks, CLAUDE.md, settings ของผู้ใช้) แต่ขออนุญาตผ่านหน้าจอ HUD

## เริ่มใช้

```
cd C:\Users\Acer\mee-jarvis
npm install
npm link          # ลงทะเบียนคำสั่ง jarvis
jarvis .          # เปิดแอปโดยใช้โฟลเดอร์ปัจจุบันเป็นโปรเจกต์
```

ต้องมี Claude Code ที่ login แล้ว (`claude` แล้ว `/login`)

## สถาปัตยกรรม

```
renderer (sandbox, CSP, app://jarvis)  ──IPC allow-list──►  main.js
  HUD / chat / approvals / mic / camera                       │
                                                              ▼
                                                      lib/jarvis-core.js
                    ┌──────────────────────────────────────────┼────────────────────────┐
                    ▼                                          ▼                        ▼
         lib/claude/session.js                     lib/permission-mcp/broker.js   lib/blocks + lib/tts
         claude -p --input-format stream-json …    named pipe (สุ่มชื่อ + token)    แยกบล็อก jarvis-*, ตัดประโยคพูด
                    │                                          ▲
                    ├── --permission-prompt-tool mcp__jarvis__approve ──► lib/permission-mcp/server.js
                    └── --settings {hooks.PreToolUse} ─────────────────► lib/hooks/guard.js (ตัวกันพลาด)
```

- ข้อความผู้ใช้ส่งทาง stdin เท่านั้น, process ค้างไว้ 1 ตัวต่อ session และเปิดล่วงหน้า (pre-warm)
- การอนุญาตต้อง **คลิกบนจอ** เท่านั้น (event ต้อง `isTrusted`) ไม่มีใครตอบใน 120 วิ = ปฏิเสธ
- "อนุญาตเสมอ" บันทึก rule ลง `<โปรเจกต์>/.claude/settings.local.json`
- ทุก tool call บันทึกใน `<โปรเจกต์>/.jarvis/audit.log`
- `bypassPermissions` เปิดได้จาก Settings โดยพิมพ์ "ยืนยัน" เท่านั้น, ไม่ถูกบันทึกข้ามการเปิดแอป, ตัวกันพลาดยังทำงาน

## บล็อกแสดงผล

Claude ส่ง ```` ```jarvis-steps ````, `jarvis-diagram`, `jarvis-bom` (JSON ตาม `lib/blocks/schemas.js`) และ `jarvis-arduino`, `jarvis-scad` (โค้ด) — แสดงในแท็บของ HUD และไม่ถูกอ่านออกเสียง

ดูความคืบหน้าและผลทดสอบใน [PROGRESS.md](PROGRESS.md)
