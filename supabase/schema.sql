-- Poseidon Planning Poker: esquema do banco (Supabase / Postgres)
-- Cole este arquivo inteiro no SQL Editor do Supabase e clique em Run.

create table if not exists public.rooms (
  code             text primary key check (code ~ '^[A-Z0-9-]{3,32}$'),
  name             text not null check (char_length(name) between 1 and 40),
  host_id          uuid not null,
  auto_reveal      boolean not null default false,
  backlog          jsonb not null default '[]'::jsonb,
  active_id        text,
  revealed         boolean not null default false,
  round            integer not null default 1,
  round_started_at bigint not null,
  revealed_at      bigint,
  created_at       timestamptz not null default now()
);

create table if not exists public.members (
  room_code text not null references public.rooms(code) on delete cascade,
  user_id   uuid not null,
  name      text not null check (char_length(name) between 1 and 30),
  role      text not null check (role in ('participant', 'observer')),
  joined_at bigint not null,
  voted     boolean not null default false,
  round     integer not null default 0,
  primary key (room_code, user_id)
);

create table if not exists public.votes (
  room_code text not null references public.rooms(code) on delete cascade,
  user_id   uuid not null,
  round     integer not null,
  story_id  text not null,
  value     numeric(6,1) not null check (value >= 0.5 and value <= 999),
  primary key (room_code, user_id)
);

alter table public.rooms   enable row level security;
alter table public.members enable row level security;
alter table public.votes   enable row level security;

-- Salas: qualquer pessoa logada (anônima inclusive) lê; só o facilitador altera.
drop policy if exists rooms_select on public.rooms;
drop policy if exists rooms_insert on public.rooms;
drop policy if exists rooms_update on public.rooms;
create policy rooms_select on public.rooms for select to authenticated using (true);
create policy rooms_insert on public.rooms for insert to authenticated
  with check (host_id = (select auth.uid()));
create policy rooms_update on public.rooms for update to authenticated
  using (host_id = (select auth.uid()))
  with check (host_id = (select auth.uid()));

-- Participantes: cada um cuida da própria linha; o facilitador pode remover.
drop policy if exists members_select on public.members;
drop policy if exists members_insert on public.members;
drop policy if exists members_update on public.members;
drop policy if exists members_delete on public.members;
create policy members_select on public.members for select to authenticated using (true);
create policy members_insert on public.members for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy members_update on public.members for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy members_delete on public.members for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.rooms r
               where r.code = members.room_code and r.host_id = (select auth.uid()))
  );

-- Votos: cada um vê só o próprio voto. Os dos outros só aparecem quando a sala
-- está revelada e o voto é da rodada atual. Não é possível votar depois da revelação.
drop policy if exists votes_select on public.votes;
drop policy if exists votes_insert on public.votes;
drop policy if exists votes_update on public.votes;
drop policy if exists votes_delete on public.votes;
create policy votes_select on public.votes for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.rooms r
               where r.code = votes.room_code and r.revealed and r.round = votes.round)
  );
create policy votes_insert on public.votes for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.rooms r
                where r.code = votes.room_code and not r.revealed and r.round = votes.round)
  );
create policy votes_update on public.votes for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.rooms r
                where r.code = votes.room_code and not r.revealed and r.round = votes.round)
  );
create policy votes_delete on public.votes for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.rooms r
               where r.code = votes.room_code and r.host_id = (select auth.uid()))
  );

-- Tempo real
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.members;
alter publication supabase_realtime add table public.votes;
