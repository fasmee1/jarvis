// Classic script (runs before first paint): applies the saved UI style and motion
// preference to <html> so the page never flashes the wrong look.
// Keys: jarvis.style = 'hud' | 'calm' | 'arc' (default hud), jarvis.motion = 'auto' | 'full' | 'reduced'.
(function () {
  var style = 'hud';
  var motion = 'auto';
  try {
    var s = localStorage.getItem('jarvis.style');
    if (s === 'hud' || s === 'calm' || s === 'arc') style = s;
    var m = localStorage.getItem('jarvis.motion');
    if (m === 'auto' || m === 'full' || m === 'reduced') motion = m;
  } catch (e) { /* storage unavailable: defaults */ }
  var root = document.documentElement;
  root.dataset.style = style;
  root.dataset.motion = motion;
})();
