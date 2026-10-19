import { en } from "./en";
import { uk, type Messages } from "./uk";

export const LOCALES = ["uk", "en"] as const;

export type Locale = (typeof LOCALES)[number];

const catalogs: Record<Locale, Messages> = { uk, en };

let active: Locale = "uk";
let readRequestLocale: (() => Locale | undefined) | undefined;

export function isLocale(value: unknown): value is Locale {
  return value === "uk" || value === "en";
}

export function getLocale(): Locale {
  return readRequestLocale?.() ?? active;
}

export function setLocale(locale: Locale): void {
  active = locale;
}

export function bindLocale(read: () => Locale | undefined): void {
  readRequestLocale = read;
}

type Paths<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`;
    }[keyof T & string];

export type MessageKey = Paths<Messages>;

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (!node || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[part];
  }, catalogs[getLocale()]);
  const text = typeof value === "string" ? value : key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
