import { useQuery } from '@tanstack/react-query';
import { call, hasBackend } from '@/lib/tauri';
import type { AppError, FeedbackDiagnostics } from '@/types';

export const FEEDBACK_DIAGNOSTICS_KEY = ['feedbackDiagnostics'] as const;

/**
 * Version, Windows and the anonymised log tail (`feedback_diagnostics`), read again every time the
 * feedback dialog opens so the log is current. Undefined without a backend (plain browser, tests).
 */
export function useFeedbackDiagnostics(enabled: boolean) {
  return useQuery<FeedbackDiagnostics, AppError>({
    queryKey: FEEDBACK_DIAGNOSTICS_KEY,
    queryFn: () => call<FeedbackDiagnostics>('feedback_diagnostics'),
    enabled: enabled && hasBackend(),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
