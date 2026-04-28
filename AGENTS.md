# Repository Guidelines

The canonical source of truth for this backend and the paired frontend is the
workspace-level `../AGENTS.md`. Read and follow that file first.

Backend-specific reminder: this is the NestJS API and data authority. Keep the
entity registry in `src/common/constants/entities.constant.ts` aligned with the
frontend API exports, and verify backend changes with `npm run build`.
