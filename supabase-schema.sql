create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.meals (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  type text not null,
  name text not null,
  calories numeric not null default 0,
  protein numeric not null default 0,
  fat numeric not null default 0,
  carbs numeric not null default 0,
  note text not null default '',
  photo_path text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.weights (
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  value numeric not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.profiles enable row level security;
alter table public.meals enable row level security;
alter table public.weights enable row level security;

drop policy if exists "profiles owner access" on public.profiles;
create policy "profiles owner access"
on public.profiles
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "meals owner access" on public.meals;
create policy "meals owner access"
on public.meals
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "weights owner access" on public.weights;
create policy "weights owner access"
on public.weights
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('meal-photos', 'meal-photos', false)
on conflict (id) do nothing;

drop policy if exists "meal photo owner read" on storage.objects;
create policy "meal photo owner read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'meal-photos'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists "meal photo owner insert" on storage.objects;
create policy "meal photo owner insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'meal-photos'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists "meal photo owner update" on storage.objects;
create policy "meal photo owner update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'meal-photos'
  and auth.uid()::text = (storage.foldername(name))[1]
)
with check (
  bucket_id = 'meal-photos'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists "meal photo owner delete" on storage.objects;
create policy "meal photo owner delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'meal-photos'
  and auth.uid()::text = (storage.foldername(name))[1]
);
