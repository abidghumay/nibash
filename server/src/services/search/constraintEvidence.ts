// Conservative semantic checks complement structured output: ambiguity is reported,
// never converted into a weaker constraint. These are guards, not a replacement search parser.
function context(query: string, evidence: string) {
  const fold = (text: string) => text.toLowerCase().replace(/[০-৯]/g, digit => String("০১২৩৪৫৬৭৮৯".indexOf(digit)));
  const index = fold(query).indexOf(fold(evidence));
  return { before: query.slice(Math.max(0, index - 45), index).toLowerCase(),
    after: query.slice(index + evidence.length, index + evidence.length + 45).toLowerCase(),
    evidence: evidence.toLowerCase() };
}

export function isExplicitPreference(query: string, evidence: string) {
  const c = context(query, evidence);
  const prefix = /(?:prefer|preferably|optional|nice to have|পছন্দ|সম্ভব হলে)\s*(?:an?\s*)?$/i;
  const suffix = /^\s*(?:is\s+)?(?:preferred|optional|would be nice|হলে ভালো|থাকলে ভালো|thakle bhalo|hole bhalo)/i;
  return prefix.test(c.before) || suffix.test(c.after) ||
    /^(?:prefer|preferably|optional|nice to have|সম্ভব হলে)\s/i.test(evidence) ||
    /(?:preferred|optional|হলে ভালো|থাকলে ভালো|thakle bhalo)\s*$/i.test(evidence);
}

export function semanticConflict(query: string, field: string, evidence: string, value: string): boolean {
  const c = context(query, evidence);
  const text = `${c.before.split(/\band\b|[,;]/).at(-1)}${c.evidence}${c.after.split(/\band\b|[,;]/)[0]}`;
  if (field === "amenity" || field === "area") {
    const prefix = `${c.before}${c.evidence}`;
    if (/(?:without|must not have|not with|no|not in|except|excluding)\s*(?:a\s*)?$/i.test(c.before) ||
        /^(?:without|no|not in|excluding)\s/i.test(c.evidence) ||
        /^\s*(?:ছাড়া|ছাড়া|নেই|বাদে|chara|chhara)/i.test(c.after) ||
        /(?:ছাড়া|ছাড়া|বাদে)\s*$/i.test(prefix)) return true;
  }
  if (field === "minBedrooms" || field === "bedrooms") {
    const minimum = /(?:at least|minimum|min|কমপক্ষে|অন্তত|কম করে|kompokkh[eoa]|ontoto)\s*(?:\d+|[০-৯]+|three|two|one|তিন|দুই|এক|tin|dui)\s*(?:bed|bhk|br\b|বেড|শোবার)/i.test(text) ||
      /(?:\d+|[০-৯]+)\s*\+\s*(?:bed|বেড)/i.test(text);
    return field === "minBedrooms" ? !minimum : minimum;
  }
  if (field === "pets") {
    const policy = `${c.before.slice(-15)}${c.evidence}${c.after.slice(0, 20)}`;
    const negative = /no\s+pets?|pets?.{0,12}(?:not allowed|not permitted|forbidden)|পোষা.{0,15}(?:যাবে না|নিষেধ)|(?:বিড়াল|কুকুর).{0,15}যাবে না|pet.{0,12}(?:na|no)\b/i.test(policy);
    const positive = /pets?.{0,20}(?:allowed|friendly|ok|permitted)|(?:পোষা|বিড়াল|কুকুর).{0,20}(?:যাবে|অনুমতি)|(?:biral|kukur).{0,20}(?:jabe|allowed)/i.test(policy);
    return negative ? value !== "false" : !positive || value !== "true";
  }
  if (field === "minRent" || field === "maxRent") {
    // Evidence may include the operator, but must identify a single amount.
    const amounts = Array.from(c.evidence.matchAll(/[\d০-৯][\d০-৯,]*(?:\.[\d০-৯]+)?\s*(?:thousand|hajar|hazar|হাজার|lakh|lac|লাখ|লক্ষ|k\b)?/gi));
    if (amounts.length !== 1) return true;
    const amount = amounts[0];
    c.before += c.evidence.slice(0, amount.index);
    c.after = c.evidence.slice(amount.index! + amount[0].length) + c.after;
    // Range position takes precedence over a nearby upper/lower operator.
    const rangeBefore = /(?:between|from)\s*(?:BDT|tk|৳)?\s*$/i.test(c.before);
    const rangeAfter = /^\s*(?:টাকা|taka)?\s*(?:and|to|থেকে|theke|[-–])/i.test(c.after);
    const upperRange = /(?:and|to|থেকে|theke|[-–])\s*(?:BDT|tk|৳)?\s*$/i.test(c.before) && /\d|[০-৯]/.test(c.before);
    if (rangeBefore || rangeAfter) return field !== "minRent";
    if (upperRange) return field !== "maxRent";
    const low = /(?:above|over|at least|minimum|min|বেশি|কমপক্ষে|অন্তত)\s*(?:rent\s*)?(?:BDT|tk|৳)?\s*$/i.test(c.before) || /^\s*(?:টাকা|taka)?\s*(?:এর\s*)?(?:বেশি|উপরে|থেকে বেশি|er beshi)/i.test(c.after);
    const high = /(?:under|below|up to|at most|maximum|max|budget|within)\s*(?:rent\s*)?(?:BDT|tk|৳)?\s*$/i.test(c.before) || /^\s*(?:টাকা|taka)?\s*(?:এর\s*)?(?:মধ্যে|নিচে|কম|er moddhe|er niche)/i.test(c.after);
    return low ? field !== "minRent" : high ? field !== "maxRent" : false;
  }
  return false;
}
