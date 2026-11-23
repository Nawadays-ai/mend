// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection (sections 1 to 4), matching lines at three tiers (section 5),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits
// (section 9) and the all-or-nothing write (section 10). Comments cite the SPEC_MATRIX requirement
// (REQ-xxx) each non-trivial behaviour enforces. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move pairs [old, new], for the R lines of section 2 (REQ-054). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 3: the shared line model (DESIGN.md stage C). One file is its line
// break, its lines and whether it ends with a break; split/join round-trips
// every text exactly.
// ---------------------------------------------------------------------------

interface FileModel {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBreak: false }; // REQ-069: an empty file has no lines, no final break
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n'; // REQ-066: the first line feed decides CRLF vs LF
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop(); // REQ-068: the empty piece after a final break is not a line
  return { br, lines: parts, finalBreak };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return ''; // REQ-070: a file of no lines is written empty
  return m.lines.join(m.br) + (m.finalBreak ? m.br : ''); // REQ-071: its own break, a final one exactly when it had one
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers, shared by sections 6, 7 and 8.
// A body entry is one line of a hunk/chunk body in body order; `marked` says a
// `\` line follows it (unified only, REQ-147); `emptyLine` says the patch line
// itself was empty (a context line whose text is empty, REQ-129/196).
// ---------------------------------------------------------------------------

interface BodyEntry {
  tag: ' ' | '-' | '+';
  text: string;
  marked: boolean;
  emptyLine: boolean;
}

const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(s.replace(/^[ \t]+/, ''));

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b; // REQ-092
  if (tier === 1) return stripTrail(a) === stripTrail(b); // REQ-093: trailing spaces and tabs removed from both
  return stripBoth(a) === stripBoth(b); // REQ-094: leading and trailing spaces and tabs removed from both
}

/** Every start position >= `from` at which O occurs at `tier`; occurrences may overlap (REQ-097/098). */
function findAtTier(lines: string[], O: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at all (REQ-091); with --strict only tier 0 is tried (REQ-095). */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const positions = findAtTier(lines, O, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** A V4A anchor: the first line at or after `from` equal to it, at the first tier where one is (REQ-204). */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

function reindent(text: string, F: string, P: string): string {
  if (text === '' || /^[ \t]+$/.test(text)) return text; // REQ-104: empty or only-whitespace lines are written as they are
  if (text.startsWith(P)) return F + text.slice(P.length); // REQ-103: that P replaced by F
  return text; // REQ-104: any other line is written as it is
}

/**
 * Replace the O.length lines matched at `pos` by the body's N lines, in body
 * order: context lines are written as the file's own matched line (REQ-101),
 * at tier 2 every other line of N is re-indented (REQ-102), at tiers 0 and 1
 * the lines of N are written as they are (REQ-105).
 */
function spliceMatched(lines: string[], pos: number, O: string[], body: BodyEntry[], tier: number): string[] {
  const F = leadOf(lines[pos]!);
  const P = leadOf(O[0]!);
  const out: string[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.tag === ' ') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (e.tag === '-') {
      oi += 1;
    } else {
      out.push(tier === 2 ? reindent(e.text, F, P) : e.text);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + O.length)];
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface HunkRec {
  A: number;
  body: BodyEntry[];
}

interface SectionRec {
  oldPath: string | null;
  newPath: string | null;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: HunkRec[];
}

/** A header path (REQ-112..115): after the four characters, up to the first tab, spaces removed, a/ b/ removed. */
function headerPath(raw: string): string | null {
  let t = raw;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.replace(/^[ \t]+|[ \t]+$/g, '');
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Apply a section's hunks in order to a file model (REQ-141..151). Throws Fail('no-match') (REQ-152). */
function applyHunks(model: FileModel, hunks: HunkRec[], strict: boolean, path: string): FileModel {
  let lines = model.lines;
  let finalBreak = model.finalBreak;
  let d = 0; // REQ-143: the sum over the hunks applied so far of (N's length minus O's length)
  for (const h of hunks) {
    const O = h.body.filter((e) => e.tag !== '+').map((e) => e.text);
    const nLen = h.body.filter((e) => e.tag !== '-').length;
    if (O.length === 0) {
      // REQ-146: N is inserted after the first A + d lines (all of them when the file has fewer)
      const texts = h.body.filter((e) => e.tag === '+').map((e) => e.text);
      if (texts.length > 0) {
        const idx = Math.max(0, Math.min(h.A + d, lines.length));
        const atEnd = idx === lines.length;
        lines = [...lines.slice(0, idx), ...texts, ...lines.slice(idx)];
        // REQ-148: an insertion at the end ends with a line break unless a `\` line follows the last `+` line
        if (atEnd) finalBreak = !h.body[h.body.length - 1]!.marked;
        d += texts.length;
      }
      continue;
    }
    const found = findTier(lines, O, strict);
    if (found === null) throw new Fail('no-match', path); // REQ-096
    // REQ-144: the occurrence whose 0-based position is nearest to A - 1 + d; REQ-145: of two equally near, the earlier
    const target = h.A - 1 + d;
    let pos = found.positions[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const reachedEnd = pos + O.length === lines.length;
    lines = spliceMatched(lines, pos, O, h.body, found.tier);
    if (reachedEnd) {
      // REQ-148: the result ends with a line break unless a `\` line follows the hunk's last context or `+` line
      const lastCP = [...h.body].reverse().find((e) => e.tag !== '-');
      finalBreak = !(lastCP !== undefined && lastCP.marked);
    } // REQ-149: when the matched lines do not run to the end, the file's final break stays as it was
    d += nLen - O.length;
  }
  return { br: model.br, lines, finalBreak };
}

function unifiedSectionEdit(sec: SectionRec, strict: boolean): Edit {
  return (tree) => {
    const { oldPath, newPath } = sec;
    // REQ-252: every path an edit names is checked for safety before anything else about it;
    // REQ-047: the name is the path as section 6 leaves it, after the prefix it removes.
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (sec.kind === 'create') {
      const p = newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p); // REQ-134
      // REQ-134: the file is the `+` lines of all its hunks, in order; REQ-072: LF breaks
      const plus = sec.hunks.flatMap((h) => h.body).filter((e) => e.tag === '+');
      const texts = plus.map((e) => e.text);
      const brk = !(plus.length > 0 && plus[plus.length - 1]!.marked); // REQ-150: ends with a break unless a `\` follows its last `+` line
      tree.now.set(p, texts.length === 0 ? '' : texts.join('\n') + (brk ? '\n' : ''));
      return;
    }
    if (sec.kind === 'delete') {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p); // REQ-136; its hunks are not read (REQ-137)
      tree.now.set(p, null);
      return;
    }
    const o = oldPath!;
    const text = tree.get(o);
    if (text === null) throw new Fail('missing', o); // REQ-138/140
    if (sec.kind === 'move' && tree.get(newPath!) !== null) throw new Fail('exists', newPath!); // REQ-138
    const out = joinFile(applyHunks(splitFile(text), sec.hunks, strict, o));
    if (sec.kind === 'move') {
      tree.now.set(newPath!, out);
      tree.now.set(o, null);
      tree.moves.push([o, newPath!]);
    } else {
      tree.now.set(o, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface SectionMut {
    gitOld: string | null;
    gitNew: string | null;
    pair: { old: string | null; new: string | null } | null;
    renameOld: string | null;
    renameNew: string | null;
    createMode: boolean;
    deleteMode: boolean;
    hunks: HunkRec[];
  }
  const sections: SectionMut[] = [];
  let cur: SectionMut | null = null;
  let inHeader = false;
  let body: BodyEntry[] | null = null;
  let bodyA = 0;
  let prevBody: BodyEntry[] | null = null;
  const newSection = (): SectionMut => {
    const s: SectionMut = { gitOld: null, gitNew: null, pair: null, renameOld: null, renameNew: null, createMode: false, deleteMode: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    prevBody = null;
    return s;
  };
  const endBody = (): void => {
    if (body !== null && cur !== null) {
      while (body.length > 0 && body[body.length - 1]!.emptyLine) body.pop(); // REQ-131: empty lines at the end of a body are not part of it
      cur.hunks.push({ A: bodyA, body });
      prevBody = body;
    }
    body = null;
  };
  const pairAt = (j: number): boolean => lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    const num = i + 1;
    if (body !== null) {
      // REQ-130: the body ends at the first other line, at a `diff --git ` line, or at a `--- `/`+++ ` pair
      if (L.startsWith('diff --git ') || pairAt(i)) {
        endBody();
      } else if (L.startsWith('\\')) {
        // REQ-147: a `\` line refers to the body line before it; when it opens a
        // later hunk's body, that is the previous hunk's last line in this
        // section (for a creation, its last `+` line, REQ-150)
        const tgt = body.length > 0 ? body : prevBody;
        if (tgt !== null && tgt.length > 0) tgt[tgt.length - 1]!.marked = true;
        i++;
        continue;
      } else if (L === '') {
        body.push({ tag: ' ', text: '', marked: false, emptyLine: true }); // REQ-129: an empty line is a context line whose text is empty
        i++;
        continue;
      } else if (L[0] === ' ' || L[0] === '-' || L[0] === '+') {
        body.push({ tag: L[0] as ' ' | '-' | '+', text: L.slice(1), marked: false, emptyLine: false }); // REQ-128
        i++;
        continue;
      } else {
        endBody();
      }
    }
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${num}`); // REQ-122: a `diff --git` line not of the form above
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(L);
      if (hm === null || cur === null) throw new Exit2(`error: parse ${num}`); // REQ-125: any other `@@` line; REQ-126: a hunk before any section
      body = [];
      bodyA = Number(hm[1]); // REQ-127: B and D are not used; A is kept for REQ-144/146
      inHeader = false;
      i++;
      continue;
    }
    if (pairAt(i)) {
      const pair = { old: headerPath(L.slice(4)), new: headerPath(lines[i + 1]!.slice(4)) };
      if (cur !== null && inHeader && cur.pair === null) cur.pair = pair;
      else newSection().pair = pair; // REQ-111: a `--- `/`+++ ` pair that is not part of a section's header starts a section
      i += 2;
      continue;
    }
    if (L.startsWith('--- ') && cur !== null && inHeader) throw new Exit2(`error: parse ${num + 1}`); // REQ-121
    if (cur !== null && inHeader) {
      // REQ-116: rename lines name the path as written (surrounding spaces removed);
      // the a//b/ removal of REQ-115 belongs to the ---/+++ lines only, never to rename lines
      if (L.startsWith('rename from ')) cur.renameOld = L.slice(12).replace(/^[ \t]+|[ \t]+$/g, '');
      else if (L.startsWith('rename to ')) cur.renameNew = L.slice(10).replace(/^[ \t]+|[ \t]+$/g, '');
      else if (L.startsWith('new file mode')) cur.createMode = true; // REQ-117
      else if (L.startsWith('deleted file mode')) cur.deleteMode = true;
      // REQ-119/120: `index`, mode, similarity and every other header line are ignored
      i++;
      continue;
    }
    i++; // REQ-132: outside bodies, lines that are not part of a section header are ignored
  }
  endBody();
  const edits: Edit[] = [];
  for (const s of sections) {
    // The pair names the paths first, then the rename lines (REQ-116), then the `diff --git` paths (REQ-118)
    const oldPath = s.pair !== null ? s.pair.old : (s.renameOld ?? s.gitOld);
    const newPath = s.pair !== null ? s.pair.new : (s.renameNew ?? s.gitNew);
    if (oldPath === null && newPath === null) continue;
    let kind: SectionRec['kind'];
    if ((oldPath === null || s.createMode) && newPath !== null) kind = 'create';
    else if ((newPath === null || s.deleteMode) && oldPath !== null) kind = 'delete';
    else if (oldPath !== null && newPath !== null && oldPath !== newPath) kind = 'move';
    else kind = 'change';
    edits.push(unifiedSectionEdit({ oldPath, newPath, kind, hunks: s.hunks }, strict));
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path); // REQ-252
    if (oldLines.length === 0) {
      // REQ-170: the file is created with the new lines; REQ-072: LF breaks, ends with a line break
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path); // REQ-171
    const model = splitFile(text);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path); // REQ-096
    if (found.positions.length > 1) throw new Fail('ambiguous', path); // REQ-172: the old lines occur at their tier exactly once
    // No context lines in this format: every line of N is an "other line" for REQ-102
    const body: BodyEntry[] = [
      ...oldLines.map((t) => ({ tag: '-' as const, text: t, marked: false, emptyLine: false })),
      ...newLines.map((t) => ({ tag: '+' as const, text: t, marked: false, emptyLine: false })),
    ];
    const out = spliceMatched(model.lines, found.positions[0]!, oldLines, body, found.tier);
    tree.now.set(path, joinFile({ br: model.br, lines: out, finalBreak: model.finalBreak }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let windowStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    let k = -1;
    if (j < lines.length) {
      k = j + 1;
      while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    }
    if (j >= lines.length || k >= lines.length) throw new Exit2(`error: parse ${searchLine}`); // REQ-167
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    // REQ-162..164: the nearest line before the SEARCH line, after the previous block's
    // REPLACE line, that is not blank and does not start with three backticks
    let path: string | null = null;
    for (let t = i - 1; t >= windowStart; t--) {
      const l = lines[t]!;
      if (blank(l)) continue;
      const tr = l.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`); // REQ-166: the first block with none
      path = prevPath; // REQ-165: the block takes the previous block's path
    }
    prevPath = path;
    windowStart = k + 1;
    edits.push(srEdit(path, oldLines, newLines, strict));
    i = k + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface ChunkRec {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: ChunkRec[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path); // REQ-252
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path); // REQ-201
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo); // REQ-202
    const model = splitFile(text);
    let lines = model.lines;
    let cursor = 0; // REQ-203: the chunks apply in order, with a cursor that starts at line 0
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const ai = findAnchor(lines, ch.anchor, strict, cursor);
        if (ai === null) throw new Fail('no-match', path); // REQ-205
        cursor = ai + 1; // REQ-206: the cursor moves past it
      }
      const O = ch.body.filter((e) => e.tag !== '+').map((e) => e.text);
      const nLen = ch.body.filter((e) => e.tag !== '-').length;
      if (O.length === 0) {
        // REQ-210: N is inserted at the cursor, or at the end of the file for an end-of-file chunk
        const texts = ch.body.filter((e) => e.tag === '+').map((e) => e.text);
        const idx = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines = [...lines.slice(0, idx), ...texts, ...lines.slice(idx)];
        cursor = idx + texts.length; // REQ-211
      } else {
        // REQ-208: the first occurrence of O at or after the cursor, at the first tier with one;
        // REQ-209: an end-of-file chunk takes only an occurrence that ends at the file's last line
        let hit: { tier: number; pos: number } | null = null;
        const maxTier = strict ? 0 : 2;
        for (let t = 0; t <= maxTier && hit === null; t++) {
          const ps = findAtTier(lines, O, t, cursor).filter((p) => !ch.eof || p + O.length === lines.length);
          if (ps.length > 0) hit = { tier: t, pos: ps[0]! };
        }
        if (hit === null) throw new Fail('no-match', path);
        lines = spliceMatched(lines, hit.pos, O, ch.body, hit.tier);
        cursor = hit.pos + nLen; // REQ-211: the cursor moves to just after the lines written
      }
    }
    const outText = joinFile({ br: model.br, lines, finalBreak: model.finalBreak });
    if (moveTo !== null) {
      tree.now.set(moveTo, outText); // REQ-212: the result is written at the new path and the old path deleted
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, outText);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1'); // REQ-181: no first non-blank line at all
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`); // REQ-180/183
  let last = -1;
  for (let t = lines.length - 1; t >= 0; t--) {
    if (!blank(lines[t])) {
      last = t;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`); // REQ-182
  const isStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) {
      i++; // REQ-186: blank lines between sections are ignored
      continue;
    }
    if (L.startsWith('*** Add File: ')) {
      const path = L.slice('*** Add File: '.length).trim(); // REQ-185
      const raw: { text: string; emptyLine: boolean }[] = [];
      let j = i + 1;
      while (j < last && !isStart(lines[j]!)) {
        const bl = lines[j]!;
        if (bl.startsWith('+')) {
          raw.push({ text: bl.slice(1), emptyLine: false });
          j++;
        } else if (bl === '') {
          raw.push({ text: '', emptyLine: true }); // REQ-189: an empty line of the file
          j++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.emptyLine) raw.pop(); // REQ-184: blank lines at the end of a section are not part of it
      const content = raw.map((r) => r.text);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path); // REQ-199
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n'); // REQ-199: the section's lines, ended by a line break
      });
      i = j;
      continue;
    }
    if (L.startsWith('*** Delete File: ')) {
      const path = L.slice('*** Delete File: '.length).trim();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path); // REQ-200
        tree.now.set(path, null);
      });
      i++; // REQ-190: a Delete File section has no lines; any body line is a parse error in the outer loop (REQ-187)
      continue;
    }
    if (L.startsWith('*** Update File: ')) {
      const path = L.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim(); // REQ-191: only as its first line
        j++;
      }
      const chunks: ChunkRec[] = [];
      let cur: ChunkRec | null = null;
      while (j < last && !isStart(lines[j]!)) {
        const bl = lines[j]!;
        if (bl.startsWith('@@')) {
          const anchorText = bl.slice(2).trim(); // REQ-193
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] }; // REQ-194: an empty text is no anchor
          chunks.push(cur);
        } else if (bl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`); // REQ-197: it ends a chunk; with no chunk open it is any other line (REQ-187)
          cur.eof = true; // REQ-197: it ends a chunk and anchors it to the end of the file
          cur = null;
        } else if (blank(bl) && cur === null) {
          // Blank spacing outside a chunk is not part of any chunk (REQ-184/186; blank is empty or only whitespace)
        } else if (bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`); // only the first chunk may start at a body line (REQ-195)
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ tag: bl === '' ? ' ' : (bl[0] as ' ' | '-' | '+'), text: bl === '' ? '' : bl.slice(1), marked: false, emptyLine: bl === '' }); // REQ-196
        } else {
          throw new Exit2(`error: parse ${j + 1}`); // REQ-187; also a `*** Move to:` that is not the first line (REQ-192)
        }
        j++;
      }
      if (chunks.length > 0) {
        const b = chunks[chunks.length - 1]!.body;
        // REQ-184: blank lines at the end of a section are not part of it — a trailing context
        // entry with empty text comes from such a blank line (an empty line or a lone space)
        while (b.length > 0 && b[b.length - 1]!.tag === ' ' && b[b.length - 1]!.text === '') b.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`); // REQ-198
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`); // REQ-187: any other line
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // REQ-054..056: a successful move whose old path existed before the patch and is
  // gone after it, and whose new path did not exist before and does after it, is
  // one R line replacing the pair's D and A lines, sorting by <new> (AMB-09: the
  // conditions are judged on the tree before the patch vs after the whole patch).
  const rByNew = new Map<string, string>();
  const rOlds = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (rOlds.has(o) || rByNew.has(n)) continue;
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && (tree.now.get(n) ?? null) !== null) {
      rByNew.set(n, o);
      rOlds.add(o);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    if (rOlds.has(p) || rByNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue; // REQ-057: a file whose bytes are unchanged is not listed
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` }); // REQ-051..053
  }
  for (const [n, o] of rByNew) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key))); // REQ-049: byte order of the paths (UTF-8)
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || check) continue; // REQ-016/017: --check writes nothing
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true }); // REQ-065: directories are created as files need them
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] }; // REQ-050/058
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
