import { DEFAULT_CLASS_LEVELS } from '../config/academic.js';

// Pure rules for "which class comes next?". No database access, so they are easy to test.
//
// A class is a level ("JSS 2") plus an arm ("A"). Promotion keeps the arm where it can:
// JSS 2A -> JSS 3A. The progression is the school's ordered list of levels; the last level is
// the final class and nobody is ever promoted past it automatically.

export const normaliseLevel = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

export const levelsFor = (school) => {
  const own = (school?.classLevels || []).map(normaliseLevel).filter(Boolean);
  return own.length > 0 ? own : [...DEFAULT_CLASS_LEVELS];
};

// -> { kind: 'next', level } | { kind: 'final' } | { kind: 'unknown' }
export function nextLevel(levels, name) {
  const index = levels.indexOf(normaliseLevel(name));
  if (index < 0) return { kind: 'unknown' };
  if (index === levels.length - 1) return { kind: 'final' };
  return { kind: 'next', level: levels[index + 1] };
}

// Finds the class in `classes` for a level and arm: the same arm if it exists, otherwise the
// only class at that level. When it is ambiguous or missing the answer is null (a person decides).
export function pickClass(classes, level, arm) {
  const atLevel = classes.filter((c) => normaliseLevel(c.name) === normaliseLevel(level) && c.status === 'active');
  const sameArm = atLevel.find((c) => String(c.arm).toUpperCase() === String(arm).toUpperCase());
  if (sameArm) return sameArm;
  return atLevel.length === 1 ? atLevel[0] : null;
}

// What should happen to one student at a rollover?
//   promote  move to the next level      repeat  same level in the new session
//   review   a person must decide        (reason says why)
// `decision` is the CONFIRMED decision ('promoted' | 'repeated') or undefined.
export function planStudentMove({ levels, fromClass, decision, newClasses }) {
  if (decision !== 'promoted' && decision !== 'repeated') {
    return { action: 'review', reason: 'NO_CONFIRMED_DECISION' };
  }
  if (decision === 'repeated') {
    const target = pickClass(newClasses, fromClass.name, fromClass.arm);
    return target ? { action: 'repeat', target } : { action: 'review', reason: 'NO_TARGET_CLASS' };
  }
  const next = nextLevel(levels, fromClass.name);
  if (next.kind === 'final') return { action: 'review', reason: 'FINAL_CLASS' }; // never past the final class
  if (next.kind === 'unknown') return { action: 'review', reason: 'UNKNOWN_LEVEL' };
  const target = pickClass(newClasses, next.level, fromClass.arm);
  return target ? { action: 'promote', target } : { action: 'review', reason: 'NO_TARGET_CLASS' };
}
