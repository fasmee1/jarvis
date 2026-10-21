// Hamburger menu + full-screen sections (one visible at a time) + window controls.
// TALK and PROJECTS are not sections: they are popups on the HUD (ui/conversation.js,
// ui/projects.js), opened through onTalk / onProjects.

const api = window.jarvis;
const $ = (id) => document.getElementById(id);
const VIEWS = { maker: 'view-maker', activity: 'view-activity', diagnostics: 'view-diagnostics', settings: 'settings' };
const ORDER = ['talk', 'maker', 'activity', 'diagnostics', 'projects', 'settings'];

export class Sections {
  constructor({ onChange, beforeShow, onTalk, onProjects }) {
    this.onChange = onChange || (() => {});
    this.beforeShow = beforeShow || (() => {});
    this.onTalk = onTalk || (() => {});
    this.onProjects = onProjects || (() => {});
    this.current = null; // null = home
    this.menu = $('menu');
    this.hb = $('hamburger');
    this.hb.addEventListener('click', () => this.toggleMenu());
    this.menu.addEventListener('click', (e) => {
      if (e.target === this.menu) this.closeMenu();
      const item = e.target.closest('[data-section]');
      if (item) this.show(item.dataset.section);
      const win = e.target.closest('[data-win]');
      if (win) api.invoke('window:control', win.dataset.win).then((r) => this._fs(r.fullscreen));
    });
    for (const b of document.querySelectorAll('[data-home]')) b.addEventListener('click', () => this.home());
    addEventListener('keydown', (e) => this._key(e));
    api.on('window:state', ({ fullscreen }) => this._fs(fullscreen));
    api.invoke('window:control', 'query').then((r) => this._fs(r.fullscreen)).catch(() => {});
  }

  _fs(on) {
    document.body.classList.toggle('fullscreen', !!on);
    const b = $('win-fs');
    if (b) b.textContent = on ? '⛶ ออกจากเต็มจอ (F11)' : '⛶ เต็มจอ (F11)';
  }

  _modalOpen() {
    return !$('approval').hidden || !$('barge').hidden;
  }

  _key(e) {
    if (e.key === 'Escape') {
      // Esc never exits the app: it closes the menu, then the section.
      if (this._modalOpen()) return;
      if (!this.menu.hidden) this.closeMenu();
      else if (this.current) this.home();
      return;
    }
    if (!this.menu.hidden && /^[1-6]$/.test(e.key)) {
      e.preventDefault(); // "1" must not end up typed in the conversation input
      this.show(ORDER[Number(e.key) - 1]);
    }
  }

  toggleMenu() {
    if (this.menu.hidden) this.openMenu();
    else this.closeMenu();
  }

  openMenu() {
    this.menu.hidden = false;
    this.hb.setAttribute('aria-expanded', 'true');
    this.menu.querySelector('.menu-item').focus();
  }

  closeMenu() {
    this.menu.hidden = true;
    this.hb.setAttribute('aria-expanded', 'false');
  }

  show(name) {
    if (name === 'talk') {
      // the conversation lives on the HUD: back home, then the popup opens
      this.home();
      this.onTalk();
      return;
    }
    if (name === 'projects') {
      this.home();
      this.onProjects();
      return;
    }
    if (!VIEWS[name]) return;
    this.closeMenu();
    this.beforeShow(name);
    for (const [k, id] of Object.entries(VIEWS)) $(id).hidden = k !== name;
    document.body.classList.add('in-section'); // HUD-only controls step aside (styles.css)
    this.current = name;
    this.onChange(name);
  }

  home() {
    this.closeMenu();
    for (const id of Object.values(VIEWS)) $(id).hidden = true;
    document.body.classList.remove('in-section');
    this.current = null;
    this.onChange(null);
  }
}
