import { forwardRef, useEffect, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

interface InlineFieldProps {
  value: string;
  /** Called with the trimmed text when it differs from `value` (Enter or blur). */
  onCommit: (next: string) => void;
  /** Accessible name (the field has no visible label). */
  label: string;
  /** Blank text reverts instead of committing (names). */
  required?: boolean;
  placeholder?: string;
  className?: string;
}

// Text-like: no box until hovered or focused; the 4px side padding is pulled back into the margin.
const FIELD =
  '-mx-1 w-[calc(100%+8px)] min-w-0 rounded-menu bg-transparent px-1 placeholder:text-ink-4 hover:bg-bg-hover focus:bg-bg-hover motion-safe:transition-colors motion-safe:duration-120';

/**
 * Enter or blur commits, Escape reverts; focus stays in the field either way. The draft follows
 * `value` while the field isn't being edited (a rename from elsewhere, a refetch).
 */
function useInlineEdit({ value, onCommit, label, required, placeholder }: InlineFieldProps) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    const next = draft.trim();
    if ((required && next === '') || next === value) {
      setDraft(value);
      return;
    }
    setDraft(next);
    onCommit(next);
  };

  return {
    'aria-label': label,
    placeholder,
    autoComplete: 'off',
    spellCheck: false,
    value: draft,
    // Single-line text even in the wrapping description (pasted line breaks become spaces).
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value.replace(/\r?\n/g, ' ')),
    onFocus: () => setEditing(true),
    onBlur: () => {
      setEditing(false);
      commit();
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape' && draft !== value) {
        // Reverting the edit is the topmost thing Escape can close here.
        e.preventDefault();
        e.stopPropagation();
        setDraft(value);
      }
    },
  };
}

/** A one-line field styled as plain text (collection name). */
export const InlineInput = forwardRef<HTMLInputElement, InlineFieldProps>(function InlineInput(props, ref) {
  return <input ref={ref} type="text" {...useInlineEdit(props)} className={cn(FIELD, props.className)} />;
});

/**
 * A field styled as plain text that wraps like a paragraph (collection description): a textarea
 * sized to its content (`field-sizing`, WebView2/Chromium 123+). Enter commits, it never adds lines.
 */
export const InlineTextArea = forwardRef<HTMLTextAreaElement, InlineFieldProps>(function InlineTextArea(props, ref) {
  return (
    <textarea
      ref={ref}
      rows={1}
      {...useInlineEdit(props)}
      className={cn(FIELD, 'block resize-none [field-sizing:content]', props.className)}
    />
  );
});
