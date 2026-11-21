# redx-test-bot

Isolated diagnostic bot for the RedxBaileys fork (`github:AbdulRehman19721986/RedxBaileys`).
The main bot (`Whatsappmdkhanbot`) is untouched.

It pairs with `PAIR_NUMBER` using the fork's default `androidPhone` identity,
logs every incoming media arrival with its `mediaKey` length, tries to
download it, and sends recovered image/video back to the same chat.

Env:
- `PAIR_NUMBER` — number to pair (digits only, with country code)
- `AUTH_DIR` — auth state dir (default `./auth`; point at a volume on Railway)
