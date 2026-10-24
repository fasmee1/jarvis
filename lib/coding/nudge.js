'use strict';
// Tracks files Claude edited that nothing has tested yet, so JARVIS can remind the user.

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PROTECTED = /[\\/]\.(git|claude|jarvis)([\\/]|$)/;
// a Bash command that looks like a test / lint / build run
const CHECK_COMMAND = /\b(npm\s+(run\s+)?(test|check|lint|build|typecheck)|pytest|cargo\s+(test|check)|go\s+(test|vet)|pio\s+run|tsc|eslint)\b/i;

class CheckNudge {
  constructor() {
    this.files = new Set();
    this.reminded = false;
    this.turnFiles = new Set(); // files edited in the current turn
  }

  /** Feed a top-level tool call. */
  toolUse(name, input) {
    const i = input || {};
    if (EDIT_TOOLS.has(name)) {
      const f = String(i.file_path || i.notebook_path || '');
      if (f && !PROTECTED.test(f)) {
        this.files.add(f);
        this.turnFiles.add(f);
        this.reminded = false;
      }
    } else if (name === 'Bash' && CHECK_COMMAND.test(String(i.command || ''))) {
      this.clear();
    }
  }

  clear() {
    this.files.clear();
    this.reminded = false;
  }

  /** Text for the end of a turn, or '' (the test reminder comes at most once per batch of edits). */
  reminder(hasChecks) {
    const edited = this.turnFiles.size;
    this.turnFiles = new Set();
    const parts = [];
    if (hasChecks && this.files.size && !this.reminded) {
      this.reminded = true;
      parts.push(`แก้ไป ${this.files.size} ไฟล์ แต่ยังไม่ได้รันเทสต์หรือตัวตรวจ — พูดว่า "รันเทสต์" หรือ "รันเช็ก" ได้เลย`);
    }
    if (edited) parts.push('ถ้าไม่ชอบที่แก้ พูดว่า "ยกเลิกการแก้ล่าสุด" ได้');
    return parts.join(' · ');
  }
}

module.exports = { CheckNudge };
