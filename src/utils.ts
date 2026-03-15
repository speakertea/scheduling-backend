const HTML_TAGS = /<[^>]*>/g;
const NULL_BYTES = /\0/g;

function sanitize(input: string, maxLength: number): string {
  return input
    .replace(NULL_BYTES, "")
    .replace(HTML_TAGS, "")
    .trim()
    .slice(0, maxLength);
}

export const sanitizeTitle    = (s: string) => sanitize(s, 200);
export const sanitizeLocation = (s: string) => sanitize(s, 500);
export const sanitizeNotes    = (s: string) => sanitize(s, 2000);
export const sanitizeName     = (s: string) => sanitize(s, 100);
export const sanitizeEmail    = (s: string) =>
  s.replace(NULL_BYTES, "").trim().toLowerCase().slice(0, 254);
