# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, use GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, affected version, and reproduction steps.

We aim to acknowledge reports within a few days and will keep you updated on
the fix and disclosure timeline. Once a fix ships, we're happy to credit you in
the release notes unless you prefer to stay anonymous.

## Scope

GlanceTerm is a fork of [Tabby](https://github.com/Eugeny/tabby). If the issue
is in unmodified upstream Tabby code, it may also affect Tabby — consider
reporting it upstream as well. Issues in GlanceTerm's own additions (the AI
sidebar plugin, hook installation, auto-approve, the `SidebarProvider` core
extension) should be reported here.

## Supported versions

GlanceTerm is pre-1.0 and ships from `main`. Security fixes target the latest
release; there is no back-porting to older tags yet.
