# Kickoff prompt for Claude Code

Paste this as the first message in the repo root (empty folder containing `design_handoff_livery/`):

---
Read `design_handoff_livery/CLAUDE.md`, then `README.md`, `DATA_MODEL.md` and `BUILD_PLAN.md` in that folder. Move `CLAUDE.md` to the repo root. Then execute **M0 and M1** of the build plan: scaffold the Tauri 2 + React + TypeScript + Tailwind project with the tokens from `tokens/tailwind.tokens.cjs`, self-host the fonts, and build the global chrome (title bar, sidebar, command palette, toasts, skeletons, drag-drop overlay, keyboard shortcuts) exactly as specified. Use placeholder screens for the five sections. Stop after M1, run the app, and list what differs from the prototype before continuing.
---

Then, milestone by milestone: "Continue with M2 from BUILD_PLAN.md. Compare against the First run screen in the prototype when done."

Tips
- Open `Livery Prototype.dc.html` in a browser next to the dev window; the Tweaks control switches window size / offline / reduced motion.
- If a spec detail is missing, the prototype is the source of truth; if the prototype and README disagree, the README wins and the discrepancy goes in `DESIGN_NOTES.md`.
