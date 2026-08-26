create table if not exists public.pokemon_local_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

grant select on public.pokemon_local_state to anon, authenticated;
grant all on public.pokemon_local_state to service_role;

alter table public.pokemon_local_state enable row level security;
drop policy if exists "Public can view Pokemon local state" on public.pokemon_local_state;
create policy "Public can view Pokemon local state"
on public.pokemon_local_state for select to anon, authenticated using (true);

create or replace function public.ingest_pokemon_local_state(p_secret text, p_state jsonb)
returns timestamptz
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  expected_hash text;
  ts timestamptz := now();
begin
  select secret_hash into expected_hash
  from public.pokemon_fast_ingest_config
  where id = true;

  if expected_hash is null or encode(digest(coalesce(p_secret,''), 'sha256'), 'hex') <> expected_hash then
    raise exception 'unauthorized';
  end if;

  insert into public.pokemon_local_state(id, state, updated_at)
  values ('current', p_state, ts)
  on conflict (id) do update
    set state = excluded.state,
        updated_at = excluded.updated_at;
  return ts;
end;
$$;

grant execute on function public.ingest_pokemon_local_state(text, jsonb) to anon, authenticated;
