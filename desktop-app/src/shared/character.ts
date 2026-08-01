export interface Character {
  token: string;
  name: string;
  refImagePath: string;
  role?: string;
  palette?: string;
  appearance?: string;
  clothing?: string;
  isMain?: boolean;
  isRecurring?: boolean;
  detailsLocked?: boolean;
}

export interface CharacterView extends Character {
  refImageDataUrl: string | null;
}

export interface CharacterRosterEntry {
  token: string;
  name: string;
}

export interface CharacterImageInput {
  bytes: ArrayBuffer;
  mimeType: string;
}

export interface CharacterCreateInput {
  token: string;
  name: string;
  image: CharacterImageInput;
  role?: string;
  palette?: string;
  appearance?: string;
  clothing?: string;
  isMain?: boolean;
  isRecurring?: boolean;
  detailsLocked?: boolean;
}

export interface CharacterUpdateInput {
  originalToken: string;
  token: string;
  name: string;
  image?: CharacterImageInput;
  role?: string;
  palette?: string;
  appearance?: string;
  clothing?: string;
  isMain?: boolean;
  isRecurring?: boolean;
  detailsLocked?: boolean;
}

export interface CharactersBridge {
  list: () => Promise<CharacterView[]>;
  create: (input: CharacterCreateInput) => Promise<CharacterView[]>;
  update: (input: CharacterUpdateInput) => Promise<CharacterView[]>;
  remove: (token: string) => Promise<CharacterView[]>;
}

export const CHARACTER_LIST_CHANNEL = "characters:list";
export const CHARACTER_CREATE_CHANNEL = "characters:create";
export const CHARACTER_UPDATE_CHANNEL = "characters:update";
export const CHARACTER_DELETE_CHANNEL = "characters:delete";

const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_]{1,40}$/;
const TOKEN_PATTERN = /(?:^|[^A-Za-z0-9_])(@[A-Za-z0-9_]+)/g;

export function normalizeCharacterToken(value: string): string | null {
  const body = value.trim().replace(/^@+/, "");
  if (!TOKEN_BODY_PATTERN.test(body)) return null;
  return `@${body.toUpperCase()}`;
}

export function parseCharacterTokens(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[1].toUpperCase();
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }

  return tokens;
}

function foldedText(value: string): string {
  // Preserve Vietnamese diacritics so a name such as "Lân" is not confused
  // with ordinary words such as "lần". Explicit aliases can cover unaccented names later.
  return value.normalize("NFC").toLocaleLowerCase("vi-VN");
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

export function countCharacterNameMentions(text: string, name: string): number {
  const foldedName = foldedText(name.trim());
  if (!foldedName) return 0;
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${escapedPattern(foldedName)}(?=$|[^\\p{L}\\p{N}_])`,
    "gu",
  );
  return [...foldedText(text).matchAll(pattern)].length;
}

export function recurringCharacterRoster(
  text: string,
  characters: CharacterRosterEntry[],
  minimumMentions = 2,
): CharacterRosterEntry[] {
  const threshold = Math.max(1, Math.floor(minimumMentions));
  return characters.flatMap((character) => {
    const token = normalizeCharacterToken(character.token);
    const name = typeof character.name === "string" ? character.name.trim() : "";
    return token && name && countCharacterNameMentions(text, name) >= threshold
      ? [{ token, name }]
      : [];
  });
}

export function matchCharacterNames(
  text: string,
  roster: CharacterRosterEntry[],
): string[] {
  return roster.flatMap((character) =>
    countCharacterNameMentions(text, character.name) > 0 ? [character.token] : []
  );
}
