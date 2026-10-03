// Outcome roles by market shape, in display order. Anything else (missing or extra roles) -> null.
//   team head-to-head  away, home          soccer 90-min result  home, draw, away
//   individual         a, b (bout / match sides as the canonical source orders them)
const SHAPES = [['home', 'draw', 'away'], ['away', 'home'], ['a', 'b']];
export function orderOutcomes(outs) {
  // Field markets (F1 race winner): roles 'p:<participant>'; unresolved contracts (role null) dropped.
  const field = outs.filter((o) => typeof o.role === 'string' && o.role.startsWith('p:'));
  if (field.length >= 2 && field.length === outs.filter((o) => o.role).length) return field;
  const roles = outs.map((o) => o.role).filter(Boolean);
  for (const shape of SHAPES) {
    if (roles.length === shape.length && shape.every((r) => roles.includes(r))) return shape.map((r) => outs.find((o) => o.role === r));
  }
  return null;
}

// Builds the public kalshi block for one link, or null when it must not be shown.
