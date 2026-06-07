# Publishing

This extension is published to **two** marketplaces:

- **VS Code Marketplace** (Microsoft) — used by VS Code itself.
- **Open VSX** (Eclipse Foundation) — used by VSCodium, Cursor, Windsurf, Gitpod, Theia, etc.

Publishing is **automated**: creating a GitHub Release builds the `.vsix`, attaches it to
the release, and publishes to both marketplaces. See
[`.github/workflows/release.yml`](.github/workflows/release.yml).

The publisher ID **must be identical** in three places: `publisher` in
[`package.json`](package.json), the VS Code Marketplace publisher, and the Open VSX
namespace. It is currently **`linucs`**.

---

## One-time setup

You only do this once. After it's done, every release publishes automatically.

### 1. VS Code Marketplace token (`VSCE_PAT`)

1. Sign in to **Azure DevOps**: <https://dev.azure.com> (free, use any Microsoft account).
   Create an organization if prompted.
2. Top-right avatar → **Personal access tokens** → **New Token**:
   - **Organization:** `All accessible organizations` ← important, not a single org.
   - **Expiration:** 1 year (max).
   - **Scopes:** click *Show all scopes* → **Marketplace** → check **Manage**.
3. **Copy the token** (shown only once).
4. Create the publisher: <https://marketplace.visualstudio.com/manage> → **Create publisher**.
   Set **ID = `linucs`** (must match `package.json`). The display name can be anything.

### 2. Open VSX token (`OVSX_PAT`)

1. Sign in to **Open VSX** with GitHub: <https://open-vsx.org>.
2. Sign the **Eclipse Publisher Agreement** (required once):
   create/sign in to an Eclipse Foundation account at
   <https://accounts.eclipse.org>, then sign the agreement from your Open VSX
   user settings. You cannot publish until this is signed.
3. Create an access token: <https://open-vsx.org/user-settings/tokens> → **Generate New Token**.
   Copy it.
4. Create the namespace once (run locally, replace `<token>`):

   ```sh
   npx ovsx create-namespace linucs -p <token>
   ```

### 3. Add the tokens as GitHub secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret name | Value |
|-------------|-------|
| `VSCE_PAT`  | the Azure DevOps token from step 1 |
| `OVSX_PAT`  | the Open VSX token from step 2 |

The workflow **skips** a marketplace whose secret is missing, so you can wire them up
one at a time — a release will still succeed and just upload the `.vsix` to GitHub.

---

## Cutting a release

1. Bump `version` in [`package.json`](package.json) (semver) and update
   [`CHANGELOG.md`](CHANGELOG.md).
2. Commit and push to `main`.
3. On GitHub: **Releases** → **Draft a new release** → create a tag like `v0.0.1`
   (the tag is the source of the `.vsix` filename; the published version comes from
   `package.json`). Keep the two in sync.
4. **Publish release.** The workflow then:
   - builds and packages `vscode-arduino-cli-<tag>.vsix`,
   - uploads it to the GitHub release,
   - publishes to the VS Code Marketplace (`VSCE_PAT`),
   - publishes to Open VSX (`OVSX_PAT`).

Mark a release as a **pre-release** on GitHub to upload the `.vsix` **without**
publishing to the marketplaces (handy for betas).

---

## Publishing manually (fallback)

If you ever need to publish from your machine instead of CI:

```sh
# VS Code Marketplace
export VSCE_PAT=<azure-devops-token>
yarn publish:vsce

# Open VSX
export OVSX_PAT=<open-vsx-token>
yarn publish:ovsx --pat "$OVSX_PAT"
```

Or build the package without publishing: `yarn vsix`.
