import { renderSiteDraft, slugify, type DraftLead } from "./site-draft.js";

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

const FULL_LEAD: DraftLead = {
  title: "Fake Salon Bandra",
  address: "12 Fake Street, Bandra West, Mumbai",
  phone: "9820012345",
  rating: 4.5,
  ratings: 120,
  category: "Beauty salon",
  area: "Bandra West",
};

const html = renderSiteDraft(FULL_LEAD);

check("output starts with <!doctype html>", html.startsWith("<!doctype html>"));
check(
  "has a <title> containing the business name",
  html.includes("<title>") && html.includes("Fake Salon Bandra</title>"),
  html.match(/<title>[^]*?<\/title>/)?.[0] ?? "no title tag"
);
check(
  "has a viewport meta tag",
  html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">')
);

const hostileHtml = renderSiteDraft({ ...FULL_LEAD, title: "<img src=x onerror=alert(1)>" });
check(
  "hostile name appears only escaped",
  !hostileHtml.includes("<img") &&
    hostileHtml.includes("&lt;img src=x onerror=alert(1)&gt;") &&
    hostileHtml.includes("<title>&lt;img src=x onerror=alert(1)&gt;</title>"),
  hostileHtml.includes("<img") ? "raw <img found" : "escaped form found"
);

check(
  "10-digit phone gives wa.me/91XXXXXXXXXX",
  html.includes("https://wa.me/919820012345"),
  html.match(/https:\/\/wa\.me\/[0-9]*/)?.[0] ?? "no wa.me link"
);
check(
  "+91 98200 12345 gives wa.me/919820012345",
  renderSiteDraft({ ...FULL_LEAD, phone: "+91 98200 12345" }).includes("https://wa.me/919820012345")
);
check(
  "WhatsApp greeting is url-encoded",
  html.includes("text=Hi%2C%20I%20would%20like%20to%20book%20an%20appointment")
);
check("phone is rendered as a tel: link", html.includes('href="tel:9820012345"'));

const noPhoneHtml = renderSiteDraft({
  title: "Fake No Phone Cafe",
  category: "Cafe",
  area: "Fake Area",
});
check(
  "no phone means no WhatsApp button and no tel: link",
  !noPhoneHtml.includes("wa.me") &&
    !noPhoneHtml.includes("tel:") &&
    !noPhoneHtml.includes("Book on WhatsApp")
);

check(
  "rating line appears when both rating and ratings are numeric",
  html.includes("Rated 4.5 on Google from 120 reviews")
);
check(
  "rating line absent when ratings is missing",
  !renderSiteDraft({ ...FULL_LEAD, ratings: undefined }).includes("Rated ")
);
check(
  "rating line absent when rating is missing",
  !renderSiteDraft({ ...FULL_LEAD, rating: undefined }).includes("Rated ")
);
check(
  "rating line absent when ratings is not numeric",
  !renderSiteDraft({ ...FULL_LEAD, ratings: "many" }).includes("Rated ")
);
check(
  "rating line absent when rating is not numeric",
  !renderSiteDraft({ ...FULL_LEAD, rating: "great" }).includes("Rated ")
);

const urls = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
check(
  "every http URL is https://wa.me/ or https://www.google.com/maps/",
  urls.length > 0 &&
    urls.every(
      (u) => u.startsWith("https://wa.me/") || u.startsWith("https://www.google.com/maps/")
    ),
  urls.length > 0 ? urls.join(", ") : "no URLs found"
);
check(
  "no src attributes, no <script, no <link",
  !html.includes("src=") && !html.includes("<script") && !html.includes("<link")
);
check("map link uses the google maps search endpoint", html.includes("https://www.google.com/maps/search/?api=1&query="));

check(
  'services heading contains "to be confirmed with the owner"',
  html.includes("Example services (to be confirmed with the owner)")
);

const salonHtml = renderSiteDraft({ ...FULL_LEAD, title: "Fake Salon Bandra" });
const gymHtml = renderSiteDraft({
  title: "Fake Gym Andheri",
  address: "3 Fake Road, Andheri West, Mumbai",
  phone: "9820098765",
  rating: 4.2,
  ratings: 80,
  category: "Gym and fitness",
  area: "Andheri West",
});
check(
  "salon category maps to the salon service list",
  salonHtml.includes("Haircut and styling") &&
    salonHtml.includes("Manicure and pedicure") &&
    !salonHtml.includes("Personal training sessions")
);
check(
  "gym category maps to the gym service list",
  gymHtml.includes("Personal training sessions") &&
    gymHtml.includes("Group fitness classes") &&
    !gymHtml.includes("Haircut and styling")
);

check('slugify("Tip & Toe!!") is tip-toe', slugify("Tip & Toe!!") === "tip-toe", slugify("Tip & Toe!!"));
check('slugify("") is business', slugify("") === "business", slugify(""));

const soloHtml = renderSiteDraft({ title: "Solo Fake Title" });
check(
  "lead with only a title renders a valid page",
  soloHtml.startsWith("<!doctype html>") &&
    soloHtml.includes("<title>Solo Fake Title</title>") &&
    soloHtml.includes('<meta name="viewport" content="width=device-width, initial-scale=1">') &&
    soloHtml.includes("<h1>Solo Fake Title</h1>") &&
    soloHtml.includes("<footer>Draft prepared for Solo Fake Title.")
);

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
