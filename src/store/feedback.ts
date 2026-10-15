import { create } from 'zustand';

interface FeedbackState {
  open: boolean;
}

/** Whether the Send feedback dialog (FeedbackDialog, mounted once in App) is open. */
export const useFeedback = create<FeedbackState>()(() => ({ open: false }));

/** Settings → About → Send feedback, and the palette's action. */
export function openFeedback() {
  useFeedback.setState({ open: true });
}

export function closeFeedback() {
  useFeedback.setState({ open: false });
}
