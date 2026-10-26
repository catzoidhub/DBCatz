/**
 * Pretty views of stored values: JSON, PHP `serialize()` output (Laravel
 * jobs, cache entries, sessions) and JSON that holds such strings inside
 * (queue payloads). Rendered as highlighted HTML with the `hl-*` classes;
 * objects show their class name before the braces.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls: string, s: string) => `<span class="hl-${cls}">${esc(s)}</span>`;

/** A PHP object: class + properties (visibility stripped from the names). */
export class PhpObject {
  constructor(
    public cls: string,
    public props: [string, unknown][],
  ) {}
}
/** A PHP array (ordered, string or integer keys). */
export class PhpArray {
  constructor(public entries: [string | number, unknown][]) {}
}

const PHP_START = /^(?:[sibdN]:|a:\d+:\{|O:\d+:"|C:\d+:")/;
/** A fully qualified PHP class name, optionally with @method (Laravel's job / listener names). */
const PHP_CLASS = /^\\?[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)+(?:@[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Parses PHP serialize() text; null when it is not one (lengths are UTF-8 byte counts). */
export function phpUnserialize(text: string): unknown {
  if (!PHP_START.test(text)) return null;
  const bytes = new TextEncoder().encode(text);
  const dec = new TextDecoder();
  let i = 0;
  const ch = () => String.fromCharCode(bytes[i]);
  const expect = (c: string) => {
    if (ch() !== c) throw new Error(`expected ${c} at ${i}`);
    i++;
  };
  const readUntil = (c: string) => {
    const start = i;
    while (i < bytes.length && String.fromCharCode(bytes[i]) !== c) i++;
    const s = dec.decode(bytes.subarray(start, i));
    i++; // the delimiter
    return s;
  };
  const readString = () => {
    const len = Number(readUntil(':'));
    expect('"');
    const s = dec.decode(bytes.subarray(i, i + len));
    i += len;
    expect('"');
    return s;
  };
  const value = (): unknown => {
    const t = ch();
    i += 2; // type and ':'
    switch (t) {
      case 'N':
        return null; // N; (the ';' was skipped as ':')
      case 'b': {
        const v = readUntil(';');
        return v === '1';
      }
      case 'i':
        return Number(readUntil(';'));
      case 'd': {
        const v = readUntil(';');
        return v === 'INF' ? Infinity : v === '-INF' ? -Infinity : v === 'NAN' ? NaN : Number(v);
      }
      case 's': {
        const s = readString();
        expect(';');
        return s;
      }
      case 'a': {
        const n = Number(readUntil(':'));
        expect('{');
        const entries: [string | number, unknown][] = [];
        for (let k = 0; k < n; k++) {
          const key = value() as string | number;
          entries.push([key, value()]);
        }
        expect('}');
        return new PhpArray(entries);
      }
      case 'O': {
        const cls = readString();
        expect(':');
        const n = Number(readUntil(':'));
        expect('{');
        const props: [string, unknown][] = [];
        for (let k = 0; k < n; k++) {
          const raw = String(value());
          // "\0*\0name" = protected, "\0Class\0name" = private.
          const name = raw.startsWith('\0') ? raw.slice(raw.indexOf('\0', 1) + 1) : raw;
          props.push([name, value()]);
        }
        expect('}');
        return new PhpObject(cls, props);
      }
      case 'C': {
        // Custom serialized class: C:len:"Class":len:{data}
        const cls = readString();
        expect(':');
        const len = Number(readUntil(':'));
        expect('{');
        const data = dec.decode(bytes.subarray(i, i + len));
        i += len;
        expect('}');
        return new PhpObject(cls, [['(serialized)', data]]);
      }
      default:
        throw new Error(`unknown type ${t}`);
    }
  };
  try {
    const v = value();
    if (i !== bytes.length) return null;
    return v;
  } catch {
    return null;
  }
}

const looksJson = (s: string) => /^\s*[{[]/.test(s);
const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** What a stored string is: a structure to show, or nothing special. `php` false ignores serialize() output. */
export function structured(text: string, php = true): { kind: 'json' | 'php'; value: unknown } | null {
  if (looksJson(text)) {
    const v = parseJson(text);
    if (v !== undefined && typeof v === 'object') return { kind: 'json', value: v };
  }
  if (!php) return null;
  const p = phpUnserialize(text);
  if (p !== null && (p instanceof PhpObject || p instanceof PhpArray)) return { kind: 'php', value: p };
  return null;
}

/** True when a JSON value has strings inside that hold PHP serialized data or JSON (so Formatted expands them). */
export function hasNested(v: unknown): boolean {
  if (typeof v === 'string') return (looksJson(v) && parseJson(v) !== undefined && typeof parseJson(v) === 'object') || phpUnserialize(v) !== null;
  if (Array.isArray(v)) return v.some(hasNested);
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasNested);
  return false;
}

/**
 * Highlighted, indented HTML of a JSON / PHP value. With `php` (default),
 * nested serialized strings are expanded with a marker and backslashes in
 * strings are shown as they are (class names read `App\Jobs\X`); without it,
 * plain JSON: strings JSON-escaped, nothing interpreted.
 */
export function renderPretty(v: unknown, indent = 0, depth = 0, php = true): string {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  const br = (b: string) => `<span class="hl-br hl-br-${depth % 3}">${b}</span>`;
  if (v === null || v === undefined) return span('const', 'null');
  if (typeof v === 'boolean') return span('const', String(v));
  if (typeof v === 'number') return span('num', Number.isFinite(v) ? String(v) : v > 0 ? 'INF' : v < 0 ? '-INF' : 'NAN');
  if (typeof v === 'string') {
    const nested = php ? structured(v, true) : null;
    if (nested) return `${span('cmt', nested.kind === 'php' ? '⟨php⟩ ' : '⟨json⟩ ')}${renderPretty(nested.value, indent, depth, php)}`;
    // A PHP class name (App\Jobs\X, or Class@method): shown plainly with the same ⟨php⟩ marker.
    if (php && PHP_CLASS.test(v)) return `${span('cmt', '⟨php⟩ ')}${span('type', JSON.stringify(v).replace(/\\\\/g, '\\'))}`;
    return span('str', JSON.stringify(v));
  }
  if (v instanceof PhpObject) {
    if (!v.props.length) return `${span('type', v.cls)} ${br('{')}${br('}')}`;
    return `${span('type', v.cls)} ${br('{')}\n${v.props.map(([k, x]) => `${inner}${span('key', JSON.stringify(k))}${span('punct', ':')} ${renderPretty(x, indent + 1, depth + 1, php)}`).join(`${span('punct', ',')}\n`)}\n${pad}${br('}')}`;
  }
  if (v instanceof PhpArray) {
    const list = v.entries.every(([k], idx) => k === idx);
    if (!v.entries.length) return `${br('[')}${br(']')}`;
    if (list) return `${br('[')}\n${v.entries.map(([, x]) => `${inner}${renderPretty(x, indent + 1, depth + 1, php)}`).join(`${span('punct', ',')}\n`)}\n${pad}${br(']')}`;
    return `${br('{')}\n${v.entries.map(([k, x]) => `${inner}${span('key', JSON.stringify(String(k)))}${span('punct', ':')} ${renderPretty(x, indent + 1, depth + 1, php)}`).join(`${span('punct', ',')}\n`)}\n${pad}${br('}')}`;
  }
  if (Array.isArray(v)) {
    if (!v.length) return `${br('[')}${br(']')}`;
    return `${br('[')}\n${v.map((x) => `${inner}${renderPretty(x, indent + 1, depth + 1, php)}`).join(`${span('punct', ',')}\n`)}\n${pad}${br(']')}`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return `${br('{')}${br('}')}`;
  return `${br('{')}\n${entries.map(([k, x]) => `${inner}${span('key', JSON.stringify(k))}${span('punct', ':')} ${renderPretty(x, indent + 1, depth + 1, php)}`).join(`${span('punct', ',')}\n`)}\n${pad}${br('}')}`;
}

/** Formatted HTML for a stored string, or null when it is plain text. */
export function prettyHtml(text: string, php = true): { html: string; kind: 'json' | 'php' } | null {
  const s = structured(text, php);
  return s ? { html: renderPretty(s.value, 0, 0, php), kind: s.kind } : null;
}

/** The PHP toggle of the Formatted view, remembered per Mac. */
export function phpPref(): boolean {
  try {
    return localStorage.getItem('dbcatz.php') !== 'off';
  } catch {
    return true;
  }
}
export function setPhpPref(on: boolean): void {
  try {
    localStorage.setItem('dbcatz.php', on ? 'on' : 'off');
  } catch {
    /* private mode */
  }
}
