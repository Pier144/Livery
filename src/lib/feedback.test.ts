import { describe, expect, it } from 'vitest';
import { isAllowedUrl } from './opener';
import { MAX_URL_LENGTH, draftFeedback, feedbackBody, feedbackTitle, feedbackUrl, type FeedbackInput } from './feedback';

const DIAG = { appVersion: '0.3.2', os: 'Windows 11 24H2 (build 26100.1)', logTail: ['line 1', 'line 2', 'line 3'] };
const input = (over: Partial<FeedbackInput> = {}): FeedbackInput => ({
  kind: 'bug',
  text: 'Install fails\nwith a RAR pack',
  attach: true,
  diagnostics: DIAG,
  language: 'it',
  ...over,
});

describe('feedback drafts', () => {
  it('titles with the kind and the first line, cut to a short line', () => {
    expect(feedbackTitle('bug', '\n  Install   fails \nmore')).toBe('[Bug] Install fails');
    expect(feedbackTitle('idea', '')).toBe('[Idea] Feedback from Livery');
    const long = feedbackTitle('other', 'x'.repeat(200));
    expect(long.startsWith('[Feedback] ')).toBe(true);
    expect([...long.slice('[Feedback] '.length)]).toHaveLength(72);
    expect(long.endsWith('…')).toBe(true);
  });

  it('writes the message, then the technical details only when attached', () => {
    const body = feedbackBody(input(), DIAG.logTail);
    expect(body).toContain('### What happened\n\nInstall fails\nwith a RAR pack');
    expect(body).toContain('- Livery: 0.3.2\n- OS: Windows 11 24H2 (build 26100.1)\n- Language: it');
    expect(body).toContain('````text\nline 1\nline 2\nline 3\n````');
    const plain = feedbackBody(input({ attach: false }), DIAG.logTail);
    expect(plain).not.toContain('Technical details');
    expect(plain).not.toContain('line 1');
  });

  it('opens an issue for bugs and other feedback, a discussion in Ideas for ideas, all allowed links', () => {
    const bug = feedbackUrl('bug', 'T', 'B');
    expect(bug).toBe('https://github.com/Pier144/Livery/issues/new?labels=bug&title=T&body=B');
    expect(feedbackUrl('other', 'T', 'a b&c')).toBe('https://github.com/Pier144/Livery/issues/new?title=T&body=a%20b%26c');
    const idea = feedbackUrl('idea', 'T', 'B');
    expect(idea).toBe('https://github.com/Pier144/Livery/discussions/new?category=ideas&title=T&body=B');
    for (const url of [bug, idea]) expect(isAllowedUrl(url)).toBe(true);
    // The query decodes back to the exact text.
    const body = 'Тигр “H” #1 ?x=y';
    expect(new URL(feedbackUrl('bug', 'T', body)).searchParams.get('body')).toBe(body);
  });

  it('leaves out the oldest log lines to fit the link, and says when the message itself is too long', () => {
    const many = { ...DIAG, logTail: Array.from({ length: 40 }, (_, i) => `${i} ${'z'.repeat(250)}`) };
    const draft = draftFeedback(input({ diagnostics: many }));
    expect(draft.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(draft.droppedLines).toBeGreaterThan(0);
    expect(draft.tooLong).toBe(false);
    expect(draft.body).toContain(`39 ${'z'.repeat(250)}`);
    expect(draft.body).not.toMatch(/^0 z/m);

    const small = draftFeedback(input());
    expect(small.droppedLines).toBe(0);

    const huge = draftFeedback(input({ text: '涂'.repeat(2000) }));
    expect(huge.tooLong).toBe(true);
  });
});
