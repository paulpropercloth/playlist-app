# Playlist
Kustomer "Hit Me" app for Proper Cloth CX.
- `worker/` Cloudflare Worker `playlist-backend` (KV binding `KV` = playlist-data)
- `site/` Pages project `playlist-app`: `index.html` (manager panel), `widget.html` (agent widget)
Push to `main` deploys both. `KUSTOMER_API_KEY` lives only in Cloudflare Worker secrets.
