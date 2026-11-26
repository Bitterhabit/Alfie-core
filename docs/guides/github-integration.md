# GitHub integration setup

Alfie Core can inspect repositories and prepare approval-gated code changes. The GitHub token is read only by the Core container; it must never be pasted into chat, stored in browser settings, or exposed to the Interface browser.

## 1. Create a narrowly scoped token

Create a **fine-grained personal access token** for only the repository or repositories Alfie should use. Prefer a dedicated test repository for the first write test and set a short expiry.

Required repository permissions:

| Capability | GitHub permission |
| --- | --- |
| Repository metadata, file tree, file reads, commits and pull requests | Metadata: read-only; Contents: read-only; Pull requests: read-only |
| Create an Alfie branch, commit proposed files and open a draft pull request | Contents: read and write; Pull requests: read and write |
| Create GitHub issue drafts (github:draft) | Issues: read and write (only if this feature is needed) |

Grant only the permissions needed for the operations you intend to use. The token must also be granted access to each selected repository.

## 2. Configure the token on Core

On the host, edit the Core project's private .env file and set:

    ALFIE_GITHUB_TOKEN=your_fine_grained_token

Do not put the token in .env.example, Compose environment values for the Interface, browser storage, screenshots, logs, or chat. Keep .env private (mode 600). Recreate only the Core service using the same Compose files/overrides as the installation:

    docker compose up -d --force-recreate alfie-core

Check whether Core sees a configured token without printing its value:

    docker compose exec alfie-core sh -lc 'test -n "$ALFIE_GITHUB_TOKEN" && echo "GitHub token configured" || echo "GitHub token missing"'

The Interface does not receive ALFIE_GITHUB_TOKEN.

## 3. Grant Alfie access in Tools & Access

- Grant github:read to inspect repositories.
- Grant github:write only when you want Alfie to propose code changes.
- Grant github:draft only if you want the separate GitHub issue-draft capability.

These are Alfie-side capability grants, separate from the GitHub token's repository permissions. Both must allow an operation. A grant does not override the token's repository scope.

## 4. What a code change does

The github.change.create_pr action:

- creates a new branch whose name begins with alfie/;
- captures the base commit and changed-file versions when the approval card is prepared, displays the reviewed base commit, and rejects the approval if that state changes before or during execution;
- requires the expected current file SHA for edits to existing files;
- refuses to overwrite an existing file when it was proposed as a new file;
- limits a proposal to 10 files and 80 KB combined (30 KB per file);
- blocks credential, environment and private-key paths;
- opens a draft pull request and verifies its branch, base, commit and draft state;
- provides the read-only `github.change.inspect` recovery check to distinguish a missing branch, a branch created without a PR, and an existing PR after an interrupted request.

It never commits directly to the repository's default branch. Every write requires explicit approval in Alfie's chat. The approval card shows the exact proposed file contents before execution.

## 5. Safe first test

Use a dedicated, non-production test repository:

1. Grant github:read and ask Alfie to inspect the repository, list files and read a harmless source file.
2. Try a secret-like path such as .envrc and confirm it is refused.
3. Grant github:write and ask Alfie to add a harmless documentation file.
4. Inspect the exact content, branch name, base branch and PR details in the approval card.
5. Reject one proposal and confirm no branch or PR is created.
6. Prepare a separate proposal, approve it, and confirm that only a draft PR on an alfie/* branch appears.

Do not use a production repository for the first write test. If a network error occurs during branch/PR creation, ask Alfie to run `github.change.inspect` for the exact repository and `alfie/*` branch before retrying. It is read-only and reports whether the branch exists and whether a matching PR was created. A branch without a PR still needs manual inspection before any further write.

## Boundaries

- CI uses mocked GitHub responses. It does not prove a live token, real repository access, or an end-to-end approval flow.
- Repository content and API responses are treated as untrusted external data.
- The connector uses the official api.github.com endpoint, bounded requests and rejects redirects.
- Revoking github:write in Alfie stops Alfie from using the write tool, but does not revoke the GitHub token. Revoke the token in GitHub if it is no longer needed or may have been exposed.
