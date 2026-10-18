export type DraftLead = {
  title: string;
  address?: string;
  phone?: string;
  rating?: string | number;
  ratings?: string | number;
  category?: string;
  area?: string;
};

const ACCENT_COLOR = "#0b5cd5";
const PAGE_BG = "#ffffff";
const TEXT_COLOR = "#1f2933";
const MUTED_COLOR = "#52606d";
const FOOTER_TEXT_COLOR = "#52606d";
const FOOTER_BG = "#f3f4f6";
const BANNER_BG = "#0b5cd5";
const BANNER_TEXT_COLOR = "#ffffff";
const BUTTON_BG = "#0b5cd5";
const BUTTON_TEXT_COLOR = "#ffffff";
const BORDER_COLOR = "#e5e7eb";
const DRAFT_BANNER_TEXT = "Draft preview, not published";
const SERVICES_HEADING = "Example services (to be confirmed with the owner)";
const WHATSAPP_GREETING = "Hi, I would like to book an appointment";
const WHATSAPP_BASE = "https://wa.me/";
const MAPS_BASE = "https://www.google.com/maps/search/?api=1&query=";
const COUNTRY_CODE = "91";
const LOCAL_PHONE_DIGITS = 10;
const FULL_PHONE_DIGITS = 12;
const SLUG_FALLBACK = "business";

const SERVICE_GROUPS: { words: string[]; services: string[] }[] = [
  {
    words: ["salon", "beauty", "parlour"],
    services: [
      "Haircut and styling",
      "Hair colouring and highlights",
      "Facial and cleanup",
      "Manicure and pedicure",
      "Bridal makeup packages",
    ],
  },
  {
    words: ["gym", "fitness"],
    services: [
      "Gym membership",
      "Personal training sessions",
      "Group fitness classes",
      "Diet and nutrition planning",
    ],
  },
  {
    words: ["coaching", "tuition", "classes"],
    services: [
      "One-on-one tutoring",
      "Group coaching batches",
      "Exam preparation courses",
      "Online and offline classes",
    ],
  },
  {
    words: ["restaurant", "cafe"],
    services: [
      "Dine-in and takeaway",
      "Home delivery",
      "Catering for events",
      "Party and function bookings",
    ],
  },
  {
    words: ["repair", "service"],
    services: [
      "Walk-in and doorstep diagnosis",
      "Same-day repair",
      "Annual maintenance contract",
      "Spare parts and accessories",
    ],
  },
];

const DEFAULT_SERVICES = [
  "Products and services offered",
  "Pricing and packages",
  "Timings and availability",
  "Home visits, if offered",
];

const PAGE_CSS =
  ":root{color-scheme:light;}" +
  "*{box-sizing:border-box;}" +
  "body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;background:" +
  PAGE_BG +
  ";color:" +
  TEXT_COLOR +
  ";line-height:1.5;}" +
  ".banner{background:" +
  BANNER_BG +
  ";color:" +
  BANNER_TEXT_COLOR +
  ";text-align:center;padding:6px 12px;font-size:13px;}" +
  "main{padding:16px;max-width:640px;margin:0 auto;}" +
  "h1{font-size:24px;margin:8px 0 4px;}" +
  "h2{font-size:17px;margin:24px 0 8px;color:" +
  ACCENT_COLOR +
  ";}" +
  ".tagline,.rating{color:" +
  MUTED_COLOR +
  ";margin:0 0 8px;}" +
  "ul{padding-left:20px;}" +
  "li{margin:4px 0;}" +
  "a{color:" +
  ACCENT_COLOR +
  ";}" +
  ".whatsapp{display:inline-block;background:" +
  BUTTON_BG +
  ";color:" +
  BUTTON_TEXT_COLOR +
  ";padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;}" +
  ".maplink{color:" +
  ACCENT_COLOR +
  ";font-weight:600;}" +
  "footer{border-top:1px solid " +
  BORDER_COLOR +
  ";background:" +
  FOOTER_BG +
  ";color:" +
  FOOTER_TEXT_COLOR +
  ";font-size:13px;text-align:center;padding:12px;}";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isNumeric(value: string | number | undefined): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && Number.isFinite(Number(trimmed));
}

function waDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === LOCAL_PHONE_DIGITS) return COUNTRY_CODE + digits;
  if (digits.length === FULL_PHONE_DIGITS && digits.startsWith(COUNTRY_CODE)) return digits;
  return digits;
}

function servicesFor(category: string | undefined): string[] {
  if (category !== undefined && category.length > 0) {
    const lower = category.toLowerCase();
    const group = SERVICE_GROUPS.find((g) => g.words.some((w) => lower.includes(w)));
    if (group) return group.services;
  }
  return DEFAULT_SERVICES;
}

function aboutLine(title: string, category: string, area: string): string {
  if (category.length > 0 && area.length > 0)
    return title + " is a " + category + " in " + area + ".";
  if (category.length > 0) return title + " is a " + category + ".";
  if (area.length > 0) return title + " is in " + area + ".";
  return title + ".";
}

export function renderSiteDraft(lead: DraftLead): string {
  const escTitle = escapeHtml(lead.title);
  const category = lead.category ?? "";
  const area = lead.area ?? "";
  const address = lead.address ?? "";
  const phone = lead.phone ?? "";
  const escCategory = escapeHtml(category);
  const escArea = escapeHtml(area);
  const escAddress = escapeHtml(address);

  const taglineParts = [escCategory, escArea].filter((p) => p.length > 0);
  const tagline = taglineParts.length > 0 ? taglineParts.join(" in ") : "";

  const showRating = isNumeric(lead.rating) && isNumeric(lead.ratings);
  const ratingLine = showRating
    ? "Rated " +
      escapeHtml(String(lead.rating)) +
      " on Google from " +
      escapeHtml(String(lead.ratings)) +
      " reviews"
    : "";

  const about = aboutLine(escTitle, escCategory, escArea);

  const services = servicesFor(lead.category).map(
    (s) => "    <li>" + escapeHtml(s) + "</li>"
  );

  const contactItems: string[] = [];
  if (address.length > 0) contactItems.push("    <p>" + escAddress + "</p>");
  if (phone.length > 0)
    contactItems.push('    <p><a href="tel:' + escapeHtml(phone) + '">' + escapeHtml(phone) + "</a></p>");
  if (phone.length > 0)
    contactItems.push(
      '    <p><a class="whatsapp" href="' +
        WHATSAPP_BASE +
        waDigits(phone) +
        "?text=" +
        encodeURIComponent(WHATSAPP_GREETING) +
        '">Book on WhatsApp</a></p>'
    );

  const mapQuery =
    address.length > 0
      ? encodeURIComponent(lead.title + ", " + lead.address)
      : encodeURIComponent(lead.title);
  const mapLink = MAPS_BASE + mapQuery;

  const footer =
    "Draft prepared for " +
    escTitle +
    ". Details come from public listings and may be out of date.";

  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light">\n' +
    "<title>" +
    escTitle +
    "</title>\n" +
    "<style>" +
    PAGE_CSS +
    "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    '<div class="banner">' +
    DRAFT_BANNER_TEXT +
    "</div>\n" +
    "<main>\n" +
    "<h1>" +
    escTitle +
    "</h1>\n" +
    (tagline.length > 0 ? '<p class="tagline">' + tagline + "</p>\n" : "") +
    (ratingLine.length > 0 ? '<p class="rating">' + ratingLine + "</p>\n" : "") +
    "<h2>About</h2>\n" +
    "<p>" +
    about +
    "</p>\n" +
    "<h2>" +
    SERVICES_HEADING +
    "</h2>\n" +
    "<ul>\n" +
    services.join("\n") +
    "\n</ul>\n" +
    "<h2>Contact</h2>\n" +
    (contactItems.length > 0 ? contactItems.join("\n") + "\n" : "") +
    '<p><a class="maplink" href="' +
    mapLink +
    '">Find us on the map</a></p>\n' +
    "</main>\n" +
    "<footer>" +
    footer +
    "</footer>\n" +
    "</body>\n" +
    "</html>\n"
  );
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : SLUG_FALLBACK;
}
