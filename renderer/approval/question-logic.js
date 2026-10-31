// State of a question popup (check boxes + a text box per question). Pure — no DOM — so node --test covers it.
// A state is one entry per question: { picked: Set<label>, text: string }.

/** The option the question recommends: its label says "แนะนำ" / "recommended". */
export function isRecommended(option) {
  return /แนะนำ|recommended/i.test(option.label);
}

/** Start with the recommended option ticked, so the common case is one click on send. */
export function initialState(questions) {
  return questions.map((q) => {
    const rec = q.options.find(isRecommended);
    return { picked: new Set(rec ? [rec.label] : []), text: '' };
  });
}

/** Tick or untick an option. A single-choice question keeps at most one ticked. */
export function toggle(state, qi, q, label) {
  const s = state[qi];
  if (s.picked.has(label)) {
    s.picked.delete(label);
  } else {
    if (!q.multiSelect) s.picked.clear();
    s.picked.add(label);
  }
  return s;
}

/** A round button: this option becomes the only one chosen. */
export function choose(state, qi, label) {
  state[qi].picked = new Set([label]);
  return state[qi];
}

/** Every question has something ticked or typed. */
export function isComplete(state) {
  return state.length > 0 && state.every((s) => s.picked.size > 0 || s.text.trim().length > 0);
}

/** What goes back to the app: options in their original order, plus the typed text. */
export function collect(state, questions) {
  return state.map((s, i) => ({
    picked: questions[i].options.map((o) => o.label).filter((l) => s.picked.has(l)),
    text: s.text.trim(),
  }));
}
