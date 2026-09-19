// Types for scripts/i18n-check.mjs, which src/i18n/i18n.test.ts imports to run the same checks as
// `pnpm i18n:check` (the script is plain Node ESM, outside the TypeScript project).
declare module '*/scripts/i18n-check.mjs' {
  export type Entry = [key: string, text: string];
  export interface Slot {
    key: string;
    required: boolean;
    source: string;
  }
  export const I18N_DIR: string;
  export const HAND_TRANSLATED: string[];
  export const GENERATED: string[];
  export const TARGETS: string[];
  export function flatten(obj: object, prefix?: string): Entry[];
  export function unflatten(entries: Entry[]): Record<string, unknown>;
  export function serialize(obj: object): string;
  export function pluralCategories(lng: string): Intl.LDMLPluralRule[];
  export function pluralGroups(enEntries: Entry[]): Map<string, string[]>;
  export function layout(enEntries: Entry[], lng: string): Slot[];
  export function syncLanguage(
    enEntries: Entry[],
    targetEntries: Entry[],
    lng: string,
  ): { entries: Entry[]; added: string[]; missing: string[]; removed: string[] };
  export function checkLanguage(enEntries: Entry[], targetEntries: Entry[], lng: string): string[];
  export function checkSource(enEntries: Entry[]): string[];
  export function readLocale(lng: string, dir?: string): { file: string; text: string; entries: Entry[] };
  export function checkAll(dir?: string): Record<string, string[]>;
}
