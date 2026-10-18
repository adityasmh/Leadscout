import { renderSiteDraft, type DraftLead } from "./site-draft.js";

const BODY_MIN = 7;
const NORMAL_MIN = 4.5;
const HELPER_TOLERANCE = 1e-9;

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

type Rgb = { r: number; g: number; b: number };

function parseHex(value: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (m === null) return null;
  const digits = m[1];
  const full =
    digits.length === 3 ? digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2] : digits;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp("(?:^|[};])\\s*" + escaped + "\\s*\\{([^}]*)\\}").exec(css);
  return m === null ? null : m[1];
}

function declValue(rule: string | null, prop: string): string | null {
  if (rule === null) return null;
  const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)").exec(rule);
  return m === null ? null : m[1].trim();
}

function contrastCheck(name: string, fg: string | null, bg: string | null, min: number): void {
  const fgRgb = fg === null ? null : parseHex(fg);
  const bgRgb = bg === null ? null : parseHex(bg);
  if (fgRgb === null || bgRgb === null) {
    check(name, false, "could not resolve hex colours (fg=" + String(fg) + ", bg=" + String(bg) + ")");
    return;
  }
  const ratio = contrastRatio(fgRgb, bgRgb);
  check(name, ratio >= min, ratio.toFixed(2) + " (min " + min + ", " + fg + " on " + bg + ")");
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const THREE_DIGIT = parseHex("#fff");
const SIX_DIGIT = parseHex("#0b5cd5");
check(
  "self-test parseHex 3-digit #fff",
  THREE_DIGIT !== null && THREE_DIGIT.r === 255 && THREE_DIGIT.g === 255 && THREE_DIGIT.b === 255
);
check(
  "self-test parseHex 6-digit #0b5cd5",
  SIX_DIGIT !== null && SIX_DIGIT.r === 11 && SIX_DIGIT.g === 92 && SIX_DIGIT.b === 213
);
check("self-test parseHex rejects non-hex", parseHex("white") === null && parseHex("#12345") === null);
check(
  "self-test relativeLuminance white=1 black=0",
  Math.abs(relativeLuminance(WHITE) - 1) < HELPER_TOLERANCE &&
    Math.abs(relativeLuminance(BLACK) - 0) < HELPER_TOLERANCE
);
const bwRatio = contrastRatio(BLACK, WHITE);
check(
  "self-test contrastRatio black/white = 21",
  Math.abs(bwRatio - 21) < HELPER_TOLERANCE,
  bwRatio.toFixed(4)
);
const sameRatio = contrastRatio(WHITE, WHITE);
check(
  "self-test contrastRatio same colour = 1",
  Math.abs(sameRatio - 1) < HELPER_TOLERANCE,
  sameRatio.toFixed(4)
);

const SAMPLE_LEAD: DraftLead = {
  title: "Fake Salon Bandra",
  address: "12 Fake Street, Bandra West, Mumbai",
  phone: "9820012345",
  rating: 4.5,
  ratings: 120,
  category: "Beauty salon",
  area: "Bandra West",
};

const html = renderSiteDraft(SAMPLE_LEAD);

const styleMatch = /<style>([^]*?)<\/style>/.exec(html);
check("rendered page has a <style> element", styleMatch !== null);
const css = styleMatch === null ? "" : styleMatch[1];

const headMatch = /<head>([^]*?)<\/head>/.exec(html);
const head = headMatch === null ? "" : headMatch[1];
check(
  "color-scheme meta with content light in head",
  head.includes('<meta name="color-scheme" content="light">')
);

check("no prefers-color-scheme in CSS", !css.includes("prefers-color-scheme"));

const colourDeclRe = /(?:^|[;{])\s*(?:color|background(?:-color)?)\s*:\s*([^;}]+)/gi;
const nonHexValues: string[] = [];
let declMatch: RegExpExecArray | null = colourDeclRe.exec(css);
while (declMatch !== null) {
  const value = declMatch[1].trim();
  if (parseHex(value) === null) nonHexValues.push(value);
  declMatch = colourDeclRe.exec(css);
}
check(
  "every color/background value in CSS is 3/6-digit hex",
  nonHexValues.length === 0,
  nonHexValues.length > 0 ? "non-hex: " + nonHexValues.join(", ") : "all values hex"
);

const bodyRule = ruleBody(css, "body");
const bodyBg = declValue(bodyRule, "background");
const bodyColor = declValue(bodyRule, "color");
check(
  "body declares hex background and hex color",
  bodyBg !== null && bodyColor !== null && parseHex(bodyBg) !== null && parseHex(bodyColor) !== null,
  "background=" + String(bodyBg) + " color=" + String(bodyColor)
);

const mutedColor = declValue(ruleBody(css, ".tagline,.rating"), "color");
const footerRule = ruleBody(css, "footer");
const linkColor = declValue(ruleBody(css, "a"), "color") ?? declValue(ruleBody(css, ".maplink"), "color");
const whatsappRule = ruleBody(css, ".whatsapp");
const bannerRule = ruleBody(css, ".banner");

contrastCheck("contrast body text on page bg >= 7", bodyColor, bodyBg, BODY_MIN);
contrastCheck(
  "contrast muted (.tagline,.rating) on page bg >= 4.5",
  mutedColor,
  bodyBg,
  NORMAL_MIN
);
contrastCheck(
  "contrast footer text on footer bg >= 4.5",
  declValue(footerRule, "color"),
  declValue(footerRule, "background"),
  NORMAL_MIN
);
contrastCheck("contrast link (a/.maplink) on page bg >= 4.5", linkColor, bodyBg, NORMAL_MIN);
contrastCheck(
  "contrast .whatsapp text on .whatsapp bg >= 4.5",
  declValue(whatsappRule, "color"),
  declValue(whatsappRule, "background"),
  NORMAL_MIN
);
contrastCheck(
  "contrast .banner text on .banner bg >= 4.5",
  declValue(bannerRule, "color"),
  declValue(bannerRule, "background"),
  NORMAL_MIN
);

const withoutStyle = html.replace(/<style>[^]*?<\/style>/, "");
const visibleText = withoutStyle.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const expectedTexts = [
  SAMPLE_LEAD.title,
  "About",
  "Example services (to be confirmed with the owner)",
  "Haircut and styling",
  "Contact",
];
for (const expected of expectedTexts) {
  check('text sanity: visible text contains "' + expected + '"', visibleText.includes(expected));
}

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
