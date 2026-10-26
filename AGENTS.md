## Principles

- Use defensive programming.
- Follow the DRY principle.
- Favor simple, robust, elegant solutions.
- Don't use hacks. Find the root cause and fix problems properly.

### Error handling and logging

- All potential errors, exceptions, and return values must be handled properly.
- The text of all user-facing messages should be specific to the situation and contain actionable info for the user.

## AI behavior and language

- Use ASD-STE100 (simplified technical English) for all your chat communications and in all documents you create or contribute to.
- When asked to analyze or research, present your findings. Then ask if/how to implement them.
- Whenever changing code, verify if the related documentation needs to be updated, too.

## Correctness

- Always run relevant tests after making changes. Fix any warnings or errors.

## Coding style

- Add docstrings and comments for non-obvious code.
- Don't use magic strings or magic numbers. Use centrally defined constants, enums, or similar instead.
- Before changing any form, settings surface, or dialog, read `website/content/docs/<VERSION>/developer-guide/frontend-architecture/settings-form-dialog-pattern/index.md`.

## Git Commits

- Never commit your changes. That will be done manually.

## Documentation

- All end-user, admin, developer, and website docs live in `website/content/docs/`.
- For all docs changes, follow the `docs-update` skill.

## Dependencies

- Before changing pinned or hashed dependencies or lockfiles, consult `website/content/docs/<VERSION>/developer-guide/release-and-versioning/dependency-update-workflow/index.md`.

## Frontend testing / issue reproduction

- Only ever use the following connection for testing in the VS Code browser: http://localhost:3000/browse/smb/demo

## Backend Python

- Never activate the virtual environment with `source`.
- Run `scripts/setup-backend-venv` only to create or rebuild that environment.
