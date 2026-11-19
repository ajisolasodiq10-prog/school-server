// Builds a safe "search box" filter. Every word typed must match at least one of the fields
// (case-insensitive, anywhere in the text), so "ada ok" finds "Ada Okafor". The text is
// escaped first, so a user cannot inject a regular expression into the database query.
export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function searchFilter(q, fields) {
  if (!q) return null;
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return null;
  return {
    $and: words.map((word) => {
      const pattern = new RegExp(escapeRegex(word), 'i');
      return { $or: fields.map((field) => ({ [field]: pattern })) };
    }),
  };
}
