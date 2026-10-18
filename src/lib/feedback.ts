import { REPO_URL } from '@/lib/opener';
import type { FeedbackDiagnostics, FeedbackKind } from '@/types';

/**
 * Feedback (Settings → About → Send feedback, the palette): a pre-filled GitHub page the user
 * submits in the browser. Bugs and other feedback open a new issue, ideas a new discussion in the
 * "Ideas" category. Nothing is sent by Livery itself.
 *
 * The page is written in English for the maintainer (headings, labels); the user's own text stays
 * as typed. Everything goes in the URL, so it must stay under GitHub's limit: the oldest log lines
 * are left out first, and a message too long on its own can't be sent this way.
 */

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'other'];

/** GitHub answers "414 URI Too Long" a little above 8 KB; stay safely under it. */
export const MAX_URL_LENGTH = 8000;
/** The message field's limit (characters). */
export const MAX_TEXT = 2000;
const TITLE_CHARS = 72;

const TAG: Record<FeedbackKind, string> = { bug: 'Bug', idea: 'Idea', other: 'Feedback' };
const HEADING: Record<FeedbackKind, string> = { bug: 'What happened', idea: 'Idea', other: 'Feedback' };

export interface FeedbackInput {
  kind: FeedbackKind;
  text: string;
  /** "Attach technical details": version, OS, language and the log tail. */
  attach: boolean;
  diagnostics?: FeedbackDiagnostics | undefined;
  /** The UI language code. */
  language: string;
}

export interface FeedbackDraft {
  title: string;
  body: string;
  url: string;
  /** Oldest log lines left out so the URL fits. */
  droppedLines: number;
  /** Even without any log line the URL is too long: the message must be shorter. */
  tooLong: boolean;
}

/** "[Bug] The first line of the message…", or a generic title for an empty message. */
export function feedbackTitle(kind: FeedbackKind, text: string): string {
  const first = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  const chars = [...first];
  const line = chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('').trimEnd()}…` : first;
  return `[${TAG[kind]}] ${line || 'Feedback from Livery'}`;
}

/** The page body (GitHub Markdown) with these log lines. */
export function feedbackBody(input: FeedbackInput, logLines: readonly string[]): string {
  const parts = [`### ${HEADING[input.kind]}`, '', input.text.trim() || '_(no message)_'];
  const d = input.attach ? input.diagnostics : undefined;
  if (d) {
    parts.push('', '### Technical details', '', `- Livery: ${d.appVersion}`, `- OS: ${d.os}`, `- Language: ${input.language}`);
    if (logLines.length) {
      // A four-backtick fence: a log line can't close it by accident.
      parts.push(
        '',
        `<details><summary>Log, last ${logLines.length} lines (folders and user name hidden)</summary>`,
        '',
        '````text',
        ...logLines,
        '````',
        '',
        '</details>',
      );
    }
  }
  parts.push('', '_Sent from Livery’s feedback form._');
  return parts.join('\n');
}

const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

/** The GitHub page to open: a new issue (bug, other) or a new discussion in "Ideas" (idea). */
export function feedbackUrl(kind: FeedbackKind, title: string, body: string): string {
  if (kind === 'idea') return `${REPO_URL}/discussions/new?${query({ category: 'ideas', title, body })}`;
  return `${REPO_URL}/issues/new?${query(kind === 'bug' ? { labels: 'bug', title, body } : { title, body })}`;
}

/** Title, body and URL, with as many of the newest log lines as fit. */
export function draftFeedback(input: FeedbackInput): FeedbackDraft {
  const title = feedbackTitle(input.kind, input.text);
  const lines = input.attach ? (input.diagnostics?.logTail ?? []) : [];
  for (let dropped = 0; dropped <= lines.length; dropped++) {
    const body = feedbackBody(input, lines.slice(dropped));
    const url = feedbackUrl(input.kind, title, body);
    if (url.length <= MAX_URL_LENGTH) return { title, body, url, droppedLines: dropped, tooLong: false };
  }
  const body = feedbackBody(input, []);
  return { title, body, url: feedbackUrl(input.kind, title, body), droppedLines: lines.length, tooLong: true };
}
