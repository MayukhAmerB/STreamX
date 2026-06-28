# Black Meridian Live Evidence Index

Difficulty: 10/10

This lab is intentionally live. The answer path starts from the real Instagram
profile used in the platform and pivots into controlled public GitHub repos.
The local app only gives objectives and validation.

Rules:
- Do not brute-force the answer endpoint.
- Do not attack third-party services.
- Use only public OSINT, GitHub history, branch comparison, metadata review,
  decoding, and local analysis of cloned repos.
- Exact formatting matters.

Starting point:
- Instagram: `@xcfwjoo310`

Controlled GitHub surface:
- `https://github.com/mikaelashborne/public-archive/tree/black-meridian`
- `https://github.com/mikaelashborne/CRBV/tree/black-meridian`
- `https://github.com/mikaelashborne/PGP/tree/black-meridian`
- `https://github.com/mikaelashborne/Madsonrepo/tree/black-meridian`
- `https://github.com/mikaelashborne/secure-vault/tree/black-meridian`

Investigation note:
- Some answers are in current files.
- Some require commit history, not current snapshots.
- Some require transforming values before submission.
- The final payload requires evidence from multiple earlier stages.
