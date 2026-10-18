# Quality fixtures for dossier checks
cases.json holds 12 fake business cases for quality tests.
Each case has id, kind, business, pages, truth, adversarial.
business holds name, city, category, phone, website.
pages holds url, title, text with 80 to 250 words.
truth.facts holds claim plus quote copied from page text.
truth.absent lists claim kinds the pages do not support.
A dossier that states an absent kind is invented.
adversarial true marks injection, fake count, Hindi, thin cases.
Run node verify-cases.mjs to check quotes match page text.
