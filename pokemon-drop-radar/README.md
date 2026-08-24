# Pokémon Drop Radar

Mobile dashboard for the private Pokémon stock watcher.

The public dashboard contains **no notification topic, dashboard state key, retailer account credentials, or checkout automation**. The private keys are entered in the browser once and stored only in localStorage on that device.

Development/static launch URL:

`https://raw.githack.com/shawnmccort/usfcph-week2/pokemon-dashboard/pokemon-drop-radar/index.html`

Setup:
1. Open the dashboard URL.
2. Enter the private dashboard state key supplied separately.
3. Optionally enter the private ntfy alert topic.
4. Save & connect.
5. The page refreshes live state every 60 seconds; the backend normally checks every 5 minutes.

The watcher only alerts for verified actionable first-party offers within the configured price ceiling. Blocked or ambiguous retailer responses fail closed and do not alert.
