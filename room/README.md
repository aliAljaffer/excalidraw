# excalidraw-room

Collaboration server for the self-hosted Excalidraw at
<https://excalidraw.alialjaffer.com>. Vendored from
[excalidraw/excalidraw-room](https://github.com/excalidraw/excalidraw-room) at
commit `03ff435860b508d7cd9e005cfc90f7977ae2a593` (MIT, see `LICENSE`) and
rebuilt on Node 24.

Changes from upstream:

- `CORS_ORIGIN` accepts a comma-separated list.
- Room ids outside `[A-Za-z0-9_-]{1,64}` are rejected and the socket dropped.
- `MAX_CLIENTS_PER_ROOM` (default 20) caps sockets per room.
- Websocket transport only, on `PORT` (8080 in the image).

`GET /` is the health endpoint. Build and run with `room/Dockerfile`; the fork's
`images` workflow builds and pins it.
