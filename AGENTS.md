# Repository Guidelines

## Project Structure & Module Organization
This repository is a NestJS backend. Application code lives in `src/`, organized by feature modules such as `auth/`, `users/`, `resources/`, `files/`, `integrations/`, `security/`, and `health/`. Shared DTOs, constants, filters, and utilities live under `src/common/`. Build output is written to `dist/`. Runtime uploads go to `uploads/` and should not be committed.

## Build, Test, and Development Commands
- `npm install`: install project dependencies.
- `npm run start:dev`: run the API in watch mode for local development.
- `npm run start`: start the Nest application once.
- `npm run build`: compile TypeScript into `dist/`.
- `npm run start:prod`: run the compiled app from `dist/main.js`.

There is no committed `npm test` or lint script at the moment. Before opening a PR, at minimum run `npm run build` and smoke-test the affected endpoints locally.

## Coding Style & Naming Conventions
Use TypeScript with 2-space indentation and follow the existing NestJS structure. Name modules, services, and controllers with Nest conventions: `*.module.ts`, `*.service.ts`, `*.controller.ts`. Keep DTOs in `dto/` folders and schemas in `schemas/`. Use `PascalCase` for classes, `camelCase` for variables/functions, and `UPPER_SNAKE_CASE` for environment variables. Match the repository’s existing import style and avoid introducing formatting tools that are not already configured.

## Testing Guidelines
Automated tests are not currently wired into `package.json`. If you add tests, place them beside the feature they cover as `*.spec.ts` and prefer Nest testing utilities from `@nestjs/testing`. Cover service logic, guards, and controller behavior where practical. Until a test runner is added, document manual verification steps in the PR.

## Commit & Pull Request Guidelines
Recent history uses short commit subjects such as `development-1` and `development-2`. Prefer clearer, imperative messages going forward, for example `auth: add JWT guard for resources`. Keep PRs focused, describe behavioral changes, note any new environment variables, and include API examples or screenshots when response shapes or docs change.

## Security & Configuration Tips
Local configuration is loaded from `.env.local` and `.env`; `.env.example` is only a template. PHI encryption requires valid `PHI_ENCRYPTION_KEY_B64` and `PHI_INDEX_KEY_B64` values. Generate 32-byte base64 keys with `openssl rand -base64 32`.
