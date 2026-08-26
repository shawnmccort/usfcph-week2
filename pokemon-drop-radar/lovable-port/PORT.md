# Port local restock UI into Pokémon Drop Alert

Backend prerequisites are already implemented in the existing Supabase project:
- `public.pokemon_local_state`
- read-only RLS policy for anon/authenticated clients
- `public.ingest_pokemon_local_state(p_secret text, p_state jsonb)` secured by the existing `pokemon_fast_ingest_config.secret_hash`

## Files to add
1. Copy `src/lib/local-state.ts` to the Lovable app at `src/lib/local-state.ts`.
2. Copy `src/components/local-restock-panel.tsx` to the Lovable app at `src/components/local-restock-panel.tsx`.

## Existing route change
In `src/routes/index.tsx`, add:

```tsx
import { LocalRestockPanel } from "@/components/local-restock-panel";
```

Then render this inside the main dashboard, ideally immediately before the existing product search/filter section:

```tsx
<LocalRestockPanel />
```

No Supabase generated-type change is required because `local-state.ts` uses the read-only REST endpoint directly with the existing Vite Supabase environment variables.

## Behavior
- Refreshes local state every 30 seconds while the page is open.
- Marks the feed stale after 10 minutes.
- Shows provider coverage explicitly so Manual-only never looks like Out of stock.
- Sorts confirmed hits by distance.
- Includes Best Buy Developer API attribution when Best Buy API data is enabled.
