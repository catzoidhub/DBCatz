# Security

DBCatz runs on your Mac with access to things that matter — it holds the passwords, SSH keys and cloud credentials of your databases, and runs queries against them — production ones included. A security problem in it is taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately instead:

1. Open the repository's **Security** tab → **Report a vulnerability**
   ([direct link](https://github.com/catzoidhub/DBCatz/security/advisories/new)). Only the maintainer sees it.
2. Say what is affected, how to reproduce it, and what an attacker could do with it. A proof of concept helps.

Security reports are read before anything else, as soon as the maintainer can — there is no fixed response time yet.
Together we agree on a fix and when to publish it; you are credited in the advisory and the release notes unless you
would rather not be.

## What is in scope

- The DBCatz app and its updater (the update feed and the downloaded update are checked before they install).
- Anything that would let a web page, another app or a crafted file make DBCatz do something you did not ask for —
  deep links (`dbcatz://`), imported files, the local services it runs.
- Secrets leaving your Mac: saved database passwords, SSH keys and passphrases, AWS / Vault credentials, the AI key in the "Catzoid AI" Keychain item.
- Production safety — anything that lets a write through a Read-only connection, or past the confirmation a Production connection asks for.

Out of scope: problems that need someone who already controls your Mac or your user account, and vulnerabilities in
third-party software DBCatz installs or talks to (report those upstream — we are happy to help).

## Supported versions

Only the **latest release** gets security fixes; the app updates itself, so please stay on it.
