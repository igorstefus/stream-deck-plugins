/** Key images as SVG data URLs (144 x 144, the @2x size for 72 px keys). */

const TILE = "#1c1c1e";
const TEXT = "#f2f2f2";
const MUTED = "#8e8e93";
const ACCENT = "#d9a441";
export const GREEN = "#4caf50";
export const RED = "#ef5350";

export type Glyph = "play" | "pause" | "playpause" | "next" | "previous" | "stop" | "link" | "unlink" | "volumeUp" | "volumeDown" | "mute" | "speaker";

export interface KeyImageOptions {
  /** Main text (speaker name or "All"), wrapped to two lines. */
  title: string;
  /** Small line under the title (volume, group size, error). */
  subtitle?: string;
  glyph: Glyph;
  /** Glyph colour; default light grey. */
  glyphColor?: string;
  /** Colour of the state bar at the top; omitted = no bar. */
  bar?: string;
  /** Grey everything out (no speaker chosen, speaker unreachable). */
  dim?: boolean;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Splits into at most two lines of roughly `max` characters, breaking on spaces. */
function wrap(text: string, max: number): string[] {
  const clean = text.trim();
  if (clean.length <= max) {
    return [clean];
  }
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (current && (current + " " + w).length > max) {
      lines.push(current);
      current = w;
    } else {
      current = current ? current + " " + w : w;
    }
    if (lines.length === 2) break;
  }
  if (lines.length < 2 && current) lines.push(current);
  if (lines.length > 2 || (lines.length === 2 && current && lines[1] !== current)) {
    lines.length = 2;
    lines[1] = lines[1].slice(0, max - 1) + "…";
  }
  return lines.map((l) => (l.length > max + 2 ? l.slice(0, max + 1) + "…" : l));
}

/** Glyphs are drawn in a 64 x 64 box centred at (72, 50). */
function glyphSvg(glyph: Glyph, color: string): string {
  const stroke = `fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"`;
  switch (glyph) {
    case "play":
      return `<path d="M52 22 L104 50 L52 78 Z" fill="${color}"/>`;
    case "pause":
      return `<rect x="46" y="22" width="18" height="56" rx="4" fill="${color}"/><rect x="80" y="22" width="18" height="56" rx="4" fill="${color}"/>`;
    case "playpause":
      return `<path d="M34 24 L74 50 L34 76 Z" fill="${color}"/><rect x="86" y="24" width="11" height="52" rx="3" fill="${color}"/><rect x="104" y="24" width="11" height="52" rx="3" fill="${color}"/>`;
    case "stop":
      return `<rect x="46" y="24" width="52" height="52" rx="6" fill="${color}"/>`;
    case "next":
      return `<path d="M38 24 L80 50 L38 76 Z" fill="${color}"/><rect x="88" y="24" width="12" height="52" rx="3" fill="${color}"/>`;
    case "previous":
      return `<path d="M106 24 L64 50 L106 76 Z" fill="${color}"/><rect x="44" y="24" width="12" height="52" rx="3" fill="${color}"/>`;
    case "link":
      return (
        `<g ${stroke}><path d="M62 64 L82 36"/>` +
        `<path d="M58 44 L50 55 a14 14 0 0 0 20 20 l8 -11"/><path d="M86 56 L94 45 a14 14 0 0 0 -20 -20 l-8 11"/></g>`
      );
    case "unlink":
      return (
        `<g ${stroke}><path d="M58 44 L50 55 a14 14 0 0 0 20 20 l8 -11"/><path d="M86 56 L94 45 a14 14 0 0 0 -20 -20 l-8 11"/>` +
        `<path d="M44 32 L36 24 M100 68 L108 76" stroke="${RED}"/></g>`
      );
    case "volumeUp":
      return (
        `<path d="M40 40 H54 L70 26 V74 L54 60 H40 Z" fill="${color}"/>` +
        `<g ${stroke}><path d="M84 38 a18 18 0 0 1 0 24"/><path d="M96 28 a32 32 0 0 1 0 44"/></g>`
      );
    case "volumeDown":
      return (
        `<path d="M40 40 H54 L70 26 V74 L54 60 H40 Z" fill="${color}"/>` +
        `<g ${stroke}><path d="M84 38 a18 18 0 0 1 0 24"/></g>`
      );
    case "mute":
      return (
        `<path d="M40 40 H54 L70 26 V74 L54 60 H40 Z" fill="${color}"/>` +
        `<g ${stroke}><path d="M84 40 l20 20 M104 40 l-20 20"/></g>`
      );
    case "speaker":
    default:
      return `<rect x="48" y="18" width="48" height="64" rx="8" ${stroke}/><circle cx="72" cy="58" r="12" ${stroke}/><circle cx="72" cy="32" r="4" fill="${color}"/>`;
  }
}

export function keyImage(o: KeyImageOptions): string {
  const text = o.dim ? MUTED : TEXT;
  const glyphColor = o.dim ? MUTED : (o.glyphColor ?? TEXT);
  const lines = wrap(o.title, 11);
  const titleSize = lines.some((l) => l.length > 8) ? 18 : 22;
  const titleY = o.subtitle ? 100 : lines.length === 2 ? 102 : 112;
  const title = lines
    .map((l, i) => `<text x="72" y="${titleY + i * (titleSize + 2)}" font-size="${titleSize}" font-weight="600" fill="${text}" text-anchor="middle">${esc(l)}</text>`)
    .join("");
  const subtitle = o.subtitle
    ? `<text x="72" y="${titleY + lines.length * (titleSize + 2) + 2}" font-size="15" fill="${o.dim ? MUTED : ACCENT}" text-anchor="middle">${esc(o.subtitle)}</text>`
    : "";
  const bar = o.bar && !o.dim ? `<rect x="24" y="8" width="96" height="6" rx="3" fill="${o.bar}"/>` : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" font-family="Segoe UI, Helvetica, Arial, sans-serif">` +
    `<rect width="144" height="144" rx="20" fill="${TILE}"/>` +
    bar +
    glyphSvg(o.glyph, glyphColor) +
    title +
    subtitle +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
