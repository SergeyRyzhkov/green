export interface TextMatch {
  start: number;
  end: number;
  quote: string;
}

function normalizeChar(char: string): string {
  return char.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

function normalizedLetters(value: string): string {
  return Array.from(value)
    .filter((char) => /[\p{L}\p{N}]/u.test(char))
    .map(normalizeChar)
    .join("");
}

export function findQuoteMatches(source: string, quote: string): TextMatch[] {
  if (quote.trim().length < 8) {
    return [];
  }

  const exactMatches: TextMatch[] = [];
  let from = 0;

  while (from < source.length) {
    const start = source.indexOf(quote, from);

    if (start < 0) {
      break;
    }

    exactMatches.push({
      start,
      end: start + quote.length,
      quote: source.slice(start, start + quote.length),
    });

    from = start + 1;
  }

  if (exactMatches.length > 0) {
    return exactMatches;
  }

  const sourceChars: string[] = [];
  const sourceOffsets: number[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (!/[\p{L}\p{N}]/u.test(char)) {
      continue;
    }

    for (const normalizedChar of normalizeChar(char)) {
      sourceChars.push(normalizedChar);
      sourceOffsets.push(i);
    }
  }

  const normalizedSource = sourceChars.join("");
  const normalizedQuote = normalizedLetters(quote);

  if (normalizedQuote.length < 8) {
    return [];
  }

  const matches: TextMatch[] = [];
  let searchFrom = 0;

  while (searchFrom < normalizedSource.length) {
    const index = normalizedSource.indexOf(normalizedQuote, searchFrom);

    if (index < 0) {
      break;
    }

    const start = sourceOffsets[index];
    const end = sourceOffsets[index + normalizedQuote.length - 1] + 1;

    matches.push({
      start,
      end,
      quote: source.slice(start, end).trim(),
    });

    searchFrom = index + 1;
  }

  return matches;
}

export function findQuoteInSource(
  source: string,
  quote: string,
): TextMatch | null {
  return findQuoteMatches(source, quote)[0] ?? null;
}

export function makeQuestionLabel(questionQuote: string): string {
  const clean = questionQuote.replace(/\s+/g, " ").trim();

  if (/[?!…]$/.test(clean)) {
    return clean;
  }

  return `${clean}?`;
}

export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

export function makeStableId(file: string, questionQuote: string): string {
  const input = `${file}\n${normalizeForSearch(questionQuote)}`;

  let hash = 2166136261;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `faq-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
