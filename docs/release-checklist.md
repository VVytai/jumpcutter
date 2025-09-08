1. Pull `src/_locales` from the Weblate repo.
2. Add new contributors to `src/_locales/LICENSE_NOTICES`. `git shortlog --summary --email --after=<previous_release_commit>` will help. To make sure you didn't miss anyone, check if `git shortlog --summary --email | wc -l` outputs a number that is ~~1 smaller than~~ the same as (one user used two different names) the number of lines in the coppyright notice (to account for Anonymous).
4. If new languages were added, check if their language code works alright in the browsers.
5. Commit `.gitmodules`
6. Bump version in `src/manifest_base.json`
7. Publish
    * Chrome Web Store

      Nothing special currently

    * Mozilla Add-ons

      If new locales were added, or if there were changes to the extension description string, update the description in the store.

    * Microsoft Edge Addons

      Same as for Mozilla Add-ons + copy the icon and the promotional image for all languages.

    * Other

      We don't currently localize the full description, but if we start doing this, then we'll also need to update it, in Chrome Web Store as well.
