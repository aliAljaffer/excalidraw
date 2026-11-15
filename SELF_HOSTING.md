# Self-hosted deployment

This fork serves <https://excalidraw.alialjaffer.com>. The Kubernetes manifests live in `aliAljaffer/homelab` under `kubernetes/apps/excalidraw`, together with the Postgres cluster that stores shared scenes.

## What this fork changes

- `.env.production` points the collaboration socket and the share-link backend at `excalidraw.alialjaffer.com` instead of `excalidraw.com`.
- `excalidraw-app/data/shareFiles.ts` stores share-link images in our own backend, so no Firebase project is needed. `App.tsx` and `excalidraw-app/data/index.ts` call it instead of Firebase Storage.
- `backend/` is a small Go service (`scenes`) that stores scenes and their images. The browser compresses and encrypts the payload before upload, so the service only ever holds opaque blobs.

Everything else is upstream Excalidraw.

## Backend API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v2/scenes` | Store a blob, returns `{"id":"<32 hex>"}` |
| `GET` | `/api/v2/scenes/{id}` | Return the blob |
| `PUT` | `/api/v2/scenes/{id}/files/{fileId}` | Store one share-link image |
| `GET` | `/api/v2/scenes/{id}/files/{fileId}` | Return one share-link image |
| `GET` | `/healthz` | Database ping |

Environment: `DATABASE_URL` (required), `LISTEN_ADDR`, `MAX_BYTES` (per upload, default 10 MiB), `UPLOADS_PER_HOUR` (per client IP, default 30), `RETENTION_DAYS` (default 90).

Without the decryption key in the share link the stored blobs are useless: the key never leaves the browser, it travels in the URL fragment.

## Images

`.github/workflows/images.yml` builds both images on the cluster's ARC runner and pushes them to Harbor:

- `harbor.alialjaffer.com/mirror/excalidraw`
- `harbor.alialjaffer.com/mirror/excalidraw-scenes`

It then pins the digests in the homelab repository and commits as `update-manifests-homelab[bot]`, which triggers ArgoCD. Nothing is deployed by hand.

## Known limits

- Share links with images depend on the `scenes` service; a scene-only link is still served if the image upload failed.
- `VITE_APP_AI_BACKEND` still points at `oss-ai.excalidraw.com`. Text-to-diagram will fail until it is replaced.
- The collaboration room server is the upstream `excalidraw/excalidraw-room` image, unchanged.
