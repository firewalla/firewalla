# captive portal page server

Login page server for Firewalla AP captive portal SSIDs (proj-ap#905). Runs on the box; no
dependencies beyond the box's node (12+). The box's CaptivePortalPlugin runs it while any SSID
profile has `captivePortal`, and redirects the HTTP of guests that have not logged in to it.

This copy is the built-in test version. A `server.js` in `/home/pi/.firewalla/run/captive-portal/`
(a replacement, later a published asset) runs instead.

- Any GET returns `pages/login.html`; `POST /ok` finds the guest's MAC (`ip neigh`) and calls fwapc
  `POST /v1/captive/authorized {mac}`. fwapc finds the station's captive SSID profile, stores the
  login, and the box stops intercepting the MAC.
- `/success` is the page opened after the login countdown (iOS shows Done); `/logo` serves the logo.

A replacement `server.js` gets the env `PORT`, `FWAPC_URL` and `USER_DIR`, must listen on `PORT` on
all addresses (guests reach it on the box's LAN address), and must answer `GET /` on
`127.0.0.1:PORT` with a complete 2xx/3xx response within 3 seconds, or the box restarts it.

Config: `config.json` here, overridden by `config.json` in `USER_DIR` (the plugin passes
`/home/pi/.firewalla/config/captive-portal`, kept across updates). Both are read on every request,
so page text applies without a restart:
- `port` (8890), `fwapc` (`http://127.0.0.1:8841`): the env `PORT` and `FWAPC_URL` the box passes win.
- `successUrl`, `successSeconds`: where and when the page goes after a login.
- `page`: `title`, `heading`, `text`, `button`, and `logo` (an image file in `USER_DIR` or `pages/`).

Pages: `pages/layout.html` wraps `login.html`, `done.html` and `error.html`; `success.html` is
sent as is.
