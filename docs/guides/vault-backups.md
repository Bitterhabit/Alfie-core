# Encrypted Vault Backups

Alfie exports a logical, per-user vault rather than copying the live SQLite database files. This keeps the archive portable and lets restore rebuild the storage indexes through the normal batch writer.

## Archive protection

- AES-256-GCM authenticated encryption.
- scrypt key derivation with a fresh random salt for each export.
- The archive is bound to the exporting Alfie user ID; a vault cannot be restored into another account.
- SHA-256 manifest integrity check after decryption.
- Passphrases must be at least 12 characters.
- Maximum supported encrypted archive size is 16 MiB. Exports larger than this are rejected rather than creating a backup that Alfie cannot restore.

Keep the passphrase somewhere safe outside Alfie. It is not stored in the archive in recoverable form, and Alfie cannot recover it for you.

## What is included

The vault includes the user's memories, projects, ideas, conversations, permissions, workflow profile, context capsules, jobs, watchers, reflections, playbooks, audit events and action receipts.

Provider credentials, API keys, peer tokens and other integration secrets are deliberately excluded. Reconfigure those separately on a restored installation.

Pending executable approvals are never exported or restored. The archive contains their receipts only. This prevents a restore from reviving an old action that might execute against a changed system.

## Restore modes

- **Merge** (default): merges records by ID, retaining newer local entries when timestamps are available. Audit events and action receipts are merged as well. Existing pending approvals are cleared.
- **Replace**: replaces every supported vault collection and clears collections absent from the archive. Treat this as destructive.

Always verify an archive before restoring it. For the first restore, use a disposable target and confirm that the expected records are present before considering a live restore.

## Verification boundary

Automated tests cover encryption, wrong-passphrase/tamper rejection, archive size limits, merge/replace behaviour, transactional SQLite restore, compensating JSON-backend rollback, and preservation of audit receipts without executable approvals.

These tests do not prove that a backup from a live homelab can be restored successfully. The first real restore should be performed against a disposable target after deployment.
