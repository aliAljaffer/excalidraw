# Self-hosted deployment

This fork serves <https://excalidraw.alialjaffer.com>. The Kubernetes manifests live in `aliAljaffer/homelab` under `kubernetes/apps/excalidraw`, together with the Postgres cluster that stores shared scenes.

## What this fork changes

- `.env.production` points the collaboration socket and the share-link backend at `excalidraw.alialjaffer.com` instead of `excalidraw.com`.
- Every share and collaboration link is built from `VITE_APP_SHARE_BASE` (default `/s/`) instead of the current path, so a link made in the private editor still opens for a guest.
- Sentry, the Excalidraw+ promotions and export, the upstream library browser, and the analytics script are gone. Fonts ship in the image, so no request leaves for Google, DigitalOcean, sentry.io, or esm.sh.
- `nginx.conf` adds the content security policy and the headers, and serves the SPA at `/s/`.
- `excalidraw-app/data/shareFiles.ts` stores share-link images in our own backend, so no Firebase project is needed. `App.tsx` and `excalidraw-app/data/index.ts` call it instead of Firebase Storage.
- `backend/` is a small Go service (`scenes`) that stores share-link scenes, room scenes, boards and folders. The browser compresses and encrypts the payload before upload, so the service only ever holds opaque blobs.
- A board is a row pointing at a persisted room, optionally inside a folder. The gallery at `/boards` is server rendered by the same Go service and sits behind the login; the app's nginx forwards `/boards` to it.
- Room persistence replaces the upstream Firebase adapter: `excalidraw-app/data/rooms.ts` writes the encrypted scene to `/api/v2/rooms/{id}` with a revision and a write token (`sha256(roomKey)`, computed in the browser). The Firebase SDK is gone.

Everything else is upstream Excalidraw.

## Backend API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v2/scenes` | Store a blob, returns `{"id":"<32 hex>"}` |
| `GET` | `/api/v2/scenes/{id}` | Return the blob |
| `PUT` | `/api/v2/scenes/{id}/files/{fileId}` | Store one share-link image |
| `GET` | `/api/v2/scenes/{id}/files/{fileId}` | Return one share-link image |
| `GET` | `/api/v2/rooms/{id}` | Return the encrypted room scene and revision |
| `PUT` | `/api/v2/rooms/{id}` | Write the scene, rejected on a stale revision or a wrong token |
| `PUT` | `/api/v2/rooms/{id}/files/{fileId}` | Store one encrypted room image (token in `X-Room-Token`) |
| `GET` | `/api/v2/rooms/{id}/files/{fileId}` | Return one encrypted room image |
| `GET` | `/healthz` | Database ping |

Environment: `DATABASE_URL` (required), `LISTEN_ADDR`, `MAX_BYTES` (per upload, default 10 MiB), `UPLOADS_PER_HOUR` (per client IP, default 30), `RETENTION_DAYS` (default 90).

Without the decryption key in the share link the stored blobs are useless: the key never leaves the browser, it travels in the URL fragment.

## Images

`.github/workflows/images.yml` builds all three images on the cluster's ARC runner and pushes them to Harbor:

- `harbor.alialjaffer.com/mirror/excalidraw`
- `harbor.alialjaffer.com/mirror/excalidraw-scenes`
- `harbor.alialjaffer.com/mirror/excalidraw-room`

It then pins the digests in the homelab repository and commits as `update-manifests-homelab[bot]`, which triggers ArgoCD. Nothing is deployed by hand.

## Known limits

- Share links with images depend on the `scenes` service; a scene-only link is still served if the image upload failed.
- A room lives as long as a board points at it. Boards and folders never expire; only share-link scenes and orphaned rooms age out (`RETENTION_DAYS`).
- Text-to-diagram has no backend: `VITE_APP_AI_BACKEND` is unset, so the dialog fails cleanly instead of calling upstream. A skill-backed service is planned.
- Image libraries are not browsable: the upstream library browser and publish flow were removed. Icon libraries will load from a static manifest instead.
