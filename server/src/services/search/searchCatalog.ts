export interface SearchCatalog {
  areas: { id: number; name: string }[];
  amenities: { name: string }[];
}

// Aliases resolve only to records present in the current database catalog.
const aliases: Record<string, string[]> = {
  Azimpur: ["আজিমপুর"], Dhanmondi: ["ধানমন্ডি", "dhanmondy"],
  Mohammadpur: ["মোহাম্মদপুর", "mohammedpur", "mohammad pur"],
  Gulshan: ["গুলশান"], Banani: ["বনানী", "বনানি"], Mirpur: ["মিরপুর"],
  Khilkhet: ["খিলক্ষেত"], Uttara: ["উত্তরা"], Bashundhara: ["বসুন্ধরা", "boshundhara", "bashundhara r/a"],
  Tejgaon: ["তেজগাঁও", "তেজগাও"], Lalbagh: ["লালবাগ"], Badda: ["বাড্ডা"],
  Elevator: ["lift", "লিফট"], Garage: ["parking", "car parking", "পার্কিং", "গ্যারেজ"],
  "Generator Backup": ["generator", "জেনারেটর"], "Gas Line": ["piped gas", "gas connection", "গ্যাস লাইন"],
  "Rooftop Access": ["rooftop", "ছাদ"], "Security Guard": ["security", "দারোয়ান", "নিরাপত্তা প্রহরী"],
  "Swimming Pool": ["pool", "সুইমিং পুল"], Gym: ["জিম"], "Internet Ready": ["broadband ready", "internet ready"],
};

export function normalizeCatalogText(text: string) {
  return text.normalize("NFKC").toLocaleLowerCase("en").replace(/[\s\p{P}]/gu, "");
}

export function canonicalAlias(text: string) {
  const normalized = normalizeCatalogText(text);
  return Object.entries(aliases).find(([name, values]) =>
    [name, ...values].some(value => normalizeCatalogText(value) === normalized))?.[0] ?? text;
}

function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}

export function resolveCatalogValue<T extends { name: string }>(text: string, records: T[], fuzzy = false): T | undefined {
  const needle = normalizeCatalogText(canonicalAlias(text));
  const exact = records.find(row => normalizeCatalogText(row.name) === needle);
  if (exact || !fuzzy || needle.length < 5) return exact;
  const candidates = records.filter(row => distance(needle, normalizeCatalogText(row.name)) <= (needle.length >= 8 ? 2 : 1));
  return candidates.length === 1 ? candidates[0] : undefined;
}
