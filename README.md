# Dota2PornFxData

Submission queue for the **[Dota2PornFx](https://github.com/h6rd/Dota2PornFxWeb)** mod catalog. Mods and updates sent through the [upload page](https://h6rd.github.io/Dota2PornFxWeb/upload.html) arrive here as pull requests and wait for review before they are published to the catalog.

> [!IMPORTANT]
> **Do not open pull requests here by hand.** Submissions are created automatically by the upload page. To add or update a mod, use the [upload page](https://h6rd.github.io/Dota2PornFxWeb/upload.html).

## How a submission moves

1. **Upload.** The upload page checks the archive and sends it to the uploader service, together with the mod's details and the version/time of the terms accepted in the upload dialog.
2. **Pull request.** The service creates a branch `submission/<id>` with a `pending/<id>/` folder (mod file, preview, `meta.json`) and opens a pull request. Its description lists the mod's name, category, tags, links and a **Terms** line recording that the upload terms were accepted.
3. **Automatic reports.** Bots comment on the pull request with a file inspection report and a preview of what would change in the catalog.
4. **Review.** A maintainer approves (merges) or rejects (closes) the pull request. The reason for a rejection is shown to the submitter in the upload page's history. Submissions that wait longer than 72 hours are closed automatically and can be resubmitted.
5. **Publishing.** The publish workflow runs daily (and on demand), moves approved mods from `pending/` into the main catalog repository, and removes them from `pending/`.

## Terms of submission

Mods sent through the upload page are published under the [Dota2PornFx Content License](https://github.com/h6rd/Dota2PornFxWeb/blob/main/LICENSE-CONTENT.md). Before the first submission the author accepts the terms shown in the upload dialog: that the mod is theirs (or they have the right to share it), that it may be hosted and distributed free of charge including to the approved projects, that it is licensed under the Content License, that h6rd may send takedown notices on their behalf against unauthorized copies, mirrors and paid resales, and that they keep all rights and may ask to change or remove it at any time. The full text is in section 5 of the license.

Valve assets inside a mod remain Valve's property.

## What is recorded

Each pull request records the mod's details, the submission date and the version/time of the accepted terms. For rate limiting and the submitter's own history, the service also stores a keyed hash of the network address (not the address itself). This is a record of what the submitter declared, not independent verification of authorship.

## Removal and corrections

Authors can ask for a mod to be removed, credited differently or published on other terms: Discord `.hrdq`, email `hrdq@proton.me` or an issue in the [main repository](https://github.com/h6rd/Dota2PornFxWeb/issues). Once authorship is confirmed, the mod is removed from the catalog within 7 days. Git history is not rewritten, so earlier versions may remain in history and forks.

## Contents

| Path | What it is |
|---|---|
| `pending/<id>/` | A submission waiting to be published (exists only on its branch until the pull request is merged) |
| `scripts/publish.js` | Publishes approved submissions to the catalog repository |
| `scripts/preview.js` | Builds the preview report shown on each pull request |
| `.github/workflows/publish.yml` | Daily publish workflow |

Code in this repository is part of the Dota2PornFx project; see the [main repository](https://github.com/h6rd/Dota2PornFxWeb#license) for licensing.

This project is not affiliated with, endorsed by or sponsored by Valve Corporation. Dota 2 is a trademark of Valve Corporation.
