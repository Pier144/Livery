import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

interface AnimatedCheckProps {
  size: number;
  /** Plays the entrance: a small overshooting scale while the stroke draws itself. */
  animate: boolean;
  strokeWidth?: number;
  className?: string;
}

/** Lucide's check, which can arrive with a pop and draw its stroke (Installed, Following, a selected box). */
export function AnimatedCheck({ size, animate, strokeWidth = 1.75, className }: AnimatedCheckProps) {
  return (
    <Check
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden
      className={cn(
        animate && 'motion-safe:animate-check-in [&_path]:[stroke-dasharray:24] motion-safe:[&_path]:animate-check-draw',
        className,
      )}
    />
  );
}
